"""Sundark use cases, independent of any transport.

`app/main.py` (HTTP) is one adapter over these functions; any other adapter calls them the
same way. Nothing here knows about FastAPI, requests or responses: a missing paper raises
`NotFoundError`, a request that cannot be served as given raises `InvalidRequestError`, and AI
failures raise `AIError`/`RateLimitError`; the adapter maps each to its own status codes.
"""

from __future__ import annotations

import asyncio
import datetime
import hashlib
import io
import json
import logging
import os
import re
import tempfile
import zipfile
from collections.abc import AsyncIterator
from pathlib import Path

from . import ai, biblio, paper_id, pdf_utils, settings, store, zotero
from .errors import AIError, RateLimitError

ROOT = Path(__file__).resolve().parent.parent

# Folder the app scans for papers. Drop PDFs here (or set PAPERS_DIR to another path).
PAPERS_DIR = Path(os.environ.get("PAPERS_DIR", ROOT / "papers")).resolve()
PAPERS_DIR.mkdir(parents=True, exist_ok=True)


class NotFoundError(Exception):
    """The paper, file or path a request names does not exist."""


class InvalidRequestError(Exception):
    """The request cannot be served as given (bad path, page, language or PDF)."""


def output_language(value: str | None = None) -> str:
    try:
        return settings.output_language(value)
    except ValueError as exc:
        raise InvalidRequestError(str(exc)) from exc


def _require_doc(doc_id: str) -> dict:
    doc = store.load_doc(doc_id)
    if doc is None:
        raise NotFoundError("Unknown doc_id — upload the PDF again")
    return doc


def _require_page(doc: dict, page: int) -> None:
    if not (0 <= page < doc["meta"]["num_pages"]):
        raise InvalidRequestError("page out of range")


# --- Ingest and identity --------------------------------------------------------------------


async def _ingest(data: bytes, zotero: dict | None = None) -> dict:
    """Store + extract a PDF (idempotent by content hash), then identify its Paper.
    Returns summary meta. `zotero` = {"key", "doi"} when opened from Zotero."""
    doc_id = store.doc_id_for(data)
    extracted = store.load_doc(doc_id)
    if extracted is None:
        extracted = pdf_utils.extract(
            data
        )  # may raise; callers report an unreadable PDF
        store.save_pdf(doc_id, data)
        store.save_doc(doc_id, extracted)
    elif extracted["meta"].get("text_version", 1) < pdf_utils.TEXT_VERSION:
        # Re-extract text a previous version got wrong (e.g. MathPi "~1!"), keeping identity.
        fresh = pdf_utils.extract(data)
        fresh["meta"]["paper_id"] = extracted["meta"].get("paper_id")
        if fresh["meta"]["paper_id"] is None:
            del fresh["meta"]["paper_id"]
        extracted = fresh
        store.save_doc(doc_id, extracted)
    pid = extracted["meta"].get("paper_id")
    unresolved = (
        pid and pid.split(":")[0] in ("doi", "arxiv") and store.paper_get(pid) is None
    )
    if pid is None or zotero or unresolved:
        pid = await _identify(doc_id, data, extracted, zotero or {})
    record = store.paper_get(pid)
    return {
        "doc_id": doc_id,
        "paper_id": pid,
        "title": biblio.plain_title((record or {}).get("title") or "")
        or extracted["meta"]["title"],
        "byline": biblio.byline(record),
        "num_pages": extracted["meta"]["num_pages"],
    }


async def _identify(doc_id: str, data: bytes, extracted: dict, zotero: dict) -> str:
    """Pick the Paper ID (ADR 0001) and fetch its Bibliographic Record when possible.

    Candidates in priority order: Zotero's DOI (trusted), the PDF's DOI, the PDF's arXiv ID.
    A candidate whose record title is not on the first page names another work (e.g. a
    citation), so the next candidate is tried; this check also runs on cached records.
    Without a record (offline, unknown ID) the candidate is kept and re-checked next open."""
    found = paper_id.identifiers(data)
    first_page = extracted["pages"][0] if extracted["pages"] else ""
    candidates = []
    if zotero.get("doi"):
        candidates.append(
            (paper_id.paper_id(fingerprint=doc_id, doi=zotero["doi"]), True)
        )
    if found["doi"]:
        candidates.append(
            (paper_id.paper_id(fingerprint=doc_id, doi=found["doi"]), False)
        )
    if found["arxiv"]:
        candidates.append(
            (paper_id.paper_id(fingerprint=doc_id, arxiv=found["arxiv"]), False)
        )
    pid = paper_id.paper_id(fingerprint=doc_id, zotero_key=zotero.get("key"))
    for candidate, trusted in candidates:
        cached = store.paper_get(candidate)
        record = cached or await biblio.lookup(candidate)
        if record is None:
            pid = candidate
            break
        if trusted or biblio.title_matches(record["title"], first_page):
            if cached is None:
                store.paper_put(candidate, record)
            pid = candidate
            break
    previous = extracted["meta"].get("paper_id") or f"file:{doc_id}"
    extracted["meta"]["paper_id"] = pid
    store.save_doc(doc_id, extracted)
    store.chat_migrate(doc_id, pid)
    store.chat_move(previous, pid)
    return pid


def _paper_of(doc_id: str, doc: dict) -> str:
    """Paper ID for a stored doc; docs ingested before Paper IDs use their fingerprint."""
    pid = doc["meta"].get("paper_id") or f"file:{doc_id}"
    store.chat_migrate(doc_id, pid)
    return pid


async def _ingest_readable(data: bytes | Path, zotero: dict | None = None) -> dict:
    try:
        if isinstance(data, Path):
            data = data.read_bytes()
        return await _ingest(data, zotero)
    except Exception as e:
        raise InvalidRequestError(f"Could not read PDF: {e}") from e


_TITLES_FILE = store.DATA / "titles.json"
try:
    _titles: dict[str, dict] = json.loads(_TITLES_FILE.read_text("utf-8"))
except Exception:  # noqa: BLE001
    _titles = {}


def _paper_title(path: Path, rel: str) -> str:
    """Library title: a Bibliographic Record only for papers already opened (their Paper ID
    was validated then); otherwise the title read from the PDF. Never calls the network."""
    st = path.stat()
    key = f"{rel}:{int(st.st_mtime)}:{st.st_size}"
    entry = _titles.get(key)
    # missing, older format, or read by an older title_of() (pdf_utils.TEXT_VERSION)
    if not (
        isinstance(entry, dict)
        and "doc_id" in entry
        and entry.get("text_version") == pdf_utils.TEXT_VERSION
    ):
        try:
            data = path.read_bytes()
            entry = {
                "title": pdf_utils.title_of(data),
                "doc_id": store.doc_id_for(data),
                "text_version": pdf_utils.TEXT_VERSION,
            }
        except Exception:  # noqa: BLE001
            entry = {
                "title": "",
                "doc_id": None,
                "text_version": pdf_utils.TEXT_VERSION,
            }
        _titles[key] = entry
        try:
            _TITLES_FILE.write_text(json.dumps(_titles, ensure_ascii=False), "utf-8")
        except OSError:
            pass  # non-fatal: title cache is best-effort
    doc = store.load_doc(entry["doc_id"]) if entry["doc_id"] else None
    pid = (doc or {}).get("meta", {}).get("paper_id")
    record = store.paper_get(pid) if pid else None
    return biblio.plain_title((record or {}).get("title") or "") or entry["title"]


def list_papers() -> dict:
    """List PDF files in the papers folder, newest first, titled when possible."""
    items = []
    for p in PAPERS_DIR.rglob("*.pdf"):
        if not p.is_file():
            continue
        st = p.stat()
        items.append(
            {
                "rel": str(p.relative_to(PAPERS_DIR)),
                "name": _paper_title(p, str(p.relative_to(PAPERS_DIR))) or p.stem,
                "file": p.name,
                "size": st.st_size,
                "mtime": st.st_mtime,
            }
        )
    items.sort(key=lambda x: x["mtime"], reverse=True)
    return {"dir": str(PAPERS_DIR), "papers": items}


async def open_folder_paper(rel: str) -> dict:
    """Open a paper from the papers folder by its relative path."""
    path = (PAPERS_DIR / rel).resolve()
    if not path.is_relative_to(PAPERS_DIR):
        raise InvalidRequestError("Invalid path")
    if not path.is_file() or path.suffix.lower() != ".pdf":
        raise NotFoundError("Paper not found")
    return schedule_prewarm(await _ingest_readable(path))


async def open_zotero_paper(item: str, attachment: str) -> dict:
    """Open a Zotero PDF where it is (no copy into papers/); Zotero's DOI and item key feed
    the Paper ID (ADR 0001). A down Zotero raises `zotero.ZoteroError`."""
    path = await asyncio.to_thread(zotero.pdf_path, attachment)
    doi = await asyncio.to_thread(zotero.item_doi, item)
    if not path.is_file() or path.suffix.lower() != ".pdf":
        raise NotFoundError("The PDF file for this Zotero item was not found")
    return schedule_prewarm(await _ingest_readable(path, {"key": item, "doi": doi}))


def _save_to_library(filename: str, data: bytes) -> None:
    """Also keep an uploaded PDF in the papers folder so it shows up in the Library and can be
    reopened later. Best-effort: a failure here must not fail the upload (the doc is already
    ingested and opens from data/). The name is reduced to a basename, so no path can escape
    PAPERS_DIR. The reader and the MCP server are separate processes, so a name is claimed by
    hard-linking a fully written temporary file: the link fails if the name exists, and a
    reader never sees a half-written PDF."""
    name = Path(filename or "upload.pdf").name
    if not name.lower().endswith(".pdf"):
        name += ".pdf"
    dest = PAPERS_DIR / name
    tmp = None
    try:
        fd, tmp = tempfile.mkstemp(prefix=".upload-", suffix=".part", dir=PAPERS_DIR)
        with os.fdopen(fd, "wb") as f:
            f.write(data)
        stem, suffix = dest.stem, dest.suffix
        i = 1
        while True:
            try:
                os.link(tmp, dest)
                break
            except FileExistsError:
                if dest.read_bytes() == data:
                    break
            dest = (
                PAPERS_DIR / f"{stem}-{i}{suffix}"
            )  # keep a same-named, different file
            i += 1
    except OSError:
        pass
    finally:
        if tmp is not None:
            Path(tmp).unlink(missing_ok=True)


async def upload_paper(filename: str, data: bytes) -> dict:
    if not (filename or "").lower().endswith(".pdf"):
        raise InvalidRequestError("Please upload a .pdf file")
    if not data:
        raise InvalidRequestError("Empty file")
    meta = await _ingest_readable(data)
    _save_to_library(filename, data)
    return schedule_prewarm(meta)


def pdf_path(doc_id: str) -> Path:
    path = store.pdf_path(doc_id)
    if not path.is_file():
        raise NotFoundError("Unknown doc_id")
    return path


# --- Layout and math ------------------------------------------------------------------------

# Layout (which now runs the YOLO model) is heavy and synchronous. Run it one page at a time
# so the CPU is not thrashed by parallel inference, and always off the event loop (via a
# thread) so one page's layout never blocks the server from serving the PDF or other requests.
_layout_lock = asyncio.Lock()


# Bump when layout() changes what it emits, so cached pages from an older parser are bypassed
# instead of silently reused. The translation cache keys on a segment signature, so it follows
# automatically; only the layout cache needs this tag. (v2: pure-YOLO region typing. v3:
# cross-page stitch skips figure/table caption blocks. v4: merge lowercase-starting over-split
# fragments from spaced inline math. A hybrid-heading attempt was tried and reverted — it hurt
# precision on the .tex eval — so heading detection stays pure title-box. v5: strip C0/DEL control
# characters (PDF math bracket delimiters) from word tokens. v6: rejoin same-baseline line
# fragments the PDF split around inline math. v7: also rejoin a raised/lowered glyph fragment
# such as a radical, and measure line gaps on median glyph extents. v8: decode the AIP/APS
# MathPi font, whose text layer reads "~1!" for "(1)". v9: split enumerated list items ("a)",
# "(1)") into their own sentences; rejoin fragments the segmenter broke mid-sentence (inline
# math, a citation, a bracket or parenthesis, closing punctuation, inside a word); keep short
# prose by paragraph context; stitch page breaks before a citation or inside a hyphenated word,
# skipping caption sentences. v10: word boxes from the glyphs' own positions instead of a split
# of the span by character count; CMEX10 symbols decoded; a side-margin word dropped only with
# its whole line; a fragment ending on a math operator, or opening with a stacked subscript,
# rejoins its sentence; a sentence with inline scripts carries a ^{...}/_{...} marked `tex`;
# end matter compared in column-aware reading order; a drop box over part of a line decides
# the whole line by its first word; the lines of one title box are one heading; a later
# paragraph that only repeats page 0's front matter (an appendix cover) is dropped; footnotes
# are kept, and they and figure/table captions (also one a table box swallowed) come after the
# page's text; running heads match by
# letters; page 0 cuts at a real Abstract heading and keeps a caption above it; only the
# reference list is skipped, from a whole-line References heading to an appendix heading or
# the first page that is not a reference list. v11: attach a lone equation number "(1)"
# to the display equation beside it (as the sentence's "eqno") instead of dropping it as a
# short fragment. v12: page 0 drops a footnote with an e-mail address, the authors' contact
# block. v13: a line under both a furniture box and a body box goes by the more confident
# box.)
_LAYOUT_VERSION = 13


def _page_layout_cached(doc_id: str, page: int) -> dict:
    """Layout for one page (cached). Running headers and the end-matter range are detected
    once per document and cached, then the per-page layout is cached too. Synchronous and
    heavy — call it through `_layout_async`, never directly in a request handler."""
    pdf_path = store.pdf_path(doc_id)
    if not pdf_path.is_file():
        raise NotFoundError("PDF missing")
    cached = store.cache_get(doc_id, f"layout_v{_LAYOUT_VERSION}_{page}")
    if cached:
        return cached
    pdf_bytes = pdf_path.read_bytes()
    # v2: running heads are matched by their letters only (older entries kept digits and marks)
    hc = store.cache_get(doc_id, "headers_v2")
    if hc is None:
        hc = {"set": sorted(pdf_utils.running_headers(pdf_bytes))}
        store.cache_put(doc_id, "headers_v2", hc)
    # v2: the range is the reference list alone, and its positions carry x for column-aware
    # reading order (older entries started at Acknowledgements and lack x)
    sc = store.cache_get(doc_id, "skip_v2")
    if sc is None:
        sc = {"range": pdf_utils.end_matter_range(pdf_bytes, headers=set(hc["set"]))}
        store.cache_put(doc_id, "skip_v2", sc)
    result = pdf_utils.layout(pdf_bytes, page, headers=set(hc["set"]), skip=sc["range"])
    store.cache_put(doc_id, f"layout_v{_LAYOUT_VERSION}_{page}", result)
    return result


async def _layout_async(doc_id: str, page: int) -> dict:
    """Cached fast-path (no lock), else compute one-at-a-time in a worker thread."""
    cached = store.cache_get(doc_id, f"layout_v{_LAYOUT_VERSION}_{page}")
    if cached is not None:
        return cached
    async with _layout_lock:
        cached = store.cache_get(
            doc_id, f"layout_v{_LAYOUT_VERSION}_{page}"
        )  # another task may have filled it
        if cached is not None:
            return cached
        return await asyncio.to_thread(_page_layout_cached, doc_id, page)


# Layout pre-warm progress, so the UI can show a loading bar: doc_id -> pages done; a doc_id
# in _prewarm_done means the whole sweep finished (even if some pages failed).
_prewarm_progress: dict[str, int] = {}
_prewarm_done: set[str] = set()


async def _prewarm_layout(doc_id: str, num_pages: int) -> None:
    """Compute every page's layout from the top, in the background, so scrolling and
    translation hit the cache instead of waiting on the model. Tracks progress for
    `layout_status`."""
    _prewarm_done.discard(doc_id)
    _prewarm_progress[doc_id] = 0
    for p in range(num_pages):
        try:
            await _layout_async(doc_id, p)
        except Exception:  # noqa: BLE001 — best-effort warm-up
            pass
        _prewarm_progress[doc_id] = p + 1
    _prewarm_done.add(doc_id)


def layout_status(doc_id: str) -> dict:
    """Layout pre-warm progress for the loading bar: {done, num_pages, finished}."""
    doc = _require_doc(doc_id)
    n = doc["meta"]["num_pages"]
    return {
        "done": min(_prewarm_progress.get(doc_id, 0), n),
        "num_pages": n,
        "finished": doc_id in _prewarm_done,
    }


_bg_tasks: set = set()  # strong refs so fire-and-forget tasks are not GC'd mid-run


def schedule_prewarm(meta: dict) -> dict:
    task = asyncio.create_task(_prewarm_layout(meta["doc_id"], meta["num_pages"]))
    _bg_tasks.add(task)
    task.add_done_callback(_bg_tasks.discard)
    return meta


async def page_layout(doc_id: str, page: int) -> dict:
    """Word-level geometry + sentence grouping for one page (cached)."""
    _require_page(_require_doc(doc_id), page)
    return await _layout_async(doc_id, page)


async def page_math(doc_id: str, page: int) -> dict:
    """LaTeX for each display equation on a page, read from the rendered crop by a vision call.
    Compiled PDFs scramble 2D math in the text layer, so we transcribe the image instead.
    Returns {"equations": [{"i": segment_index, "latex": "..."}]} (cached per page/model)."""
    _require_page(_require_doc(doc_id), page)
    # Keyed by _LAYOUT_VERSION too: the result stores segment indices, which shift when layout()
    # changes, so an older cache would map equations onto the wrong segments.
    key = f"math_v{_LAYOUT_VERSION}_{ai.cache_tag('equation')}_{page}"
    cached = store.cache_get(doc_id, key)
    if cached:
        # Drop transcriptions cached before latex_ok() existed that KaTeX cannot render.
        cached["equations"] = [
            e for e in cached.get("equations", []) if ai.latex_ok(e.get("latex", ""))
        ]
        return cached
    lay = await _layout_async(doc_id, page)
    pdf_bytes = store.pdf_path(doc_id).read_bytes()
    words = lay["words"]
    out = []
    for i, seg in enumerate(lay["sentences"]):
        if not seg.get("equation") or not seg.get("words"):
            continue
        idxs = seg["words"]
        bbox = (
            min(words[j]["x0"] for j in idxs),
            min(words[j]["y0"] for j in idxs),
            max(words[j]["x1"] for j in idxs),
            max(words[j]["y1"] for j in idxs),
        )
        png = pdf_utils.crop_region_png(pdf_bytes, page, bbox)
        try:
            latex = await ai.equation_latex(png)
        except RateLimitError:
            raise
        except AIError:
            latex = ""  # best-effort: keep the original text if a crop can't be read
        if latex:
            out.append({"i": i, "latex": latex})
    result = {"equations": out}
    store.cache_put(doc_id, key, result)
    return result


# --- Summary and anatomy --------------------------------------------------------------------


def _summary_key(language: str) -> str:
    return f"summary_{language}_{ai.cache_tag('summary')}"


def _anatomy_key(language: str) -> str:
    return f"anatomy_{language}_{ai.cache_tag('anatomy')}"


async def summarize(doc_id: str, language: str | None = None) -> dict:
    language = output_language(language)
    doc = _require_doc(doc_id)
    key = _summary_key(language)
    cached = store.cache_get(doc_id, key)
    if cached:
        return cached
    text = pdf_utils.full_text(doc["pages"])
    summary = await ai.summarize(text, target_lang=language)
    result = {"summary": summary}
    store.cache_put(doc_id, key, result)
    return result


def _verify_card_quotes(card: dict, paper_text: str) -> None:
    """Annotate each point in a card with whether its quote is grounded in the paper."""
    if not isinstance(card, dict):
        return
    for pt in card.get("points", []) or []:
        if isinstance(pt, dict):
            pt["verified"] = ai.verify_quote(pt.get("quote") or "", paper_text)


async def _grounded_anatomy(text: str, language: str) -> dict:
    result = await ai.anatomy(text, target_lang=language)
    # Grounding: flag each point's quote as verified/unverified against the paper text.
    for name in ("problem", "gap", "claim", "method", "limitations"):
        _verify_card_quotes(result.get(name, {}), text)
    for sub in (result.get("evidence") or {}).values():
        _verify_card_quotes(sub, text)
    return result


async def anatomy(
    doc_id: str, language: str | None = None, force: bool = False
) -> dict:
    language = output_language(language)
    doc = _require_doc(doc_id)
    key = _anatomy_key(language)
    if not force:
        cached = store.cache_get(doc_id, key)
        if cached:
            return cached
    result = await _grounded_anatomy(pdf_utils.full_text(doc["pages"]), language)
    store.cache_put(doc_id, key, result)
    return result


# --- Review export -------------------------------------------------------------------------
# A one-click review note: write a review from the paper text, guided by the materials
# already gathered for it (summary + anatomy + chat), crop only the figures the note references,
# and hand back a Hugo page bundle (<slug>/index.md + <slug>/<id>.png) as a zip.

_SLUG_RE = re.compile(r"[^a-z0-9]+")
# Markdown image whose target is one of our figure ids, e.g. ![caption](fig-p3-1.png).
_IMG_REF_RE = re.compile(r"!\[[^\]]*\]\((fig|tbl)-p\d+-\d+\.png\)")
_IMG_ID_RE = re.compile(r"!\[[^\]]*\]\(((?:fig|tbl)-p\d+-\d+)\.png\)")
# Math delimiters the review prompt asks for: $$...$$ display, \(...\) inline.
_TEX_RE = re.compile(r"\$\$|\\\(")


def _slug(title: str, fallback: str) -> str:
    """ASCII kebab-case slug for the bundle folder; `fallback` (the doc id) when nothing is left
    (e.g. a title with no ASCII letters)."""
    s = _SLUG_RE.sub("-", (title or "").lower()).strip("-")
    return s or fallback


def _referenced_ids(body: str) -> list[str]:
    """Figure ids the review body actually links to, in first-seen order."""
    seen: list[str] = []
    for m in _IMG_ID_RE.finditer(body):
        if m.group(1) not in seen:
            seen.append(m.group(1))
    return seen


def _yaml_value(v) -> str:
    """Serialize a frontmatter scalar/list as YAML. JSON flow syntax is valid YAML, so quoting
    strings and lists through json keeps them safe without a YAML dependency."""
    if v is None:
        return ""
    if isinstance(v, bool):
        return "true" if v else "false"
    if isinstance(v, int):
        return str(v)
    if isinstance(v, list):
        return "[" + ", ".join(json.dumps(str(x), ensure_ascii=False) for x in v) + "]"
    return json.dumps(str(v), ensure_ascii=False)


def _frontmatter(rv: dict, *, date: str, has_math: bool) -> str:
    """Hugo frontmatter block. `date`, `draft`, `math`, `arxiv`, `link` are set deterministically;
    the rest come from the model's review object."""
    fields = [
        ("title", rv.get("title") or rv.get("paper_title") or "Untitled"),
        ("date", date),
        ("draft", True),
        ("paper_title", rv.get("paper_title") or ""),
        ("authors", rv.get("authors") or []),
        ("venue", rv.get("venue") or ""),
        ("year", rv.get("year") if isinstance(rv.get("year"), int) else None),
        ("arxiv", ""),
        ("link", ""),
        ("tags", rv.get("tags") or []),
        ("summary", rv.get("summary") or ""),
        ("math", has_math),
    ]
    lines = ["---"]
    for k, v in fields:
        # `date` is an unquoted RFC3339 timestamp, not a YAML-quoted string.
        lines.append(f"date: {date}" if k == "date" else f"{k}: {_yaml_value(v)}")
    lines.append("---")
    return "\n".join(lines) + "\n"


async def review_bundle(doc_id: str, language: str | None = None) -> tuple[str, bytes]:
    """Generate the review note as a zipped Hugo page bundle; returns (slug, zip bytes)."""
    language = output_language(language)
    doc = _require_doc(doc_id)
    pages = doc["pages"]
    text = pdf_utils.full_text(pages)

    # Materials: summary and anatomy are generated (and cached) on demand if not present yet.
    # A single material failing (e.g. anatomy returns unparseable JSON) must not sink the whole
    # export — the review can still be written from the rest. A rate limit still propagates.
    skey = _summary_key(language)
    summ = store.cache_get(doc_id, skey)
    if summ is None:
        try:
            summ = {"summary": await ai.summarize(text, target_lang=language)}
            store.cache_put(doc_id, skey, summ)
        except RateLimitError:
            raise
        except AIError:
            summ = {"summary": ""}

    akey = _anatomy_key(language)
    anat = store.cache_get(doc_id, akey)
    if anat is None:
        try:
            anat = await _grounded_anatomy(text, language)
            store.cache_put(doc_id, akey, anat)
        except RateLimitError:
            raise
        except AIError:
            anat = {}

    chat_turns = store.chat_get(_paper_of(doc_id, doc))
    glossary = await _get_brief(doc_id, doc, language)

    # Figures + display-math presence (heavy: the layout model runs on every page).
    pdf_bytes = store.pdf_path(doc_id).read_bytes()
    assets = await asyncio.to_thread(pdf_utils.figure_catalog, pdf_bytes)
    figures = assets["figures"]

    rv = await ai.review(
        summary=summ.get("summary", ""),
        anatomy_obj=anat,
        chat_turns=chat_turns,
        figures=[{"id": f["id"], "caption": f["caption"]} for f in figures],
        paper_text=text,
        glossary=glossary,
        target_lang=language,
    )
    body = rv.get("body", "")

    # Crop only the figures the note links to; drop a link whose crop fails or whose id is unknown
    # so the note never carries a broken image.
    by_id = {f["id"]: f for f in figures}
    crops: dict[str, bytes] = {}
    for fid in _referenced_ids(body):
        f = by_id.get(fid)
        if f is None:
            continue
        try:
            crops[fid] = await asyncio.to_thread(
                pdf_utils.crop_region_png, pdf_bytes, f["page"], f["bbox"]
            )
        except Exception:  # noqa: BLE001 — skip an unreadable crop, keep the note
            pass
    body = _IMG_REF_RE.sub(
        lambda m: m.group(0) if _IMG_ID_RE.match(m.group(0)).group(1) in crops else "",
        body,
    )

    date = datetime.datetime.now(
        datetime.timezone(datetime.timedelta(hours=9))
    ).strftime("%Y-%m-%dT%H:%M:%S+09:00")
    # The note may carry its own equations even when the paper has no display math.
    has_math = assets["has_math"] or bool(_TEX_RE.search(body))
    index_md = (
        _frontmatter(rv, date=date, has_math=has_math) + "\n" + body.strip() + "\n"
    )
    slug = _slug(rv.get("title") or doc["meta"].get("title", ""), doc_id)

    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr(f"{slug}/index.md", index_md)
        for fid, png in crops.items():
            z.writestr(f"{slug}/{fid}.png", png)
    return slug, buf.getvalue()


# --- Translation ----------------------------------------------------------------------------


def _translation_key(language: str, page: int, segs: list[str]) -> str:
    # Cache key includes a signature of the exact segments, so a change in how the
    # page is split (different count/content) never returns a mismatched cached result.
    sig = hashlib.sha1("\x1f".join(segs).encode("utf-8")).hexdigest()[:10]
    return f"tr_{language}_{ai.cache_tag('translate')}_{page}_{sig}"


async def translate(
    doc_id: str,
    page: int,
    language: str | None = None,
    segments: list[str] | None = None,
) -> dict:
    language = output_language(language)
    doc = _require_doc(doc_id)
    pages = doc["pages"]
    if not (0 <= page < len(pages)):
        raise InvalidRequestError("page out of range")

    if segments:
        segs = [s for s in segments if s.strip()]
    else:
        segs = pdf_utils.segment(pages[page].strip())

    key = _translation_key(language, page, segs)
    cached = store.cache_get(doc_id, key)
    if cached:
        return cached

    if not segs:
        result = {"segments": [], "translation": ""}
        store.cache_put(doc_id, key, result)
        return result

    source = "\n\n".join(segs)
    brief = await _get_brief(doc_id, doc, language)
    tr = await ai.translate_segments(segs, language, brief=brief)
    if tr is None:
        # Alignment failed — fall back to one whole-page translation.
        whole = await ai.translate(source, language)
        result = {"segments": [{"src": source, "tr": whole}], "translation": whole}
    else:
        pairs = [{"src": s, "tr": t} for s, t in zip(segs, tr)]
        result = {"segments": pairs, "translation": "\n\n".join(tr)}
    store.cache_put(doc_id, key, result)
    return result


async def _retranslate(src: str, target_lang: str) -> str:
    """One more single-sentence attempt for a sentence the model left mostly untranslated.
    Returns the new translation, or "" if it failed or is still untranslated."""
    try:
        again = (await ai.translate(src, target_lang)).strip()
    except RateLimitError:
        raise
    except AIError:
        return ""
    return again if again and not ai.untranslated(src, again, target_lang) else ""


def translate_stream(
    doc_id: str,
    page: int,
    language: str | None = None,
    segments: list[str] | None = None,
    force: bool = False,
) -> AsyncIterator[dict]:
    """Progressive translation: validates the request now, then returns an async iterator of
    events, one {"i": k, "tr": "..."} per segment as the model produces it, or a final
    {"error": ..., "rate_limited": ...} when the batch fails."""
    language = output_language(language)
    doc = _require_doc(doc_id)
    pages = doc["pages"]
    if not (0 <= page < len(pages)):
        raise InvalidRequestError("page out of range")

    # Keep client-supplied segments 1:1 (do NOT drop blank ones): the client numbers results by
    # position within the batch it sent, so filtering here would shift every later index and
    # mis-map the translation and its highlight. Only fall back to splitting the page ourselves
    # when the client sent nothing.
    segs = list(segments) if segments else pdf_utils.segment(pages[page].strip())
    key = _translation_key(language, page, segs)

    async def gen():
        if not force:
            cached = store.cache_get(doc_id, key)
            if cached:
                changed = False
                for k, seg in enumerate(cached["segments"]):
                    # Cached before the untranslated() check existed: fix it once, then
                    # mark it so a sentence that stays English is not retried every open.
                    if not seg.get("checked") and ai.untranslated(
                        seg["src"], seg["tr"], language
                    ):
                        try:
                            better = await _retranslate(seg["src"], language)
                        except RateLimitError as exc:
                            yield {"error": str(exc), "rate_limited": True}
                            return
                        else:
                            seg["checked"], changed = True, True
                        if better:
                            seg["tr"] = better
                    yield {"i": k, "tr": seg["tr"]}
                if changed:
                    cached["translation"] = "\n\n".join(
                        x["tr"] for x in cached["segments"]
                    )
                    store.cache_put(doc_id, key, cached)
                return
        if not segs:
            store.cache_put(doc_id, key, {"segments": [], "translation": ""})
            return
        # translate_stream yields translations strictly in order and raises AIError if the model
        # drifts (out-of-order / wrong count), so we number them by arrival — never by the model's
        # printed index — and a misaligned stream errors out instead of being shown or cached. On
        # an AIError the client retries the batch and finally falls back to source text.
        collected: list[str] = []
        held: list[int] = []  # sentences the model left mostly untranslated
        try:
            brief = await _get_brief(doc_id, doc, language)
            chunks = ai.translate_stream(segs, language, brief=brief)
            try:
                async for tr in chunks:
                    k = len(collected)
                    collected.append(tr)
                    if ai.untranslated(segs[k], tr, language):
                        held.append(k)  # shown after a second, single-sentence attempt
                        continue
                    yield {"i": k, "tr": tr}
            finally:
                await chunks.aclose()
            for k in held:
                collected[k] = await _retranslate(segs[k], language) or collected[k]
                yield {"i": k, "tr": collected[k]}
        except AIError as exc:
            logging.getLogger(__name__).warning(
                "Translation batch failed: page=%s kind=%s reason=%s",
                page + 1,
                type(exc).__name__,
                str(exc),
            )
            yield {"error": str(exc), "rate_limited": isinstance(exc, RateLimitError)}
            return
        # Reaching here means the stream completed in order with exactly one line per segment, so
        # the cache is always complete and aligned.
        pairs = [{"src": segs[k], "tr": collected[k]} for k in range(len(segs))]
        store.cache_put(
            doc_id,
            key,
            {"segments": pairs, "translation": "\n\n".join(collected)},
        )

    return gen()


# --- Explain, chat and glossary -------------------------------------------------------------


async def explain(doc_id: str, text: str, language: str | None = None) -> str:
    language = output_language(language)
    _require_doc(doc_id)
    text = text.strip()
    if not text:
        raise InvalidRequestError("No text selected")
    return await ai.explain(text[:4000], target_lang=language)


async def chat(doc_id: str, question: str, language: str | None = None) -> str:
    """Answer using a snapshot and append the exchange in completion order.

    Reset during inference rejects the stale exchange with InvalidRequestError.
    No storage lock is held while waiting for the AI backend.
    """
    language = output_language(language)
    doc = _require_doc(doc_id)
    pid = await asyncio.to_thread(_paper_of, doc_id, doc)
    history, generation = await asyncio.to_thread(store.chat_snapshot, pid)
    answer = await ai.chat(
        question,
        paper_text=pdf_utils.full_text(doc["pages"]),
        history=history,
        target_lang=language,
    )
    appended = await asyncio.to_thread(
        store.chat_append,
        pid,
        [
            {"role": "user", "text": question},
            {"role": "assistant", "text": answer},
        ],
        generation,
    )
    if not appended:
        raise InvalidRequestError("Chat history changed; please ask again")
    return answer


def chat_history(doc_id: str) -> list[dict]:
    return store.chat_get(_paper_of(doc_id, _require_doc(doc_id)))


def chat_reset(doc_id: str) -> None:
    store.chat_clear(_paper_of(doc_id, _require_doc(doc_id)))


async def _get_brief(doc_id: str, doc: dict, target_lang: str) -> str:
    """Per-paper translation glossary, generated once (cheap model) from the front matter and
    cached, then injected into every page's translation for cross-page term consistency.
    Best-effort: if generation fails, translation proceeds without it."""
    key = f"brief_{target_lang}_{ai.cache_tag('brief')}"
    pid = doc["meta"].get("paper_id") or f"file:{doc_id}"
    cache_id = store.paper_cache_id(pid)
    cached = store.cache_get(cache_id, key)
    if cached is not None:
        return cached.get("brief", "")
    try:
        src = pdf_utils.brief_source(doc["pages"])
        brief = await ai.translate_brief(src, target_lang)
    except RateLimitError:
        raise
    except Exception:  # noqa: BLE001
        return ""  # non-fatal: a missing glossary just means no extra consistency hint
    store.cache_put(cache_id, key, {"brief": brief})
    return brief


async def brief(doc_id: str, language: str | None = None) -> str:
    """Warm (or return) the cached translation glossary for a paper."""
    language = output_language(language)
    return await _get_brief(doc_id, _require_doc(doc_id), language)
