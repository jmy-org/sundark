"""PDF text extraction using PyMuPDF."""

from __future__ import annotations

import contextlib
import functools
import re
import statistics

import pymupdf

from . import layout_model


def extract(pdf_bytes: bytes) -> dict:
    """Extract per-page text and basic metadata from a PDF.

    Returns a dict: {"pages": [str, ...], "meta": {"title": str, "num_pages": int}}.
    """
    doc = pymupdf.open(stream=pdf_bytes, filetype="pdf")
    try:
        pages = [_page_text(page) for page in doc]
        title = _title_from_fonts(doc[0]) if doc.page_count else ""
        if not title:
            meta = doc.metadata or {}
            title = (meta.get("title") or "").strip()
        return {
            "pages": pages,
            "meta": {
                "title": title or "Untitled paper",
                "num_pages": len(pages),
                "text_version": TEXT_VERSION,
            },
        }
    finally:
        doc.close()


def title_of(pdf_bytes: bytes) -> str:
    """Title of a PDF (for library listings), using the first page's largest font."""
    doc = pymupdf.open(stream=pdf_bytes, filetype="pdf")
    try:
        return _title_from_fonts(doc[0]) if doc.page_count else ""
    finally:
        doc.close()


def _title_from_fonts(page) -> str:
    """Extract the title as the largest-font text line(s) in the top of page 1.

    This gives properly spaced text (e.g. 'Diffusion Policy: Visuomotor Policy
    Learning via Action Diffusion') instead of the space-stripped metadata title.
    A line's size is the size most of its characters are set in: a math symbol set larger
    than the rest of its line, taken as the line's size, left out the title's next line.
    Lines on one row are read left to right (a small-caps title comes word by word, a short
    word a hair lower than its neighbours).
    """
    try:
        d = page.get_text("dict")
    except Exception:  # noqa: BLE001
        return ""
    limit_y = page.rect.height * 0.5
    lines = []  # (size, bbox, text)
    for block in d.get("blocks", []):
        for line in block.get("lines", []):
            spans = line.get("spans", [])
            text = "".join(s.get("text", "") for s in spans).strip()
            box = line.get("bbox", [0, 0, 0, 0])
            if not text or box[1] > limit_y:
                continue
            if text.lower().startswith(("arxiv:", "doi:")):
                continue
            chars: dict[float, int] = {}
            for s in spans:
                size = s.get("size", 0)
                chars[size] = chars.get(size, 0) + len(s.get("text", "").strip())
            size = max(chars, key=lambda k: (chars[k], k))
            lines.append((size, box, text))
    if not lines:
        return ""
    max_size = max(s for s, _, _ in lines)
    rows: list[list[tuple]] = []
    for _, box, text in sorted(
        (ln for ln in lines if ln[0] >= max_size - 0.5), key=lambda ln: ln[1][1]
    ):
        if rows and box[1] < rows[-1][-1][0][3] - (box[3] - box[1]) / 2:
            rows[-1].append((box, text))
        else:
            rows.append([(box, text)])
    return " ".join(t for row in rows for _, t in sorted(row, key=lambda r: r[0][0]))[
        :300
    ]


def segment(text: str, max_len: int = 600) -> list[str]:
    """Split a page's text into aligned translation units (paragraph-ish).

    PDF text often breaks lines mid-paragraph, so we group into paragraphs on
    blank lines, collapse internal line breaks, then split overly long paragraphs
    on sentence boundaries. Returns a flat list of clean segment strings.
    """
    segments: list[str] = []
    for para in re.split(r"\n\s*\n", text):
        para = " ".join(para.split())  # collapse newlines + runs of spaces
        if not para:
            continue
        if len(para) <= max_len:
            segments.append(para)
            continue
        # split long paragraph into sentences, re-packing up to max_len
        buf = ""
        for sent in re.split(r"(?<=[.!?])\s+", para):
            if buf and len(buf) + len(sent) + 1 > max_len:
                segments.append(buf)
                buf = sent
            else:
                buf = f"{buf} {sent}".strip()
        if buf:
            segments.append(buf)
    return segments


try:
    import pysbd

    _SEG = pysbd.Segmenter(language="en", clean=False, char_span=True)
except Exception:  # noqa: BLE001 - pysbd optional; fall back to regex
    _SEG = None

# spaCy is the primary sentence segmenter: its parser keeps inline references like "(Fig 1 a)"
# and lettered enumerations whole, which pysbd mis-splits. Loaded lazily (the model downloads
# once, ~12 MB); if spaCy or the model is unavailable, _split_sentences falls back to pysbd.
_SPACY = None
_SPACY_FAILED = False


def _spacy_segmenter():
    global _SPACY, _SPACY_FAILED
    if _SPACY is not None or _SPACY_FAILED:
        return _SPACY
    try:
        import spacy

        name = "en_core_web_sm"
        try:
            _SPACY = spacy.load(name, exclude=["ner", "lemmatizer"])
        except OSError:  # model not downloaded yet
            from spacy.cli import download

            download(name)
            _SPACY = spacy.load(name, exclude=["ner", "lemmatizer"])
    except Exception:  # noqa: BLE001 — any failure => fall back to pysbd
        _SPACY_FAILED = True
        _SPACY = None
    return _SPACY


def warm_sentence_model() -> bool:
    """Load (and download, on first run) the spaCy model. Called at server startup so the
    first page's layout doesn't pay for it. Returns False if unavailable (pysbd is used)."""
    return _spacy_segmenter() is not None


# Paper abbreviations pysbd misses (merge a sentence that ends with one into the next).
_ABBR_TAIL = re.compile(
    r"\b(Eq|Eqs|Eqn|Fig|Figs|Sec|Secs|Tab|Tabs|Alg|Thm|Lem|Cor|Prop|Def|No|Ref|Refs"
    r"|Ch|App|Appx|vs|cf|al|e\.g|i\.e)\s?\.$",
    re.IGNORECASE,
)


_BULLET_CHARS = "•◦▪▫●○‣⁃∙"

# Enumeration item markers ("a)", "(a)", "(A)", "1)", "(1)", "(i)", "(ii)"...). A sentence
# segmenter only splits a list when its items end in terminal punctuation, so a comma/"and"-joined
# list ("(1) x, (2) y, and (3) z") stays glued and a markerless item ("...landscape c) Diffusion")
# never breaks. We split such runs ourselves, conservatively (see _split_on_markers).
_ROMAN = {"i", "ii", "iii", "iv", "v", "vi", "vii", "viii", "ix", "x"}
_ENUM_RE = re.compile(r"(\()?([A-Za-z]{1,4}|\d{1,2})\)")
_ENUM_ABBR = re.compile(
    r"\b(Eq|Eqs|Eqn|Fig|Figs|Sec|Secs|Tab|Tabs|Table|No|Nos|Ref|Refs|Ch|App|Appx"
    r"|Alg|Thm|Lem|Cor|Prop|Def)\.?\s*$",
    re.IGNORECASE,
)

# C0/DEL control characters a PDF uses as large-bracket delimiters inside math (e.g. N\x000,σ²I\x01).
# They are garbage in the text layer, so strip them from every word token before anything else sees
# them — otherwise they leak into a sentence as a fragment like "0 , σ 2 I \x01".
_CTRL_STRIP = {c: None for c in range(0x20) if c not in (0x09, 0x0A, 0x0D)}
_CTRL_STRIP[0x7F] = None

# AIP/APS journals (1990s-2000s) set math in "Universal-GreekwithMathPi", whose text layer
# reuses ASCII codes for the glyphs it draws: "~1!" is "(1)", "D" is "Δ". Read off rendered
# glyphs in real PDFs; codes not seen there stay as they are rather than being guessed.
_MATHPI_FONT = "Universal-GreekwithMath"
_MATHPI = str.maketrans(
    {
        "~": "(",
        "!": ")",
        "@": "[",
        "#": "]",
        "^": "⟨",
        "&": "⟩",
        "<": "≤",
        ">": "≥",
        "`": "∞",
        ";": "∼",
        "a": "α",
        "d": "δ",
        "e": "ϵ",
        "«": "ε",
        "f": "φ",
        "g": "γ",
        "h": "η",
        "j": "ξ",
        "l": "λ",
        "m": "μ",
        "r": "ρ",
        "s": "σ",
        "t": "τ",
        "u": "θ",
        "w": "ϕ",
        "x": "χ",
        "z": "ζ",
        "C": "Ψ",
        "D": "Δ",
        "F": "Φ",
        "S": "Σ",
        "V": "Ω",
    }
)

# TeX's CMEX10 (big operators, radicals, wide accents, big delimiters) has glyph names outside
# the Adobe list, so the text layer falls back to the raw codes: "P" for a sum, "e" for a wide
# tilde, "(" for a big "{", a C0 control code for a big parenthesis (which _CTRL_STRIP would
# then drop). The codes are TeX's fixed OMX layout, checked against the encodings embedded in
# 28 CMEX fonts of real PDFs; only codes seen there are mapped. A tall delimiter is drawn in
# pieces: its top piece reads as the delimiter, its extension and bottom pieces read as
# nothing. Not mapped: code 32 (a big "("), because the text layer's own word spaces are " "
# too; and the vertical bar extensions (codes 12, 13), which stack into "‖‖ A ‖‖" and split the
# sentence there. A code the font's ToUnicode map covers is never remapped (_cmex_tables).
_CMEX_FONT = "CMEX"
_CMEX = str.maketrans(
    {
        "\x00": "(",
        "\x01": ")",
        "\x02": "[",
        "\x03": "]",
        "\x08": "{",
        "\x09": "}",
        "\x0a": "⟨",
        "\x0b": "⟩",
        "\x10": "(",
        "\x11": ")",
        "\x12": "(",
        "\x13": ")",
        "\x14": "[",
        "\x15": "]",
        "\x16": "⌊",
        "\x17": "⌋",
        "\x1a": "{",
        "\x1b": "}",
        "(": "{",
        ")": "}",
        "!": ")",
        '"': "[",
        "#": "]",
        "h": "[",
        "i": "]",
        "n": "{",
        "o": "}",
        # top pieces of a tall delimiter, then its bottom and extension pieces
        "0": "(",
        "1": ")",
        "2": "[",
        "3": "]",
        "@": "",
        "A": "",
        "B": "",
        "C": "",
        "4": "",
        "5": "",
        "6": "",
        "7": "",
        "F": "⊔",
        "P": "∑",
        "Q": "∏",
        "R": "∫",
        "S": "⋃",
        "X": "∑",
        "Y": "∏",
        "Z": "∫",
        "b": "ˆ",
        "e": "˜",
        "f": "˜",
        "p": "√",
        "q": "√",
        "r": "√",
        "s": "√",
        # pieces of a horizontal (over/under) brace
        "z": "",
        "{": "",
        "|": "",
        "}": "",
    }
)

# Bump when extract() changes what it returns, so stored docs are re-extracted on next open.
# (v3: CMEX10 symbols decoded. v4: a title line's size is the size most of its characters
# use, and lines on one row read left to right.)
TEXT_VERSION = 4


def _cmap_codes(cmap: str) -> frozenset[int]:
    """The character codes a ToUnicode CMap maps (its bfchar and bfrange entries)."""
    codes: set[int] = set()
    for block in re.findall(r"beginbfchar(.*?)endbfchar", cmap, re.S):
        pairs = re.findall(r"<([0-9A-Fa-f]+)>\s*<[0-9A-Fa-f]+>", block)
        codes.update(int(c, 16) for c in pairs)
    for block in re.findall(r"beginbfrange(.*?)endbfrange", cmap, re.S):
        block = re.sub(r"\[[^\]]*\]", "<0>", block)  # a range's array of targets
        for a, b in re.findall(r"<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>\s*<", block):
            codes.update(range(int(a, 16), int(b, 16) + 1))
    return frozenset(codes)


def _cmex_tables(page) -> dict[str, dict[int, str]]:
    """For each CMEX font on the page, _CMEX less the codes its ToUnicode map covers.

    pdfTeX's built-in map for cmex covers only the tall-delimiter pieces, so every other glyph
    still reads as its raw code; a full map (newer TeX setups) reads every glyph as what it
    draws ("(" is then a real parenthesis), so only the codes a font leaves unmapped are raw."""
    out: dict[str, dict[int, str]] = {}
    for font in page.get_fonts():
        xref, base = font[0], font[3]
        if _CMEX_FONT not in base.upper():
            continue
        doc = page.parent
        kind, ref = doc.xref_get_key(xref, "ToUnicode")
        cmap = doc.xref_stream(int(ref.split()[0])) if kind == "xref" else None
        covered = _cmap_codes((cmap or b"").decode("latin-1"))
        # a span names its font without the subset tag ("ABCDEF+CMEX10" -> "CMEX10")
        out[base.split("+")[-1]] = {o: v for o, v in _CMEX.items() if o not in covered}
    return out


def _decode_span(span: dict, cmex: dict[str, dict[int, str]] | None = None) -> str:
    """A span's text with a math font's borrowed codes (MathPi, CMEX10) mapped to what it
    draws. `cmex` is _cmex_tables() of the span's page; without it all of _CMEX applies."""
    text, font = span.get("text", ""), span.get("font", "")
    if _MATHPI_FONT in font:
        return text.translate(_MATHPI)
    if _CMEX_FONT not in font.upper():
        return text
    return text.translate((cmex or {}).get(font.split("+")[-1], _CMEX))


def _page_text(page) -> str:
    """Plain page text; pages using a math font with borrowed codes are rebuilt from decoded
    spans."""
    if not any(
        _MATHPI_FONT in f[3] or _CMEX_FONT in f[3].upper() for f in page.get_fonts()
    ):
        return page.get_text("text")
    cmex = _cmex_tables(page)
    lines = []
    for block in page.get_text("dict").get("blocks", []):
        if block.get("type") != 0:
            continue
        for line in block.get("lines", []):
            lines.append(
                "".join(_decode_span(sp, cmex) for sp in line.get("spans", []))
            )
    return "".join(line + "\n" for line in lines)


def _split_on_bullets(raw: list[tuple[int, int]], text: str) -> list[tuple[int, int]]:
    """Split sentence ranges at bullet markers so each list item is its own segment."""
    out: list[tuple[int, int]] = []
    for s, e in raw:
        last = s
        for i in range(s + 1, e):  # not at the very start
            # '◦' doubles as the degree / composition sign ('90 ◦', 'F Θ ◦ γ'): a bullet
            # only after the end of a clause
            if text[i] == "◦" and text[s:i].rstrip()[-1:] not in ".:;!?)":
                continue
            if text[i] in _BULLET_CHARS:
                if text[last:i].strip():
                    out.append((last, i))
                last = i
        if text[last:e].strip():
            out.append((last, e))
    return out


def _mend_word_splits(raw: list[tuple[int, int]], text: str) -> list[tuple[int, int]]:
    """Undo a boundary the segmenter put INSIDE a PDF word. spaCy splits punctuation off, so it
    can end a sentence inside a word like ');' in 'Ho et al. ( 2020 ); Nichol and ...' or '5:'
    in 'Table 5: Per-scene ...': the word then maps to BOTH sentences (highlighted twice) and
    the next fragment opens with ';' or ':'. Such a boundary is not a sentence end, so the two
    fragments are merged - unless the rest of the word is sentence-final punctuation ('065).'),
    where the boundary moves to the word's end, or the word glues two sentences together
    ('increases.The'), which is left as it is. A dotted name ('Ljavax.crypto.|Cipher') is one
    token, not two sentences, so it is merged."""
    out: list[list[int]] = []
    for s, e in raw:
        if (
            out
            and out[-1][1] == s
            and 0 < s < len(text)
            and not text[s - 1].isspace()
            and not text[s].isspace()
        ):
            we = s
            while we < len(text) and not text[we].isspace():
                we += 1
            tail = text[s:we]
            if not any(c.isalnum() for c in tail) and re.search(r"[.!?]", tail):
                out[-1][1] = min(we, e)
                if text[we:e].strip():
                    out.append([we, e])
                else:
                    out[-1][1] = e
                continue
            head = text[out[-1][0] : s]
            dotted = "." in head.split()[-1][:-1] if head.split() else False
            if dotted or not (_ends_sentence(head) and tail[:1].isupper()):
                out[-1][1] = e
                continue
        out.append([s, e])
    return [(s, e) for s, e in out]


def _starts_lower_frag(text: str, span: tuple[int, int]) -> bool:
    """True when a fragment begins with a lowercase letter — a real sentence never does, so such
    a fragment is an over-split continuation of the one before it (e.g. the segmenter broke a
    sentence at the '...' inside spaced-out inline math 'x k - 1 ... x 0, until ...').
    An enumeration item ('a)', '(i)') starts lowercase but is a real list item, not a
    continuation, so it must NOT be merged back into the sentence before it."""
    frag = text[span[0] : span[1]].lstrip()
    if _ENUM_RE.match(frag):
        return False
    c = frag[:1]
    return c.isalpha() and c.islower() and c.isascii()


# A fragment that begins with a binary math operator ("= 64", "· d", "− 1") is usually the tail
# of an inline expression the segmenter broke ("...representations z" | "= (z_1, ..., z_n)"):
# the spaced-out PDF glyphs put the operator at the start of the next fragment, and merging it
# back rejoins the expression. The true minus U+2212 is included; the ASCII hyphen is
# deliberately NOT, since a leading "-" is more often a dash list item than math.
_MATH_CONT_START = frozenset("=+/·⋅×⊙∥≈≠≤≥<>±∼→←⇒∈∝≡−∑∏∫√")
# A fragment never ends on such an operator, a big operator, a radical or an opening bracket
# standing as its own token ("ˆ w i = w i / ∑" + "Nc j =1 w j produces ...", "| m / √ v | <" +
# "1 therefore ..."): the segmenter broke inside the expression. "C++" is not standalone.
_MATH_OPEN_END = re.compile(r"(?:^|\s)[=+/·⋅×≈≠≤≥<>±∼→⇒∈∝≡−∑∏∫√(\[{⟨]$")
# ...but an operator-like label followed by a capitalized word ("− We propose ...",
# "· We evaluate ...") is a list item, not math.
_LIST_LABEL = re.compile(r"[−·⋅+→]\s+[A-Z][a-z]")


def _starts_lower_any(text: str, span: tuple[int, int]) -> bool:
    """Any lowercase letter, not only ASCII: a Greek symbol ('2 . 5' + 'σ level.') or a PDF
    ligature glyph ('the Ricci' + 'ﬂow whenever ...'). Used only after an unfinished fragment,
    since a sentence may open with a Greek symbol ('σ is the noise level.')."""
    frag = text[span[0] : span[1]].lstrip()
    c = frag[:1]
    return c.isalpha() and c.islower() and not _ENUM_RE.match(frag)


def _starts_math_cont(text: str, span: tuple[int, int]) -> bool:
    frag = text[span[0] : span[1]].lstrip()
    return frag[:1] in _MATH_CONT_START and not _LIST_LABEL.match(frag)


# An inline author-year citation ("Ronneberger et al. (2015)", "Perez et al. (2018)",
# "Smith and Jones (2020)", "Müller (2014)") confuses the segmenter, which starts a new sentence
# at the author name. Following an unfinished fragment, it is a continuation and is merged back.
# A name followed by a parenthesized 19xx/20xx year is what makes this specific; a capitalized
# function word ("In ( 2015 ), ...") is not a name.
_NAME = r"[A-ZÀ-ÖØ-Þ](?:[^\W\d_]|['’.-])+"
_CITATION_START = re.compile(
    _NAME
    + r"(?:\s+(?:et\s+al\.?|and\s+"
    + _NAME
    + r"|&\s*"
    + _NAME
    + r"))?\s*\(\s*(?:19|20)\d{2}[a-z]?\b"
)
_NOT_AUTHOR = frozenset(
    "In On At By For From Since Until After Before During As See".split()
)


def _starts_citation(text: str, span: tuple[int, int]) -> bool:
    # Look past the fragment's end: the segmenter may also have split after "et al.", leaving
    # the year in the following fragment (which _ABBR_TAIL then joins).
    head = text[span[0] : span[0] + 120].lstrip()
    return bool(_CITATION_START.match(head)) and head.split()[0] not in _NOT_AUTHOR


# A lone capital math symbol that the segmenter took for a sentence start: the running text
# ends, unfinished, on a math token (a single letter, a Greek letter or a small number) and the
# next fragment starts with a single capital letter followed by a lowercase word
# ("Starting from x" + "K sampled from Gaussian noise" for x^K; "N(0, σ 2" + "I is Gaussian
# noise" for σ²I). "Table 2" / "Fig. 3" / "Section 4" style references are not math tails.
_MATH_TAIL = re.compile(r"(?:^|\s)(?:[A-Za-z]|[\u0370-\u03ff]|\d{1,2})$")
_REF_WORD = re.compile(
    r"(?:Table|Tab|Figure|Fig|Section|Sec|Eq|Eqn|Equation|Appendix|App|Algorithm|Alg|Step|Stage|Part)"
    r"\.?\s+\d{1,2}$",
    re.IGNORECASE,
)


# A capital letter standing alone before an operator, number, symbol or another capital
# ("A − QQ ∗ A ∥", "O ( N − 2 )", "L 2 norm", "C + B") is a math symbol whatever precedes it.
# "A"/"I" qualify only before an operator or punctuation, since "A 2D map ..." opens a sentence;
# a capital before a lowercase word ("T cells", "N dx") is left to the math-tail rule above.
_CAP_SYMBOL = re.compile(r"(?:[B-HJ-Z]\s+(?![a-z]{2})|[AI]\s+(?=[^\w\s])|[A-Z]\s*$)")


def _lone_capital_after_math(t: str, text: str, span: tuple[int, int]) -> bool:
    frag = text[span[0] : span[1]].lstrip()
    if _CAP_SYMBOL.match(frag):
        return True
    return (
        bool(re.match(r"[A-Z]\s+[a-z]", frag))
        and bool(_MATH_TAIL.search(t))
        and not _REF_WORD.search(t)
    )


# A fragment opening with '[' - a citation ('[41]', '[H 1]', '[71, § 14.5]') or an interval
# ('[0 , T )') - continues an unfinished sentence: spaCy starts a new sentence there, but a
# sentence never opens with a bracket.
def _starts_bracket(text: str, span: tuple[int, int]) -> bool:
    return text[span[0] : span[1]].lstrip()[:1] == "["


# Likewise a '(' that is not a list marker ('( p k , r k )' after 'B', '(middle) shows' after
# 'Fig. 6'); '(a)', '(ii)', '(3)' items stay split.
def _starts_paren(text: str, span: tuple[int, int]) -> bool:
    frag = text[span[0] : span[1]].lstrip()
    m = _ENUM_RE.match(frag)
    return frag[:1] == "(" and not (m and _is_enum_label(m.group(2)))


# Closing or connective punctuation never opens a sentence: '; Nichol ...', ', Hamilton
# proved', ': Per-scene results', '| 2 ) dm', '’s predicted', ') 3 He'.
_CLOSE_START = frozenset(",;:.)]}%|’′″")


def _starts_closing(text: str, span: tuple[int, int]) -> bool:
    return text[span[0] : span[1]].lstrip()[:1] in _CLOSE_START


# TeX's \dots comes out as spaced periods ("{ x 1 , . . . , x n }"), and the segmenter ends a
# sentence inside or right after them. A fragment ending in such a run goes on when the next one
# opens with punctuation, a closing bracket or quote, or an operator (", x n }", ". , x n }",
# "< h k", "”"); a page number or a capitalized word after it (a table of contents' dot leader,
# "σ 3 ≥ . . . ." + "Choose ...") starts anew, but not a one-letter symbol after a range with
# no period of its own, three dots after a value ("k = 1 . . ." + "K do", "t = 1 . . ." +
# "T , which ..."); "A" and "I" may open a sentence.
_ELLIPSIS_END = re.compile(r"(?:^|\s)\.(?:\s\.)+$")
_RANGE_END = re.compile(r"[^.\s]\s+\.\s\.\s\.$")
_SYMBOL_START = re.compile(r"[B-HJ-ZΑ-Ω](?![\w.])")


def _continues_ellipsis(t: str, text: str, span: tuple[int, int]) -> bool:
    frag = text[span[0] : span[1]].lstrip()
    return bool(_ELLIPSIS_END.search(t)) and (
        _starts_closing(text, span)
        or _starts_math_cont(text, span)
        or frag[:1] == "”"
        or bool(_RANGE_END.search(t) and _SYMBOL_START.match(frag))
    )


def _merge_fragments(
    raw: list[tuple[int, int]],
    text: str,
    hard: frozenset[int] = frozenset(),
    whole: tuple[tuple[int, int], ...] = (),
) -> list[tuple[int, int, str]]:
    """Merge lone section numbers, trailing paper-abbreviations, and over-split fragments into
    the sentence they belong to. An over-split continuation is a fragment that starts lowercase
    (spaced inline math), or - while the running text is not yet a complete sentence - one that
    starts with a binary math operator ("...z" + "= (z_1, ..., z_n).") or an inline author-year
    citation ("...(FiLM)" + "Perez et al. (2018) ..."). A fragment that starts at a `hard`
    offset (a list item or an algorithm step, see _item_starts) is never merged into the one
    before it, and a lone mark or bracket left right before one ends the sentence before it.
    A fragment that starts inside a `whole` span (an algorithm step's own row) is merged."""
    out: list[tuple[int, int, str]] = []
    i = 0
    while i < len(raw):
        s, e = raw[i]
        t = text[s:e].strip()
        while (
            i + 1 < len(raw)
            and _lstrip_at(text, raw[i + 1][0]) not in hard
            and (
                any(a < _lstrip_at(text, raw[i + 1][0]) < b for a, b in whole)
                or re.fullmatch(r"\d+(\.\d+)*\.?", t)
                or _ABBR_TAIL.search(t)
                or len(t) <= 2
                # a short label ("Right:", "Figure 13:") introduces the capitalized sentence
                # after it; a list item ("1) ...", "(A) ...", "− We ...", "• ...") stays split
                or (
                    t.endswith(":")
                    and len(t.split()) <= 3
                    and text[raw[i + 1][0] : raw[i + 1][1]].lstrip()[:1].isupper()
                    and not _ENUM_RE.match(text[raw[i + 1][0] : raw[i + 1][1]].lstrip())
                )
                # a bare letter/roman list marker ("(A)" + "The shortcut ...") labels the
                # item after it ("(21)" alone is as often an equation number: left alone)
                or _is_marker_only(t, text[raw[i + 1][0] : raw[i + 1][1]].lstrip())
                # decimal split from spaced glyphs, e.g. "82 ." + "1%" -> keep together
                or (
                    re.search(r"\d\s*\.$", t)
                    and text[raw[i + 1][0] : raw[i + 1][1]].lstrip()[:1].isdigit()
                )
                # the NEXT fragment starts lowercase -> it continues this sentence
                or _starts_lower_frag(text, raw[i + 1])
                # this fragment ends inside a hyphenated compound split by a line break
                # ("LIBERO-" + "Long", "GPT-" + "5.6 Sol", "base-" + "Λ CDM")
                or re.search(r"[^\W_]-$", t)
                # ... or inside a spaced ellipsis the list goes on after ("{ x 1 , . ." +
                # ". , x n }")
                or _continues_ellipsis(t, text, raw[i + 1])
                # a sentence never ends on ',' or ';' ("( Holz & Hughes 2005 ;" + "Abbott et
                # al. 2017", "In his seminal paper ," + "Hamilton proved") or on a standalone
                # math operator (_MATH_OPEN_END) - but an enumeration item or bullet after it
                # stays split
                or (
                    (t[-1:] in ",;" or _MATH_OPEN_END.search(t))
                    and not _ENUM_RE.match(text[raw[i + 1][0] : raw[i + 1][1]].lstrip())
                    and text[raw[i + 1][0] : raw[i + 1][1]].lstrip()[:1]
                    not in _BULLET_CHARS
                )
                # the NEXT fragment starts with a math operator ("= 64", "− 1") or an inline
                # citation ("Perez et al. (2018)") while this one is not a finished sentence ->
                # the segmenter broke mid-sentence
                or (
                    not _ends_sentence(t)
                    and (
                        _starts_math_cont(text, raw[i + 1])
                        or _starts_citation(text, raw[i + 1])
                        or _lone_capital_after_math(t, text, raw[i + 1])
                        or _starts_lower_any(text, raw[i + 1])
                        or _starts_closing(text, raw[i + 1])
                        or _starts_paren(text, raw[i + 1])
                        or _starts_bracket(text, raw[i + 1])
                    )
                )
            )
        ):
            i += 1
            e = raw[i][1]
            t = text[s:e].strip()
        if (
            len(t.split()) == 1
            and not t[:1].isalpha()
            and out
            and i + 1 < len(raw)
            and _lstrip_at(text, raw[i + 1][0]) in hard
            and _lstrip_at(text, s) not in hard
        ):
            # a mark or a bracket left before an item ends the sentence before it: a footnote
            # mark ("... data. §" + "2. ..."), an answer ("Did you ...? [Yes]" + "3. ..."); a
            # word stays, it may lead into the item ("Then" + "(i) ...")
            ps = out[-1][0]
            out[-1] = (ps, e, text[ps:e].strip())
        else:
            out.append((s, e, t))
        i += 1
    return out


def _is_marker_only(t: str, nxt: str) -> bool:
    m = _ENUM_RE.fullmatch(t)
    return (
        bool(m)
        and not m.group(2).isdigit()
        and _is_enum_label(m.group(2))
        and not _ENUM_RE.match(nxt)
    )


def _is_enum_label(lab: str) -> bool:
    return lab.isdigit() or (len(lab) == 1 and lab.isalpha()) or lab.lower() in _ROMAN


def _enum_candidates(text: str) -> list[tuple[int, tuple[bool, str]]]:
    """Enumeration item markers in `text` as (start, class), with reference-like matches
    (Eqn.(1), 'Fig 2(a)', 'III-A)', a decimal '0.5)') filtered out. class = (has_paren, kind)."""
    out: list[tuple[int, tuple[bool, str]]] = []
    for m in _ENUM_RE.finditer(text):
        lab = m.group(2)
        if not _is_enum_label(lab):
            continue
        if text[m.end() : m.end() + 1] != " ":  # a real item has text after the marker
            continue
        i = m.start()
        before = text[i - 1] if i > 0 else " "
        if before.isalnum() or before in "-.":  # 2(a), III-A), decimal 0.5)
            continue
        if m.group(1) and _ENUM_ABBR.search(text[:i]):  # Eqn.(1), Fig. (3)
            continue
        win = text[max(0, i - 80) : i]
        if not m.group(1) and win.count("(") > win.count(")"):  # closes 'R ( z , 0)'
            continue
        out.append((i, (bool(m.group(1)), "digit" if lab.isdigit() else "alpha")))
    return out


def _split_on_markers(raw: list[tuple[int, int]], text: str) -> list[tuple[int, int]]:
    """Split sentence ranges before each item of a qualifying enumeration run: a run of >=2
    same-class markers introduced by a colon, or any run of >=3. This leaves a lone equation
    number, an 'Eqn.(1)' reference, and a two-part subfigure phrase ('show (a) X and (b) Y')
    intact, while breaking real lists the segmenter glued together."""
    cands = _enum_candidates(text)
    if len(cands) < 2:
        return raw
    splits: set[int] = set()
    i = 0
    while i < len(cands):
        j = i
        while j + 1 < len(cands) and cands[j + 1][1] == cands[i][1]:
            j += 1
        run = cands[i : j + 1]
        first = run[0][0]
        colon = ":" in text[max(0, first - 160) : first]
        if len(run) >= 3 or (len(run) >= 2 and colon):
            splits.update(pos for pos, _ in run)
        i = j + 1
    if not splits:
        return raw
    out: list[tuple[int, int]] = []
    for s, e in raw:
        last = s
        for p in sorted(p for p in splits if s < p < e):
            if text[last:p].strip():
                out.append((last, p))
            last = p
        if text[last:e].strip():
            out.append((last, e))
    return out


# A list item or an algorithm step at the start of a line: "1.", "2)", "(3)", "(a)", "b)",
# "(iv)", a bullet, or an algorithm line number ("12:").
_ITEM_MARK = re.compile(
    r"(\d{1,2})\.|\(?(\d{1,2})\)|\(?([A-Za-z])\)|\((i|ii|iii|iv|v|vi|vii|viii|ix|x)\)"
    r"|(\d{1,3}):|[" + _BULLET_CHARS + "]"
)


def _item_kind(tok: str) -> tuple[str, int | None] | None:
    """The (kind, number) of a line-opening item marker, or None. Kinds: dot "1.", paren "(1)"
    and colon "1:" (an algorithm step) with their number; alpha "(a)", roman "(ii)" and a
    bullet (its own kind) have none, since a letter is no evidence of a list (_item_starts)."""
    m = _ITEM_MARK.fullmatch(tok)
    if not m:
        return None
    dot, paren, alpha, roman, colon = m.groups()
    if dot or paren or colon:
        kind = "dot" if dot else "paren" if paren else "colon"
        return kind, int(dot or paren or colon)
    return ("alpha" if alpha else "roman" if roman else tok), None


def _line_item(ln: dict, words: list[dict]) -> tuple[str, int | None] | None:
    """The item marker that opens line `ln` (see _item_kind). A marker alone on its line is
    not one ("(5)" is as often an equation number, "(B)" an answer), except an algorithm line
    number, which PDFs often set apart from its step ("4:" | "x ← y")."""
    mk = _item_kind(words[ln["widx"][0]]["t"])
    if mk is not None and mk[0] != "colon" and len(ln["widx"]) == 1:
        return None
    return mk


# A line that ends on a capitalized reference word: the number opening the next line is what
# it refers to ("... shown in Figure" + "3. We then ..."). Not "step" or "line": a step ends
# on them ("3: take a gradient step" + "4: until converged").
_REF_TAIL = re.compile(
    r"\b(?:Figure|Section|Equation|Appendix|Algorithm|Theorem|Lemma|Corollary|Proposition"
    r"|Definition|Chapter)\s*$"
)
# A word after "(3)" that goes on from an equation number, not one that opens an item.
_REF_NEXT = re.compile(r"and|or|to|into|is|are|gives?|yields?|impl(?:y|ies)|holds?")


def _item_starts(
    lines: list[dict], words: list[dict], numbered: set[tuple]
) -> list[int]:
    """Word indices where a list item or an algorithm step opens a line of a paragraph
    (`lines`, in order), so a new sentence starts there. The marker alone could be prose
    wrapped onto a new line ("... the batch size was" + "8. The model ..."), so it also needs
    evidence that a list is laid out: the line before it ends with a colon, or, for a number,
    another line of the page opens with the next or previous number of the same kind ("3:"
    after "2:"; `numbered` holds the page's line-opening readings). A letter has no such
    evidence: "(a)" and "(b)" also open lines as panel references ("... as shown in panel" +
    "(b) and ..."). Nor is a marker after "Eq.", "Table" or "Figure" an item: it is a
    reference; nor a "3)" that closes a parenthesis the line before opened ("... (ideally" +
    "3) as ..."), a number after a word broken at the line's end ("top-" + "5. We ..."), an
    equation number the text goes on from ("Substituting into" + "(3) and (4) gives ..."),
    or a number no higher than an item before it in the paragraph: a list counts up, and
    "... go to step" + "2. Otherwise ..." in item 3 refers back."""
    out = []
    last: dict[str, int] = {}  # the number of the paragraph's last item of each kind
    for k, ln in enumerate(lines):
        mk = _line_item(ln, words)
        prev = lines[k - 1]["text"] if k else ""
        if (
            mk is None
            or _ENUM_ABBR.search(prev)
            or _REF_TAIL.search(prev)
            or prev.rstrip().endswith("-")
            or (
                words[ln["widx"][0]]["t"][0] != "("
                and mk[0] in ("paren", "alpha")
                and prev.count("(") > prev.count(")")
            )
            or (
                mk[0] == "paren"
                and len(ln["widx"]) > 1
                and _REF_NEXT.fullmatch(words[ln["widx"][1]]["t"])
            )
        ):
            continue
        kind, n = mk
        if n is not None and n <= last.get(kind, 0):
            continue  # a list counts up: "2." after item 3 refers back ("go to step" + "2.")
        near = kind in ("dot", "paren", "colon") and (
            (kind, n - 1) in numbered or (kind, n + 1) in numbered
        )
        if near or prev.rstrip().endswith(":"):
            out.append(ln["widx"][0])
            if n is not None:
                last[kind] = n
    return out


# Pseudo-code keywords: a line that only closes a block, one that opens a loop or a branch
# ("for each iteration do", "if t mod d then"), and a line's first word.
_PC_END = re.compile(
    r"end\s?(?:for|while|if|function|procedure|loop)?|endfor|endwhile|endif",
    re.IGNORECASE,
)
_PC_OPEN = re.compile(r"(?:for|foreach|forall|while|if)\b.*\b(?:do|then)")
_PC_KEY = re.compile(
    r"(?:for|foreach|forall|while|if|else|repeat|until|return|end(?:for|while|if)?)\b"
    r"|(?:Require|Ensure|Input|Output|Initiali[sz]e|Algorithm)\b"
)
# A row that ends on a word or a sign that needs more is a step that wraps ("Update the
# network with" + "SGD and a decayed rate"). Not "a": a step ends on a symbol ("action a").
_PC_WRAP = re.compile(
    r"(?:\b(?:with|and|or|of|the|an|to|from|using|by|in|on|at|as|into|over|via|per)"
    r"|[,(=+−-])$"
)


def _pseudo_starts(
    lines: list[dict], words: list[dict], steps_only: bool = False
) -> list[int]:
    """Word indices where a step of pseudo-code with no line numbers opens a row of a
    paragraph (`lines`, in order), so a new sentence starts there: the steps have no period
    of their own and ran together ("for each iteration do Sample a batch ... end for"). The
    paragraph is pseudo-code when a row only closes a block ("end for"; a bare "end" needs
    another sign), a "repeat" has its "until", or a row that opens a loop ("for t = 1 to T
    do") has a second sign beside it, another such row or an assignment ("y ← r + γ"); prose
    has rows that open with "for" and end in "do" ("for every τ. Indeed, ... we do" +
    "recover ..."). From its first keyword row to its last (prose before the algorithm stays
    whole), a step opens a row with a keyword, a capitalized word ("Sample", "Update"), or an
    assignment, or follows a row that opens or closes a block; a row after one that ends on
    "with", a comma or the like goes on (a wrapped step), and the row after an "end ..."
    starts anew (the text after the algorithm; not with `steps_only`). A row is a line and
    the pieces beside it at the same height (an accent, the text after a gap)."""
    rows: list[list[dict]] = []
    for ln in lines:
        if rows and abs(ln["cy"] - rows[-1][-1]["cy"]) < ln["size"] / 2:
            rows[-1].append(ln)
        else:
            rows.append([ln])
    texts = [" ".join(ln["text"].strip() for ln in row) for row in rows]
    toks = [[words[g]["t"] for ln in row for g in ln["widx"]] for row in rows]

    def assigns(k: int) -> bool:
        return any("←" in t or t == ":=" for t in toks[k][1:4])

    ends = [k for k, t in enumerate(texts) if _PC_END.fullmatch(t)]
    if ends or "repeat" in texts:
        ends += [k for k, t in enumerate(texts) if re.match(r"until\b", t)]
    opens = [
        k
        for k, t in enumerate(texts)
        if _PC_OPEN.fullmatch(t)
        and not re.search(r"[.;?!]\s", re.sub(r"\.(?:\s\.)+", "", t))
    ]
    # ":=" is also a definition of math prose ("Let f := g, and" + "if x ∈ A then")
    assigned = any("←" in t for row in toks for t in row[1:4])
    if (
        ends
        and all(texts[k].lower() == "end" for k in ends)
        and not (opens or assigned)
    ):
        ends = []  # "end" alone may be a word of prose ("from one" + "end" + "to the other")
    if not (ends or len(opens) > 1 or (opens and assigned)):
        return []
    keyed = [k for k, t in enumerate(texts) if _PC_KEY.match(t) or assigns(k)]
    start, last = min(ends + opens + keyed), max(ends + opens + keyed)
    out = []
    for k in range(max(1, start), min(len(rows), last + (1 if steps_only else 2))):
        prev, first = texts[k - 1], toks[k][0]
        if re.fullmatch(r"\d{1,3}:", prev):
            continue  # a step number set apart from its step
        if k - 1 not in ends and _PC_WRAP.search(prev) and not _PC_KEY.match(texts[k]):
            continue
        if (
            k - 1 in ends
            or _PC_KEY.match(texts[k])
            or re.search(r"\b(?:do|then|repeat|else)$", prev)
            or (first[:1].isupper() and first[1:2].islower())
            or assigns(k)
        ):
            out.append(rows[k][0]["widx"][0])
    return out


def _lstrip_at(text: str, i: int) -> int:
    """The offset of the first non-space character at or after `i`."""
    while i < len(text) and text[i].isspace():
        i += 1
    return i


def _split_at(
    raw: list[tuple[int, int]], text: str, cuts: frozenset[int]
) -> list[tuple[int, int]]:
    """Split sentence ranges at each offset in `cuts` that falls inside one."""
    out: list[tuple[int, int]] = []
    for s, e in raw:
        last = s
        for p in sorted(p for p in cuts if s < p < e):
            if text[last:p].strip():
                out.append((last, p))
                last = p
        out.append((last, e))
    return out


def _split_sentences(
    text: str,
    hard: frozenset[int] = frozenset(),
    whole: tuple[tuple[int, int], ...] = (),
) -> list[tuple[int, int, str]]:
    """Split into sentences, returning (start, end, text). Uses pysbd (handles abbreviations,
    decimals, citations, URLs) with a regex fallback, then merges paper-specific leftovers.
    `hard` holds offsets where a sentence always starts (list items, algorithm steps)."""
    raw = None
    nlp = _spacy_segmenter()
    if nlp is not None:
        with contextlib.suppress(Exception):
            doc = nlp(text)
            raw = [(s.start_char, s.end_char) for s in doc.sents if s.text.strip()]
    if raw is None and _SEG is not None:
        with contextlib.suppress(Exception):
            raw = [
                (sp.start, sp.end)
                for sp in _SEG.segment(text)
                if text[sp.start : sp.end].strip()
            ]
    if raw is None:
        raw = [
            (m.start(), m.end())
            for m in re.finditer(r".*?(?:[.!?][\"')\]]?(?=\s|$)|$)", text)
            if m.group().strip()
        ]
    raw = _mend_word_splits(raw, text)
    raw = _split_on_markers(_split_on_bullets(raw, text), text)
    return _merge_fragments(_split_at(raw, text, hard), text, hard, whole)


def _keep_sentence(text: str, word_count: int, context: int = 0) -> bool:
    """Keep prose and section headings; drop figure/diagram labels and scattered tokens
    (short fragments with no sentence punctuation, e.g. 'Conv1D', 'Cross Attention').
    `context` rescues short prose that this filter would drop. 2: the paragraph also holds a
    full sentence, or is a list or an algorithm cut at its items and steps, so a fragment with
    any word (two letters in a row) is kept - a lead-in cut off by a display equation ('Then
    we have'), a list intro ('We show that:'), a step ('repeat'), a page tail ('In addition,
    high-'). 1: the paragraph sits next to a display equation, so a fragment
    with a lowercase word is kept ('where', 'we get'). Figure labels form paragraphs of their
    own, away from equations, and are still dropped."""
    if word_count >= 5:
        return True
    if context == 2 and re.search(r"[^\W\d_]{2}", text):
        return True
    if context == 1 and any(
        w.isalpha() and w.islower() and len(w) > 1 for w in text.split()
    ):
        return True
    if re.search(r"[.!?][\"')\]]?$", text):  # ends like a sentence
        return True
    if re.search(r"[=∑∫∏√±≈≠≤≥→←⇒∈∉∇∂θελσμβαγδπφψωΩΣ]", text):  # keep equations
        return True
    return bool(
        re.match(r"^\d+(\.\d+)*\s+[A-Za-z]", text)
    )  # section heading "2.2 Training"


def _join_words(widx: list, words: list) -> tuple[str, list]:
    """Build a paragraph's text from its word indices, rejoining words that a line break
    split with a hyphen ('to-' + 'kens' -> 'tokens'). Each word still gets a char range in
    the returned text, so word->sentence mapping (and thus highlighting) stays exact: only
    the hyphen character is dropped. A hyphen is treated as a line-break hyphen when the
    previous token ends '<letter>-' and the next token is a lowercase word on a lower line,
    so real ranges ('2019-') and inline hyphens are left alone."""
    text = ""
    local: list[tuple[int, int, int]] = []
    prev_g: int | None = None
    for g in widx:
        tok = words[g]["t"]
        pt = words[prev_g]["t"] if prev_g is not None else ""
        if (
            prev_g is not None
            and len(pt) >= 2
            and pt.endswith("-")
            and pt[-2].isalpha()
            and tok[:1].isalpha()
            and tok[:1].islower()
            and words[g]["y0"] > words[prev_g]["y0"] + 2  # next word on a lower line
        ):
            text = text[:-2]  # drop trailing 'hyphen + space' -> contiguous join
            ps, pe, pg = local[-1]
            local[-1] = (ps, pe - 1, pg)
        start = len(text)
        text += tok
        local.append((start, len(text), g))
        text += " "
        prev_g = g
    return text, local


# A glyph that can carry a script: a letter or digit, a closing bracket, a prime or star, a
# big operator. An opening bracket or a relation cannot; small text after one is a fraction.
_SCRIPT_BASE_END = ")]}⟩|‖∥′∗*†∑∏∫⋃˜ˆ"


def _script_roles(
    seq: list, words: list, styled: list, line_of: dict, body: float
) -> dict[int, str]:
    """The sub/superscripts of one paragraph (word indices in reading order): {g: "^" | "_"}.

    A script word is set smaller than the body (<= 0.85x) with its baseline above (superscript)
    or below (subscript) the baseline of its line's body-size words. A run of them is marked
    only when it is ATTACHED: right after a body-size glyph that can carry a script, on the
    same line with no gap ("a^j"), or right after or under a marked run ("}^{N neg}_{j=1}").
    A small run after a gap - an inline fraction's numerator and denominator, "≜ β²₁/√β₂" -
    stays unmarked rather than being read as scripts of the word before it."""
    small = 0.85 * body
    ref: dict = {}
    for g in seq:
        if styled[g]["size"] > small:
            ref.setdefault(line_of[g], []).append(styled[g]["base"])
    ref = {ln: statistics.median(b) for ln, b in ref.items()}

    def role(g):
        if styled[g]["size"] > small or line_of[g] not in ref:
            return None
        off = styled[g]["base"] - ref[line_of[g]]
        return "^" if off < -0.15 * body else "_" if off > 0.08 * body else None

    out: dict[int, str] = {}
    i = 0
    while i < len(seq):
        r = role(seq[i])
        if not r:
            i += 1
            continue
        j = i
        while j + 1 < len(seq) and role(seq[j + 1]) == r:
            j += 1
        if i > 0 and line_of[seq[i - 1]] == line_of[seq[i]]:
            b = seq[i - 1]
            gap = words[seq[i]]["x0"] - words[b]["x1"]
            if b in out:
                attached = gap <= 0.25 * body
            else:
                t = words[b]["t"]
                attached = (
                    role(b) is None
                    and styled[b]["size"] > small
                    and (t[-1:].isalnum() or t[-1:] in _SCRIPT_BASE_END)
                    and -0.5 <= gap <= 0.25 * body
                )
            if attached:
                out.update({g: r for g in seq[i : j + 1]})
        i = j + 1
    return out


def _mark_scripts(text: str, s: int, e: int, local: list, marks: dict) -> str:
    """text[s:e].strip() with each run of marked script words wrapped as ^{...} / _{...}."""
    inside = [(a, b, g) for a, b, g in local if a >= s and b <= e]
    ins = []
    for k, (a, b, g) in enumerate(inside):
        r = marks.get(g)
        if not r:
            continue
        if not k or marks.get(inside[k - 1][2]) != r:
            ins.append((a, 1, r + "{"))
        if k + 1 == len(inside) or marks.get(inside[k + 1][2]) != r:
            ins.append((b, 0, "}"))
    out, last = [], s
    for pos, _, mark in sorted(ins):
        out += [text[last:pos], mark]
        last = pos
    out.append(text[last:e])
    return "".join(out).strip()


def _words_with_style(page) -> list[dict]:
    """Words with geometry AND font size in reading order, via get_text('rawdict').

    A word's box spans its own glyphs. Splitting a span by character count is not exact: a
    justified line often comes as ONE span, and the guess drifted up to ~20pt, enough to put a
    sentence's first capital inside the previous sentence's last word (and its highlight). A
    span whose decoded text no longer maps 1:1 onto its glyphs falls back to that split. The
    per-word font size feeds the paragraph font sizing in the panel."""
    out: list[dict] = []
    d = page.get_text("rawdict")
    cmex = _cmex_tables(page)
    for bno, block in enumerate(d.get("blocks", [])):
        if block.get("type") != 0:  # skip images
            continue
        for lno, line in enumerate(block.get("lines", [])):
            for span in line.get("spans", []):
                chars = span.get("chars", [])
                stext = _decode_span(
                    {**span, "text": "".join(c["c"] for c in chars)}, cmex
                )
                if not stext.strip():
                    continue
                exact = len(stext) == len(chars)
                size = span.get("size", 0.0)
                sx0, sy0, sx1, sy1 = span.get("bbox", (0, 0, 0, 0))
                # the span's baseline: it tells a raised or lowered script apart from text
                # that is only set smaller (a glyph box's height depends on the font)
                base = (span.get("origin") or chars[0]["origin"])[1]
                cw = (sx1 - sx0) / len(stext)
                for m in re.finditer(r"\S+\s*", stext):
                    t = m.group(0).strip().translate(_CTRL_STRIP)
                    if not t:
                        continue
                    if exact:
                        glyphs = chars[m.start() : m.start() + len(m.group(0).rstrip())]
                        x0 = min(c["bbox"][0] for c in glyphs)
                        x1 = max(c["bbox"][2] for c in glyphs)
                    else:
                        x0 = sx0 + cw * m.start()
                        x1 = min(sx0 + cw * m.end(), sx1)
                    out.append(
                        {
                            "x0": round(x0, 2),
                            "y0": round(sy0, 2),
                            "x1": round(x1, 2),
                            "y1": round(sy1, 2),
                            "t": t,
                            "size": round(size, 1),
                            "base": round(base, 2),
                            "bno": bno,
                            "lno": lno,
                            # set sideways, like the arXiv stamp along the first page's edge
                            "turned": abs(line.get("dir", (1, 0))[0]) < 0.5,
                        }
                    )
    return out


def _norm_header(text: str) -> str:
    """Normalize a line for running-header matching: its letters only (`_letters`). The page
    number varies, and so does how it is attached: "1:2 • Kerbl et al." on one page, "1:4" and
    "• Kerbl et al." as two lines on another."""
    return _letters(text)


def _letters(text: str) -> str:
    """A line's letters only, case-folded. Two printings of one front-matter line differ in
    spacing, affiliation digits and quotes ("Graph ..." vs "“Graph ...”"), not in letters."""
    return "".join(ch for ch in text.casefold() if ch.isalpha())


# The Abstract heading: "Abstract", "ABSTRACT", "Abstract.", "Abstract:", or run in
# ("Abstract—We ..."). Not "abstracting" in the introduction: 2411.14499 has no Abstract
# heading, and cutting there dropped its abstract and the start of its introduction.
_ABSTRACT_RE = re.compile(r"(?:Abstract|ABSTRACT)(?:[.:—–-].*)?")

# An e-mail domain ("x@mit.edu", "{a, b} @mit.edu"); not "mAP@0.5" or "Recall@1".
_EMAIL = re.compile(r"@ ?[A-Za-z][\w-]*(?:\.[A-Za-z][\w-]*)+")

# A link: a URL with its scheme or "www.", a host with a path ("hf.co/x", "github.com/x"), or a
# bare host on a common domain ("example.org"). A scheme cut off by a space ("https: //...")
# leaves "https:" behind, which counts as part of the link.
_URL = re.compile(
    r"(?:https?://|www\.)\S+|\bhttps?:|\b[\w-]+(?:\.[\w-]+)*\.[A-Za-z][\w-]*/\S*"
    r"|\b[\w-]+(?:\.[\w-]+)*\.(?:com|org|net|io|ai|edu|gov|fr|de|cn|uk|co)\b"
)


def _link_only(text: str) -> bool:
    """A footnote sentence that is only a link, perhaps with its number and a short label
    ("1 Code: https://...", "3 Code release: https://...", "5. hf.co/..."): with the links
    out, two words or fewer are left. Its translation would be the same link; one with prose
    ("1 The code is available at https://...") is translated."""
    if not _URL.search(text):
        return False
    rest = _URL.sub(" ", text)
    if re.search(r"[\u3040-\u30ff\u3400-\u9fff]{3}", rest):
        return False  # Chinese or Japanese prose has no spaces to count words by
    return len([w for w in rest.split() if re.search(r"[^\W\d_]{2}", w)]) <= 2


# Footnote mark symbols. Numbers are left out: an affiliation number on an author ("Ann Lee¹")
# and the first footnote of the text ("... GPUs.¹" + "¹Code is at ...") share "1".
_MARKS = "*∗⋆†‡§¶‖#"


def _mark(ch: str) -> str:
    """A mark symbol with both asterisks as one: an author line's "∗" may mark a "*" note."""
    return "*" if ch == "∗" else ch


def _numbered_note(ws: list[dict]) -> bool:
    """A line of words (with sizes) opens with a footnote number or letter, set smaller than the
    rest of the line ("¹Code is at ...")."""
    return (
        len(ws) > 1
        and bool(re.fullmatch(r"\d{1,2}|[a-z]", ws[0]["t"]))
        and ws[0]["size"] < 0.85 * statistics.median(w["size"] for w in ws[1:])
    )


def _marked_note(t: str) -> bool:
    """A word opens with a footnote mark symbol ("†Work done ..."), not a sign before a number
    ("§4.2", "#3") or a sign of the text ("#tokens", "‖x‖")."""
    return (
        t[0] in _MARKS
        and not t[1:2].isdigit()
        and (t[0] not in "#‖" or not t[1:2].islower())
    )


def _front_cut(words: list[dict], height: float) -> float:
    """Where page 0's front matter (title, authors, affiliations) ends: the top of the Abstract
    heading (the first word of its line), else 22% down the page. `words` carry t, y0, line."""
    prev = None
    for w in words:
        if w["line"] != prev and _ABSTRACT_RE.fullmatch(w["t"]):
            return w["y0"]
        prev = w["line"]
    return height * 0.22


# A row of a list of symbols opens with its symbol ("α  the learning rate . . . 12", "x  an
# input . . . 3"), and a contents entry with a title or a number ("A Proofs", "2.1 Results").
_SYMBOL_ROW = re.compile(r"[a-z]|[^\W\d_A-Za-z]{1,2}|[^\w\s]")


def _toc_lines(
    lines: list[dict],
    words: list[dict],
    page_count: int,
    title_rects: list,
    heads: set[int] | frozenset[int] = frozenset(),
    page=None,
) -> set[int]:
    """Indices of `lines` that make up a table of contents (or a list of figures/tables),
    and the list's own heading (a line in `title_rects`) right above it ("Contents", "List
    of Tables"); a chapter title over a chapter's short contents stays. An entry ends in a
    page number set apart from its title, after a dot leader or a wide gap ("3.1 Results . .
    . 10", "1 Introduction 4"); a number on a line of its own pairs with the nearest line to
    its left, which must hold a title or a leader, so a row of numbers (axis ticks, table
    cells) is no entry, and neither is a row of a list of symbols, which opens with its
    symbol ("α", "x"). On a page set in two columns (_two_columns of `page`), a title with
    no dot leader is in its number's column: a number in the other column beside prose (a
    plot's ticks, a rank) is no entry. A page is a contents page when five or more rows hold
    entries that follow on without a wide gap, and their numbers mostly go up in reading
    order; a table typed as text rarely does both, and the lines a table box covers are gone
    by now. Two rows, one with a dot leader, are enough right below a "Contents" heading:
    the contents may start at a page's foot. A running head or foot (`heads`, indices of
    `lines`) is never an entry. In each column of entries, from its first entry's row to its
    last one's, everything goes, wrapped entries included (a first title that wraps above
    its number's row too, up to a heading, and a last one whose title runs up to its number
    below); text below the last entry, or beside the entries in the other column, stays. It
    runs before page numbers go: the model may call an entry's number furniture."""
    # (number, its line, the entry's lines), and the entries with a dot leader
    entries: list[tuple[int, int, list[int]]] = []
    dotted: set[int] = set()
    split: list[bool] = []  # _two_columns(page), worked out once if it is needed

    def symbol_row(j: int) -> bool:
        """The row of line `j` opens with a symbol, on that line or on one just left of it."""
        o = lines[j]
        lead = [
            q
            for q in lines
            if q is not o
            and abs(q["cy"] - o["cy"]) < o["h"] / 2
            and o["left"] - 60 <= q["right"] <= o["left"]
        ]
        first = min(lead, key=lambda q: q["left"]) if lead else o
        return bool(_SYMBOL_ROW.fullmatch(words[first["widx"][0]]["t"]))

    for i, ln in enumerate(lines):
        ws = ln["widx"]
        m = re.fullmatch(r"(\.*)(\d{1,4})", words[ws[-1]]["t"])
        if not m or not 1 <= int(m.group(2)) <= page_count + 10:
            continue
        if i in heads:
            continue
        if len(ws) > 1:
            if symbol_row(i):
                continue
            prev = words[ws[-2]]
            leader = (
                m.group(1)
                or re.fullmatch(r"\.+", prev["t"])
                or prev["t"].endswith("...")
            )
            if not leader and words[ws[-1]]["x0"] - prev["x1"] < 1.5 * ln["size"]:
                continue
            if leader:
                dotted.add(i)
            row = [i]
        else:
            beside = [
                j
                for j, o in enumerate(lines)
                if j != i
                and abs(o["cy"] - ln["cy"]) < ln["h"] / 2
                and o["right"] <= ln["left"]
            ]
            if not beside:
                continue  # a bare number with no title beside it
            j = max(beside, key=lambda j: lines[j]["right"])
            title = lines[j]["text"]
            mid = page.rect.width / 2 if page is not None else 0
            if (
                page is not None
                and (lines[j]["cx"] > mid) != (ln["cx"] > mid)
                and not re.search(r"\.\s*\.$", title)
            ):
                if not split:
                    split.append(_two_columns(page))
                if split[0]:
                    continue  # beside a line of the other column
            if not re.search(r"[^\W\d_]|\.\s*\.$", title):
                continue
            if j in heads or symbol_row(j):
                continue
            if re.search(r"\.\s*\.$", title):
                dotted.add(i)
            row = [j, i]
        entries.append((int(m.group(2)), i, row))
    titled = [
        o["bottom"]
        for o in lines
        if re.fullmatch(r"(?:table of )?contents", o["text"].strip(), re.IGNORECASE)
        and _in_rects(o["cx"], o["cy"], title_rects)
    ]
    if len(entries) < (2 if titled else 5):
        return set()
    # the longest run of entries with no wide gap between two of them
    entries.sort(key=lambda e: lines[e[1]]["top"])
    tops = [lines[i]["top"] for _, i, _ in entries]
    steps = [b - a for a, b in zip(tops, tops[1:])]
    wide = max(
        3 * statistics.median(steps), 3 * statistics.median(ln["h"] for ln in lines)
    )
    runs = [[entries[0]]]
    for e, step in zip(entries[1:], steps):
        if step > wide:
            runs.append([])
        runs[-1].append(e)
    run = sorted(max(runs, key=len), key=lambda e: e[1])  # back in reading order
    n_rows = len({round(lines[i]["cy"]) for _, i, _ in run})
    first = lines[run[0][1]]
    if n_rows < 5 and not (
        n_rows >= 2
        and any(i in dotted for _, i, _ in run)
        and any(0 <= first["top"] - b + 1 <= 3 * first["h"] for b in titled)
    ):
        return set()
    vals = [v for v, _, _ in run]
    if len(set(vals)) < min(3, n_rows):
        return set()  # a column of one number is a table's, not page numbers
    if sum(b >= a for a, b in zip(vals, vals[1:])) < 0.8 * (len(vals) - 1):
        return set()
    # one band per column of entries: contents that fill one column and run on in the next
    # stand beside text that is not theirs (a figure, the start of the introduction)
    span = {
        i: (min(lines[j]["left"] for j in row), max(lines[j]["right"] for j in row))
        for _, i, row in run
    }
    groups: list[list[tuple[int, int, list[int]]]] = []
    edge = 0.0
    for e in sorted(run, key=lambda e: span[e[1]][0]):
        if not groups or span[e[1]][0] >= edge:
            groups.append([])
            edge = span[e[1]][1]
        groups[-1].append(e)
        edge = max(edge, span[e[1]][1])
    out: set[int] = set()
    for group in groups:
        group.sort(key=lambda e: e[1])  # reading order
        vals = [v for v, _, _ in group]
        rows = [lines[j] for _, _, row in group for j in row]
        top, bottom = min(o["top"] for o in rows), max(o["bottom"] for o in rows)
        # an entry whose long title runs up to its number ("C Further Results on ... Tasks
        # 48"): a line right below, ending at the page-number column with a number that goes on
        col = max(lines[i]["right"] for _, i, _ in group)
        tops = sorted(lines[i]["top"] for _, i, _ in group)
        steps = [b - a for a, b in zip(tops, tops[1:])]
        pitch = min(max(steps), 2.5 * statistics.median(steps)) if steps else 0.0
        low = tops[-1]
        grew = True
        while grew:
            grew = False
            for ln in lines:
                last = words[ln["widx"][-1]]["t"]
                if (
                    low < ln["top"] <= low + pitch + 1
                    and abs(ln["right"] - col) <= 3
                    and re.fullmatch(r"\d{1,4}", last)
                    and vals[-1] <= int(last) <= page_count + 10
                ):
                    rows.append(ln)
                    low, bottom = ln["top"], max(bottom, ln["bottom"])
                    vals.append(int(last))
                    grew = True
        left, right = min(o["left"] for o in rows), max(o["right"] for o in rows)
        # the first entry's title may wrap above its number's row: up to three lines right
        # above, back to the one that opens with an entry's number ("2.1 Two simple ...")
        upper = min(o["cy"] for o in rows)
        for _ in range(3):
            near = [
                o
                for o in lines
                if upper - pitch - 1 <= o["cy"] < upper - 1
                and o["right"] > left - 30
                and o["left"] < right
            ]
            if not near:
                break
            # the next row up, with its number if that is a line of its own
            row_cy = max(o["cy"] for o in near)
            row = [o for o in near if row_cy - o["cy"] < o["h"] / 2]
            if any(_in_rects(o["cx"], o["cy"], title_rects) for o in row):
                break  # a heading is no wrapped title
            upper = min(o["cy"] for o in row)
            wrap = min(row, key=lambda o: o["left"])
            label = words[wrap["widx"][0]]["t"]
            if re.fullmatch(r"(?:\d{1,2}|[A-Z]\.\d{1,2})(?:\.\d{1,2})*\.?", label):
                top = min([top] + [o["top"] for o in row])
                break
        band = {
            j
            for j, o in enumerate(lines)
            if top - 1 <= o["cy"] <= bottom + 1 and left - 30 <= o["cx"] <= right + 5
        }
        above = [
            j
            for j, o in enumerate(lines)
            if j not in band
            and o["bottom"] <= top + 1
            and o["right"] > left
            and o["left"] < right
        ]
        if above:
            j = max(above, key=lambda j: lines[j]["bottom"])
            o = lines[j]
            if (
                _in_rects(o["cx"], o["cy"], title_rects)
                and len(o["widx"]) <= 4
                and re.search(r"contents|^list of", o["text"].strip(), re.IGNORECASE)
            ):
                band.add(j)
        out |= band
    return out


def _front_matter(page) -> set[str]:
    """The letters (`_letters`) of each line of page 0 above the cut (`_front_cut`)."""
    words = [
        {"y0": w[1], "y1": w[3], "t": w[4], "line": (w[5], w[6])}
        for w in page.get_text("words")
    ]
    cut = _front_cut(words, page.rect.height)
    lines: dict[tuple, list[dict]] = {}
    for w in words:
        lines.setdefault(w["line"], []).append(w)
    out = set()
    for ws in lines.values():
        t = _letters(" ".join(w["t"] for w in ws))
        if all(w["y1"] <= cut for w in ws) and len(t) >= 8:
            out.add(t)
    return out


@functools.lru_cache(maxsize=2)
def _document_front_matter(pdf_bytes: bytes) -> frozenset[str]:
    """`_front_matter` of a document's page 0, kept for the document in hand: layout() lays out
    a page and its two neighbours, and each asks for it."""
    doc = pymupdf.open(stream=pdf_bytes, filetype="pdf")
    try:
        return frozenset(_front_matter(doc[0]))
    finally:
        doc.close()


def running_headers(pdf_bytes: bytes) -> set[str]:
    """Normalized text of lines that repeat at the top or bottom across pages — i.e. the
    running header/footer (paper title, 'A PREPRINT', venue, page furniture). Computed once
    per document; the caller caches it and passes it to layout() to drop these lines."""
    doc = pymupdf.open(stream=pdf_bytes, filetype="pdf")
    try:
        n = doc.page_count
        if n < 3:
            return set()
        top: dict[str, int] = {}
        bot: dict[str, int] = {}
        sample = list(range(min(n, 12)))
        for pno in sample:
            page = doc[pno]
            h = page.rect.height
            for block in page.get_text("dict").get("blocks", []):
                if block.get("type") != 0:
                    continue
                for line in block.get("lines", []):
                    txt = "".join(
                        s.get("text", "") for s in line.get("spans", [])
                    ).strip()
                    norm = _norm_header(txt)
                    if len(norm) < 4:
                        continue
                    y0, y1 = (
                        line.get("bbox", (0, 0, 0, 0))[1],
                        line.get("bbox", (0, 0, 0, 0))[3],
                    )
                    # the bands layout() drops a running head in (3DGS's footer ends at 90.3%)
                    if y0 < h * 0.12:
                        top[norm] = top.get(norm, 0) + 1
                    elif y1 > h * 0.90:
                        bot[norm] = bot.get(norm, 0) + 1
        # Headers often alternate (author names on even pages, title on odd), so each
        # appears on only ~half the pages; require a third of the sample, not a half.
        thr = max(2, round(len(sample) / 3))
        return {t for t, c in top.items() if c >= thr} | {
            t for t, c in bot.items() if c >= thr
        }
    finally:
        doc.close()


# The references heading, alone on its line: "References", "REFERENCES", "7 References",
# "References and Notes", "Bibliography". Matched at any readable size. Acknowledgements,
# funding and the like are translated. A line of prose that starts with the word is not the
# heading: "reference of 17,135 actions." cost 2610.02200 ten pages of results, and a figure
# label "reference" cost 2610.10489 its Methods.
_REF_RE = re.compile(
    r"(?:\d+\.?\s+|[IVX]+\.\s+)?"
    r"(?:R ?(?i:eferences?(?:\s+and\s+notes)?)|B(?i:ibliography))\s*[.:]?"
)
# A line of a reference list: a year, an entry number ("[12] ..."), arXiv/doi/a URL, "et al",
# "Proceedings"/"Proc.", or a page range ("pp. 12"). On every reference page of 31 papers a
# quarter of the lines or more have one; a page of figures or prose after them has almost none.
_BIB_RE = re.compile(
    r"\b(?:19|20)\d{2}[a-z]?\b|^\[\d+\]|arXiv|doi|https?://|\bet al\b|\bProc\.|"
    r"\bProceedings\b|\bpp\. ?\d"
)
# An appendix / supplementary section that follows the references — real content, kept.
# Matches "Appendix", "Supplementary ...", a lone section letter ("A", "B"), or "A Title".
# The words in any case ("APPENDIX A", "Supplementary Material"); the letter forms stay
# uppercase, so a lowercase line ("a note on ...") is not taken for a section letter.
_APPENDIX_RE = re.compile(r"^((?i:appendix|supplementary)\b|[A-Z]\.?\s+[A-Z]|[A-Z]$)")
# A page number ("12", "1:4" in ACM's "1:4 • Kerbl et al.", "xii") or a line without a letter
# or digit ("•", "□").
_PAGE_NUMBER = re.compile(r"\W*|\d+(?:[:.–-]\d+)*|[ivxlcdm]+|[IVXLCDM]+")
# A figure/table caption's label: "Table 5.", "TABLE V:", "Figure 3:", "Fig. 2", "F IG . 1:".
_CAPTION_LABEL = re.compile(
    r"(?:Table|TABLE|Fig(?:ure)?\.?|FIG(?:URE)?\.?|F IG \.)\s*(?:[A-Z]?\d+|[IVX]+\b)"
)

# Position in the document as (page_index, y, x): a heading's top and its LINE's left edge,
# the same x that places a word in its column (_skipped), so the two always compare alike.
Pos = tuple[int, float, float]
SkipRange = tuple[Pos, Pos | None]  # (start, end-exclusive); end None = to document end


def _two_columns(page) -> bool:
    """True when the page's prose is set in two columns: most of its wide text lines stay on
    one side of the page's middle (a one-column page's lines run across it)."""
    w = page.rect.width
    sides = [
        x1 < w / 2 + 5 or x0 > w / 2 - 5
        for block in page.get_text("dict").get("blocks", [])
        if block.get("type") == 0
        for x0, _, x1, _ in (line["bbox"] for line in block.get("lines", []))
        if x1 - x0 > 0.3 * w
    ]
    return bool(sides) and sum(sides) >= 0.7 * len(sides)


def _reading_key(y: float, x: float, width: float, two_col: bool) -> tuple[int, float]:
    """Where a line starting at x falls in a page's reading order: column first, then height.
    On a two-column page the whole left column is read before the right one, so "below" a
    heading in the right column does not include the left column's foot. The column split is
    _two_columns' own (a right-column line starts past the middle less 5pt); a line across
    both columns starts on the left and reads before them."""
    return (int(two_col and x > width / 2 - 5), y)


def end_matter_range(
    pdf_bytes: bytes, headers: set[str] | None = None
) -> SkipRange | None:
    """The span of end matter to skip in translation: from the References heading to the start
    of the appendix that follows it (exclusive), or to the document end when no appendix
    follows. Returns (start, end) as (page, y, x) positions, or None if there is no such
    section. An appendix after the references IS kept — it is real content. Page 0 is
    excluded. Running-header lines (e.g. 'A PREPRINT') are ignored so they are not mistaken for
    an appendix start that would leak the references. On a two-column page the first heading
    is the first in reading order, not the topmost."""
    hdrs = headers or set()
    doc = pymupdf.open(stream=pdf_bytes, filetype="pdf")
    try:
        n = doc.page_count

        # Each page's lines and column count are read once: the checks below go over the same
        # pages several times.
        page_lines: dict[int, list[tuple[str, float, float, float]]] = {}
        page_two: dict[int, bool] = {}

        def headings(pno) -> list[tuple[str, float, float, float]]:
            """A page's lines as (text, size, y, x), less its running heads."""
            if pno not in page_lines:
                out = []
                for block in doc[pno].get_text("dict").get("blocks", []):
                    if block.get("type") != 0:
                        continue
                    for line in block.get("lines", []):
                        spans = line.get("spans", [])
                        t = "".join(s.get("text", "") for s in spans).strip()
                        if (
                            _norm_header(t) in hdrs
                        ):  # a running head, not a section title
                            continue
                        sz = max((s.get("size", 0.0) for s in spans), default=0.0)
                        x0, y0, _, _ = line.get("bbox", (0, 0, 0, 0))
                        out.append((t, sz, y0, x0))
                page_lines[pno] = out
            return page_lines[pno]

        def two_col(pno) -> bool:
            if pno not in page_two:
                page_two[pno] = _two_columns(doc[pno])
            return page_two[pno]

        def before(pno, y, x, pos: Pos) -> bool:
            return _before(doc[pno], (y, x), pos, two_col(pno))

        def first(pno, found):
            """The first of `found` [(y, x)] in the page's reading order, as a Pos."""
            w, two = doc[pno].rect.width, two_col(pno)
            y, x = min(found, key=lambda p: _reading_key(p[0], p[1], w, two))
            return (pno, y, x)

        def text_lines(pno, after: Pos | None = None) -> list[str]:
            """The lines of three words or more on a page (after `after`, if given)."""
            return [
                t
                for t, sz, y, x in headings(pno)
                if len(t.split()) >= 3
                and (after is None or not before(pno, y, x, after))
            ]

        def bibliographic(lines: list[str]) -> bool:
            return sum(bool(_BIB_RE.search(t)) for t in lines) >= 0.1 * len(lines)

        # The References heading, if a reference list follows it.
        start: Pos | None = None
        for pno in range(1, n):
            found = [
                (y, x)
                for t, sz, y, x in headings(pno)
                if sz >= 7 and _REF_RE.fullmatch(t)
            ]
            if found:
                pos = first(pno, found)
                after = text_lines(pno, pos)
                if pno + 1 < n:
                    after += text_lines(pno + 1)
                if after and bibliographic(after):
                    start = pos
                    break
        if start is None:
            return None

        # Resume point: the first appendix/supplementary heading after the references. It
        # stands out from the reference list (its median size + 1pt; 11pt always does): 3DGS
        # and 2411.14499 set the letter "A" at 10pt over 7-8pt references.
        sizes = [
            sz
            for t, sz, y, x in headings(start[0])
            if t and not before(start[0], y, x, start)
        ]
        if start[0] + 1 < n:
            sizes += [sz for t, sz, y, x in headings(start[0] + 1) if t]
        big = min(11.0, statistics.median(sizes) + 1) if sizes else 11.0
        end: Pos | None = None
        for pno in range(start[0], n):
            found = [
                (y, x)
                for t, sz, y, x in headings(pno)
                if sz >= big
                and len(t.split()) <= 7
                and _APPENDIX_RE.match(t)
                and not (pno == start[0] and before(pno, y, x, start))
            ]
            if found:
                end = first(pno, found)
                break
        # A whole page that is not a reference list ends the range at its top, whatever its
        # headings: the Transformer paper's attention visualizations (an appendix titled
        # "Attention Visualizations") were skipped to the end of the document.
        for pno in range(start[0] + 1, end[0] if end else n):
            lines = text_lines(pno)
            if lines and not bibliographic(lines):
                end = (pno, 0.0, 0.0)
                break
        return (start, end)
    finally:
        doc.close()


def _before(
    page, point: tuple[float, float], pos: Pos, two_col: bool | None = None
) -> bool:
    """True when `point` (y, x of its line's left edge) on `pos`'s page comes before the heading
    at `pos` in reading order. 2pt of slack: a heading split into lines ("A" + "Implementation Details") has lines
    whose tops differ by a hair, and all of it belongs to the heading."""
    w = page.rect.width
    two = _two_columns(page) if two_col is None else two_col
    col, y = _reading_key(point[0], point[1], w, two)
    pcol, py = _reading_key(pos[1], pos[2], w, two)
    return col < pcol or (col == pcol and y < py - 2)


def _in_rects(cx: float, cy: float, rects: list) -> bool:
    return any(r.x0 <= cx <= r.x1 and r.y0 <= cy <= r.y1 for r in rects)


def _ends_sentence(text: str) -> bool:
    """Terminal punctuation, optionally followed by closing quotes/brackets (straight, curly, or
    spaced apart by the PDF: ". )") and a footnote mark ("available.1", ".†")."""
    return bool(re.search(r"[.!?](?:\s*[\"'”’)\]])*(?:\d{1,2}|[*∗†‡])?$", text.strip()))


def _starts_lower(text: str) -> bool:
    t = text.strip()
    return bool(t) and t[0].isalpha() and t[0].islower()


def _tail_idx(page: dict) -> int | None:
    """Index of a page's last sentence that is not an aside (a footnote or a rescued caption,
    read after the page's text): a sentence the page break cuts continues past them."""
    for j in range(len(page["sentences"]) - 1, -1, -1):
        if not page["sentences"][j].get("aside"):
            return j
    return None


def _tail_unfinished(page: dict) -> bool:
    """True when a page's last sentence is a prose fragment that wraps to the next page. It
    must be a real mid-sentence break: not a heading or equation, no terminal punctuation, and
    ending in a lowercase letter or comma. This excludes equations (end in a symbol/number),
    captions and sentences closing on a citation bracket or a colon — which are complete even
    without a period — so their following page is never stitched onto them."""
    j = _tail_idx(page)
    if j is None:
        return False
    last = page["sentences"][j]
    if last.get("heading") or last.get("equation"):
        return False
    t = last["text"].rstrip()
    if not t or _ends_sentence(t):
        return False
    # ...or a word the page break split with a hyphen ("to extract fea-" + "tures from")
    return t[-1].islower() or t[-1] == "," or bool(re.search(r"[^\W\d_]-$", t))


def _continuation_idx(page: dict, max_scan: int = 16) -> int | None:
    """Index of the sentence that continues a wrap from the previous page: the first prose
    sentence that starts lowercase (a mid-sentence continuation). Float captions a page drops at
    the top (a whole figure/table block, e.g. "Figure 7. ... Columns 1-4 show ...") start
    uppercase, so they are skipped and the continuation after them is still found — the scan is
    wide enough to clear such a block. But a heading STOPS the scan (returns None): a new section
    cannot be the continuation of the previous page's dangling sentence. Equations are skipped.
    Returns None if there is no such sentence."""
    seen = 0
    for j, s in enumerate(page["sentences"]):
        if s.get("heading"):
            return None  # a new section starts before any continuation → no stitch
        if s.get("caption") or s.get("aside"):
            continue  # a caption or a footnote: never the continuation, not counted
        if seen >= max_scan:
            return None
        seen += 1
        if s.get("equation"):
            continue
        prev_para = page["sentences"][j - 1].get("para") if j else None
        if prev_para is not None and prev_para == s.get("para"):
            continue  # mid-paragraph: not where a wrapped sentence resumes
        if _starts_lower(s["text"]):
            return j
    return None


def _tail_open(page: dict) -> bool:
    """True when a page's last sentence is prose that does not end a sentence at all (no .!? and
    no closing colon). Wider than _tail_unfinished: it also admits a tail closing on ')' or an
    uppercase acronym ("...Modulation (FiLM)"), which may only be stitched to a citation."""
    j = _tail_idx(page)
    if j is None:
        return False
    last = page["sentences"][j]
    if last.get("heading") or last.get("equation"):
        return False
    t = last["text"].rstrip()
    return bool(t) and not _ends_sentence(t) and not t.endswith(":")


def _stitch_idx(prev: dict, nxt: dict) -> int | None:
    """Index of the sentence on `nxt` that continues the last sentence of `prev`, or None. Used by
    BOTH the forward and the backward pass, so the two pages always agree. Besides the lowercase
    continuation (_tail_unfinished + _continuation_idx), a sentence the page break cut right before
    an inline author-year citation ("...Modulation (FiLM)" | "Perez et al. (2018) as well as ...")
    is joined: the next page's FIRST prose sentence (no float caption skipped) must start with
    such a citation, which a new sentence practically never does after an open tail."""
    if _tail_unfinished(prev):
        j = _continuation_idx(nxt)
        if j is not None:
            return j
    if _tail_open(prev):
        for j, s in enumerate(nxt["sentences"]):
            if s.get("equation") or s.get("aside"):
                continue
            if s.get("heading"):
                return None
            t = s["text"]
            return j if _starts_citation(t, (0, len(t))) else None
    return None


def layout(
    pdf_bytes: bytes,
    page_index: int,
    headers: set[str] | None = None,
    skip: SkipRange | None = None,
) -> dict:
    """Per-page layout with cross-page sentence stitching. A sentence that wraps across the
    page break is kept whole on the page where it STARTS: that page absorbs the continuation
    fragment from the next page (recording its geometry under `words_next` so a highlight can
    span both pages), and the next page drops that fragment so it is not shown or translated
    twice. The continuation is found by the same rule from both sides (`_stitch_idx`: the
    previous page's tail is unfinished and this page's first lowercase-starting sentence is the
    continuation, or the tail is open and this page's first prose sentence starts with an
    author-year citation), so the two pages always agree — even when a float caption sits
    between them."""
    core = _page_layout(pdf_bytes, page_index, headers, skip)
    doc = pymupdf.open(stream=pdf_bytes, filetype="pdf")
    try:
        n = doc.page_count
    finally:
        doc.close()
    # Forward runs BEFORE backward, so it tests this page's ORIGINAL tail — the same view the
    # next page's backward pass uses — keeping the two pages' decisions consistent. If our
    # tail is open, absorb the next page's continuation fragment (if any) so the sentence reads
    # whole here.
    if page_index + 1 < n and _tail_open(core):
        nxt = _page_layout(pdf_bytes, page_index + 1, headers, skip)
        j = _stitch_idx(core, nxt)
        if j is not None:
            frag = nxt["sentences"][j]
            last = core["sentences"][_tail_idx(core)]
            tail = last["text"]

            # Rejoin a word the page break split with a hyphen ("applicabil-" + "ity").
            def _join(a: str, b: str) -> str:
                return a[:-1] + b if re.search(r"[a-z]-$", a) else (a + " " + b).strip()

            if "tex" in last or "tex" in frag:
                last["tex"] = _join(
                    last.get("tex", tail), frag.get("tex", frag["text"])
                )
            last["text"] = _join(tail, frag["text"])
            last["cont_next_page"] = page_index + 1
            last["words_next"] = [
                {k: nxt["words"][i][k] for k in ("x0", "y0", "x1", "y1")}
                for i in frag["words"]
            ]
    # Backward: if the previous page's (original) tail continues onto this page, our
    # continuation sentence belongs to that page — drop it here so it is not shown or
    # translated twice.
    if page_index > 0 and core["sentences"]:
        prev = _page_layout(pdf_bytes, page_index - 1, headers, skip)
        j = _stitch_idx(prev, core)
        if j is not None:
            del core["sentences"][j]
    return core


def _joins_line(prev: dict, nxt: dict) -> bool:
    """True when `nxt` continues the same visual line as `prev` (both are line dicts with
    left/right/top/bottom/size/h/cy). Fragments on one baseline separated by a small gap join.
    So does a narrow glyph fragment that touches `prev` and overlaps it vertically: a radical,
    integral, or large operator is drawn well above or below the baseline, so its center sits
    too far from the line's to pass the baseline test (e.g. "O(" then a raised "√" in "O(√d)").
    A fragment that opens with a stacked subscript ("{ã^j}_{j=1}^{N}" + "are used") starts under
    the superscript that ends `prev`, so it may start up to 2.5 em left of prev's end.
    The width guard keeps a two-column row apart; its halves are wide and far apart."""
    size = prev["size"] or nxt["size"] or 10
    gap = nxt["left"] - prev["right"]
    sizes = nxt.get("sizes") or []
    back = size * (2.5 if sizes and sizes[0] <= 0.85 * size else 1)
    if not -back <= gap <= size * 1.8:
        return False
    if abs(nxt["cy"] - prev["cy"]) <= max(prev["h"], nxt["h"]) * 0.6:
        return True
    narrow = nxt["right"] - nxt["left"] <= size * 1.5
    touching = abs(gap) <= size * 0.5
    overlap = min(prev["bottom"], nxt["bottom"]) - max(prev["top"], nxt["top"]) > 0
    return narrow and touching and overlap


def _line_gap(upper: dict, lower: dict) -> float:
    """Vertical gap between two lines, measured on their typical glyphs (median top/bottom of
    the words) so one raised or lowered glyph — a radical, integral, or large operator — does
    not make adjacent lines look overlapping and break the paragraph between them."""
    return statistics.median(lower["y0"]) - statistics.median(upper["y1"])


_EQNO = re.compile(r"\(\s*(\d+(?:\.\d+)?[a-z]?)\s*\)")


def _attach_equation_numbers(lines: list[dict]) -> list[dict]:
    """Move each lone equation number line ('(1)', '(4a)', '(2.3)') onto the display-equation
    line it sits level with, as that line's "eqno", and drop the number line. Alone, a number
    is a one-token fragment that the short-fragment filter discards, so equations lost their
    numbers. A number with no equation beside it is left as it was."""
    out = []
    equations = [ln for ln in lines if ln.get("math")]
    for ln in lines:
        m = _EQNO.fullmatch(ln["text"].strip())
        if m and not ln.get("math"):
            best, score = None, None
            for eq in equations:
                if eq.get("eqno"):
                    continue
                ov = min(eq["bottom"], ln["bottom"]) - max(eq["top"], ln["top"])
                candidate = (ln["left"] - eq["right"], -ov)
                if (
                    ov > 0
                    and eq["right"] <= ln["left"] + 2
                    and (score is None or candidate < score)
                ):
                    best, score = eq, candidate
            if best is not None:
                best["eqno"] = m.group(1)
                continue
        out.append(ln)
    return out


def _page_layout(
    pdf_bytes: bytes,
    page_index: int,
    headers: set[str] | None = None,
    skip: SkipRange | None = None,
) -> dict:
    """Word-level geometry + sentence grouping for one page (no cross-page stitching).

    Returns {width, height, words:[{x0,y0,x1,y1,t}], sentences:[{text, words:[idx,...]}]}.
    Coordinates are in PDF points (top-left origin), matching a pdf.js viewport scaled by s
    (left=x0*s, top=y0*s). Sentence boundaries fall between words, so assigning each word to
    the sentence its char-range overlaps is exact — no line-level bleed.
    """
    doc = pymupdf.open(stream=pdf_bytes, filetype="pdf")
    try:
        page = doc[page_index]
        pw, ph = page.rect.width, page.rect.height

        # End matter (references/acknowledgements/funding) is not translated. `skip` is a
        # (start, end) range in reading order; a page wholly inside it is empty, and on its
        # boundary pages the words inside the range are dropped. An appendix after the range
        # is outside it and stays translatable. Reading order is column-aware (_before).
        two_col = (
            _two_columns(page)
            if skip is not None and page_index in (skip[0][0], skip[1] and skip[1][0])
            else False
        )

        def _skipped(w) -> bool:
            if skip is None:
                return False
            start, end = skip
            # a word's column is its LINE's: a caption across both columns starts on the left
            # and is read before both, though half of its words lie over the right column
            at = (w["y0"], line_x[(w["bno"], w["lno"])][0])
            if page_index < start[0] or (
                page_index == start[0] and _before(page, at, start, two_col)
            ):
                return False
            if end is None or page_index < end[0]:
                return True
            return page_index == end[0] and _before(page, at, end, two_col)

        if skip is not None:
            sp, end = skip[0][0], skip[1]
            fully_inside = sp < page_index and (end is None or page_index < end[0])
            if fully_inside:
                return {
                    "width": round(pw, 2),
                    "height": round(ph, 2),
                    "words": [],
                    "sentences": [],
                }

        ml, mr, mt, mb = (
            44,
            20,
            38,
            32,
        )  # margins: arXiv stamp, page numbers, running heads

        # The layout model is required (enforced at startup): it types every region
        # (title/body/figure/table/formula/furniture) from the rendered page. The text and word
        # coordinates still come from PyMuPDF, so highlighting is unchanged — the model only says
        # WHAT each area is. No heuristic region detectors: they overfit one paper's layout and
        # can emit a full-width false-positive band that swallows real body text and a heading.
        yregions = layout_model.detect_page(page) or []

        def _rects(roles):
            return [
                pymupdf.Rect(r["x0"], r["y0"], r["x1"], r["y1"])
                for r in yregions
                if r["role"] in roles
            ]

        keep_rects = _rects({"body", "title", "caption"})
        title_rects = _rects({"title"})
        caption_rects = _rects({"caption"})
        formula_rects = _rects({"formula"})

        # The model's "abandon" class holds running heads and page numbers, but also footnotes
        # and now and then a heading it mistook, so a furniture box drops nothing by itself:
        # what goes is decided by the text (repetition, a bare page number) further down.
        def _conf_at(cx: float, cy: float, roles: set[str]) -> float:
            """The highest confidence of a `roles` box over the point; 0 when there is none."""
            return max(
                (
                    r.get("conf", 1.0)
                    for r in yregions
                    if r["role"] in roles
                    and r["x0"] <= cx <= r["x1"]
                    and r["y0"] <= cy <= r["y1"]
                ),
                default=0.0,
            )

        regions = _rects({"figure", "table"})

        styled = _words_with_style(page)
        # A caption the model left inside its table/figure box ("Table 5. Error rates ...") is
        # kept: a PDF block whose first line opens with a caption label is never dropped, nor
        # is such a line inside a block of table cells (the PDF may put both in one block).
        line_words: dict[tuple, list[str]] = {}
        for w in styled:
            line_words.setdefault((w["bno"], w["lno"]), []).append(w["t"])
        label_lines = {
            k for k, ts in line_words.items() if _CAPTION_LABEL.match(" ".join(ts))
        }
        label_blocks = {
            b
            for b, lno in label_lines
            if lno == min(n for c, n in line_words if c == b)
        }
        # A word in a side margin goes only when its whole line is there (the arXiv stamp, line
        # numbers): on a narrow page a body line starts inside the 44pt margin, and its first
        # word ("to") must stay.
        line_x: dict[tuple, tuple[float, float]] = {}
        for w in styled:
            x0, x1 = line_x.get((w["bno"], w["lno"]), (w["x0"], w["x1"]))
            line_x[(w["bno"], w["lno"])] = (min(x0, w["x0"]), max(x1, w["x1"]))

        def _in_drop_region(w) -> bool:
            cx, cy = (w["x0"] + w["x1"]) / 2, (w["y0"] + w["y1"]) / 2
            # A region the model typed as text/caption wins over an overlapping figure/table box:
            # tables and figures sometimes bleed into the adjacent column at their edges.
            if _in_rects(cx, cy, keep_rects):
                return False
            return any(r.x0 <= cx <= r.x1 and r.y0 <= cy <= r.y1 for r in regions)

        # A figure/table box that covers only part of a PDF line (its edge over a caption or a
        # footnote, or a line running out of the box) decides the WHOLE line by its first word:
        # half a line kept reads as a broken sentence ("Here the [results are on the COCO ...]").
        line_dropped: dict[tuple, bool] = {}
        rescued: set[tuple] = set()  # caption lines kept inside a figure/table box
        for w in styled:
            key = (w["bno"], w["lno"])
            if key not in line_dropped:
                boxed = _in_drop_region(w)
                label = w["bno"] in label_blocks or key in label_lines
                line_dropped[key] = boxed and not label
                if boxed and label:
                    rescued.add(key)

        def _drop(w) -> bool:
            lx0, lx1 = line_x[(w["bno"], w["lno"])]
            if lx1 <= ml or lx0 >= pw - mr or w["y1"] <= mt or w["y0"] >= ph - mb:
                return True
            if _skipped(w):
                return True
            return line_dropped[(w["bno"], w["lno"])]

        raw = [w for w in styled if not _drop(w)]
        # On page 1, drop everything above the Abstract (title, authors, affiliations), except a
        # figure caption: a teaser figure above the Abstract (SAM) has a caption to translate.
        front_marks: set[str] = set()
        if page_index == 0:
            cut = _front_cut(
                [
                    {"t": w["t"], "y0": w["y0"], "line": (w["bno"], w["lno"])}
                    for w in raw
                ],
                ph,
            )
            front_marks = {
                _mark(ch)
                for w in raw
                if w["y1"] <= cut
                and not _in_rects(
                    (w["x0"] + w["x1"]) / 2, (w["y0"] + w["y1"]) / 2, caption_rects
                )
                for ch in w["t"]
                if ch in _MARKS
            }
            raw = [
                w
                for w in raw
                if w["y1"] > cut
                or _in_rects(
                    (w["x0"] + w["x1"]) / 2, (w["y0"] + w["y1"]) / 2, caption_rects
                )
            ]

        words = [
            {"x0": w["x0"], "y0": w["y0"], "x1": w["x1"], "y1": w["y1"], "t": w["t"]}
            for w in raw
        ]

        # 1) Group words into lines (per-line font size and geometry).
        lines = []
        cur_line = None
        for gi, w in enumerate(raw):
            key = (w["bno"], w["lno"])
            if cur_line is None or cur_line["key"] != key:
                if cur_line:
                    lines.append(cur_line)
                cur_line = {
                    "key": key,
                    "widx": [],
                    "sizes": [],
                    "y0": [],
                    "y1": [],
                    "x0": [],
                    "turned": w["turned"],
                }
            cur_line["widx"].append(gi)
            cur_line["sizes"].append(w["size"])
            cur_line["y0"].append(w["y0"])
            cur_line["y1"].append(w["y1"])
            cur_line["x0"].append(w["x0"])
        if cur_line:
            lines.append(cur_line)
        for ln in lines:
            ln["text"] = " ".join(words[g]["t"] for g in ln["widx"])
            ln["size"] = statistics.median(ln["sizes"]) if ln["sizes"] else 0
            ln["top"], ln["bottom"], ln["left"] = (
                min(ln["y0"]),
                max(ln["y1"]),
                min(ln["x0"]),
            )
            ln["h"] = ln["bottom"] - ln["top"]
            ln["right"] = max(words[g]["x1"] for g in ln["widx"])
            ln["cx"] = (min(ln["x0"]) + ln["right"]) / 2
            ln["cy"] = (ln["top"] + ln["bottom"]) / 2
            # A line is a display-equation line when its center is inside a model formula box.
            # Consecutive such lines (one box spans the whole equation) group into one segment.
            ln["math"] = _in_rects(ln["cx"], ln["cy"], formula_rects)

        # Rejoin fragments the PDF split WITHIN one visual line. Inline math — e.g. "(0, σ²I)" in
        # "… and N(0, σ²I) is Gaussian noise added …" — is often typeset as its own text block
        # beside the prose, and a display equation is likewise split into adjacent spans. Two
        # reading-order-adjacent lines on the same baseline, separated by only a small horizontal
        # gap, are the same visual line, so merge them; otherwise that inline block breaks the
        # sentence (and its highlight). The gap guard keeps a two-column row apart — its halves are
        # far apart, and reading order never puts two columns' lines adjacent at the same y.
        def _lright(ln):
            return max(words[g]["x1"] for g in ln["widx"])

        def _recompute(ln):
            ln["text"] = " ".join(words[g]["t"] for g in ln["widx"])
            ln["size"] = statistics.median(ln["sizes"]) if ln["sizes"] else 0
            ln["top"], ln["bottom"], ln["left"] = (
                min(ln["y0"]),
                max(ln["y1"]),
                min(ln["x0"]),
            )
            ln["h"] = ln["bottom"] - ln["top"]
            ln["right"] = _lright(ln)
            ln["cx"] = (min(ln["x0"]) + ln["right"]) / 2
            ln["cy"] = (ln["top"] + ln["bottom"]) / 2
            ln["math"] = _in_rects(ln["cx"], ln["cy"], formula_rects)

        merged_lines = []
        for ln in lines:
            if merged_lines:
                prev = merged_lines[-1]
                if _joins_line(prev, ln):
                    prev["widx"].extend(ln["widx"])
                    prev["sizes"].extend(ln["sizes"])
                    prev["y0"].extend(ln["y0"])
                    prev["y1"].extend(ln["y1"])
                    prev["x0"].extend(ln["x0"])
                    _recompute(prev)
                    continue
            merged_lines.append(ln)
        lines = _attach_equation_numbers(merged_lines)
        for ln in lines:
            ln["formula"] = next(
                (
                    i
                    for i, rect in enumerate(formula_rects)
                    if _in_rects(ln["cx"], ln["cy"], [rect])
                ),
                None,
            )

        # A table of contents is not translated: the headings it lists are, where they stand.
        # A running head is no entry, by where it stands as well as its words: a monograph's
        # heads repeat its chapter titles ("INTRODUCTION"), and so does its contents.
        heads = {
            j
            for j, ln in enumerate(lines)
            if _norm_header(ln["text"]) in (headers or ())
            and (ln["top"] < ph * 0.12 or ln["bottom"] > ph * 0.90)
        }
        toc = _toc_lines(lines, words, doc.page_count, title_rects, heads, page)
        if toc:
            lines = [ln for j, ln in enumerate(lines) if j not in toc]

        # Drop running heads and page numbers, by their text, not by height alone. A line repeated
        # across pages (`headers`) goes when it is in the page's top or bottom band, or inside a
        # model furniture box wherever that is; a bare page number ("12", "1:4", "xii"), a lone
        # symbol or text set sideways (the arXiv stamp) goes when it is in a furniture box. The
        # rest of a furniture box is kept. A title or caption box over the line wins (the model
        # now and then calls a heading furniture); a body box wins only when it is at least as
        # confident: the model may add a weak second guess for one region, and a first-page
        # footnote it also called body text (0.33 against 0.71) was read into the middle of the
        # abstract beside it.
        for ln in lines:
            ln["furniture"] = not _in_rects(
                ln["cx"], ln["cy"], title_rects + caption_rects
            ) and _conf_at(ln["cx"], ln["cy"], {"furniture"}) > _conf_at(
                ln["cx"], ln["cy"], {"body"}
            )
        lines = [
            ln
            for ln in lines
            if not (
                _norm_header(ln["text"]) in (headers or ())
                and (
                    ln["furniture"] or ln["top"] < ph * 0.12 or ln["bottom"] > ph * 0.90
                )
            )
            and not (
                ln["furniture"]
                and (ln["turned"] or _PAGE_NUMBER.fullmatch(ln["text"].strip()))
            )
        ]

        # A line is a heading when its center is inside a model title box. A font/number heuristic
        # supplement was tried and measured against arXiv .tex: it dropped precision ~10 points
        # (flagging numbered algorithm steps and short lines) while barely moving recall and NOT
        # recovering the one pathological old-journal paper the model misses — so pure title-box
        # detection is kept. A title box may omit a detached section number, so the lone-number
        # merge below still pairs a standalone "2.1" with the title that follows. "title" is the
        # index of the line's box: the lines of one box are one heading.
        for ln in lines:
            ln["title"] = next(
                (
                    k
                    for k, r in enumerate(title_rects)
                    if r.x0 <= ln["cx"] <= r.x1 and r.y0 <= ln["cy"] <= r.y1
                ),
                None,
            )
            ln["heading"] = ln["title"] is not None

        # Asides, read after the page's text: footnotes, and figure/table captions. A caption is
        # a model figure/table caption box (the whole PDF block when the box covers only some of
        # its lines) or a caption rescued from a table box. An equation number ("(5.7)"), also
        # a model caption, stays in place.
        cap_rects = [
            pymupdf.Rect(r["x0"], r["y0"], r["x1"], r["y1"])
            for r in yregions
            if r.get("cls") in ("figure_caption", "table_caption")
        ]
        cap_blocks = {
            ln["key"][0] for ln in lines if _in_rects(ln["cx"], ln["cy"], cap_rects)
        }
        for ln in lines:
            if ln["furniture"]:
                ln["aside"] = "foot"
            elif ln["key"] in rescued or ln["key"][0] in cap_blocks:
                ln["aside"] = "caption"
            else:
                ln["aside"] = None

        # Page 0's footnotes whose mark an author or the title carries ("Ann Lee∗" + "∗Equal
        # contribution", "Bo Li†" + "†Work done at ...") are author notes: front matter, like
        # the lines above the Abstract. A footnote runs from its mark to the next one, within
        # its PDF block. A footnote marked from the text ("... GPUs.¹" + "¹Code: ...") stays.
        # Their words go after the e-mail rule below, which judges the whole footnote block.
        note_words: set[int] = set()
        if front_marks:
            cur, blk = False, None
            for ln in lines:
                if ln["aside"] != "foot":
                    continue
                first = words[ln["widx"][0]]["t"]
                if _marked_note(first):
                    cur = _mark(first[0]) in front_marks
                elif ln["key"][0] != blk or _numbered_note(
                    [raw[g] for g in ln["widx"]]
                ):
                    cur = False
                blk = ln["key"][0]
                if cur:
                    note_words.update(ln["widx"])

        # Merge a lone section-number line ("1", "2.2") into the title that follows, so it reads
        # "1 Introduction" / "2.1 Denoising ...". Many papers typeset the number as a separate
        # element, so the title line carries no number and may not look like a heading on its
        # own (italic, only slightly larger than body, or outside the model's title box). A
        # standalone number is a reliable section marker, so we pair it with the next title-like
        # line (short, capitalized, not a full sentence) and mark the result a heading. Runs in
        # BOTH the heuristic and the model path.
        merged = []
        k = 0
        while k < len(lines):
            ln = lines[k]
            nxt = lines[k + 1] if k + 1 < len(lines) else None
            if nxt is not None and re.fullmatch(r"\d+(\.\d+)*\.?", ln["text"].strip()):
                nt = nxt["text"].strip()
                title_like = (
                    len(nxt["widx"]) <= 12
                    and nt[:1].isupper()
                    and not re.search(r"[.!?]$", nt)
                    and not re.fullmatch(r"\d+(\.\d+)*\.?", nt)
                    and not nxt.get("math")
                )
                if nxt["heading"] or title_like:
                    nxt["widx"] = ln["widx"] + nxt["widx"]
                    nxt["text"] = ln["text"] + " " + nt
                    nxt["heading"] = True
                    k += 1
                    continue
            merged.append(ln)
            k += 1
        lines = merged

        # 2) Reconstruct paragraphs. Lines in the SAME block always join (a wrapped
        #    paragraph). Across blocks they join only when the previous line did not end a
        #    sentence AND the next line is reading-adjacent (same column just below, or the
        #    top of the next column) — so a sentence can span columns without gluing
        #    far-apart blocks (e.g. keywords and a figure caption).
        def _paragraphs(lines: list[dict], captions: bool = False) -> list[dict]:
            """Paragraphs of `lines`. With `captions`, a line that opens with a caption label
            ("Figure 6.") starts a new paragraph: it is the next caption."""
            paras = []
            cur = None
            prev = None
            prev_ended = True
            # the title box of the line just read, if it was a heading
            last_title = None
            for ln in lines:
                in_eq = cur is not None and cur.get("equation")
                is_eq_line = bool(ln.get("math"))
                if is_eq_line and not ln["heading"]:
                    # Merge only within one model region; adjacent equations retain
                    # their own crops and numbers, while multiline formulas stay whole.
                    if (
                        in_eq
                        and prev["formula"] == ln["formula"]
                        and not (cur.get("eqno") and ln.get("eqno"))
                    ):
                        cur["widx"].extend(ln["widx"])
                    else:
                        if cur:
                            paras.append(cur)
                        cur = {
                            "widx": list(ln["widx"]),
                            "size": ln["size"],
                            "heading": False,
                            "equation": True,
                        }
                    if ln.get("eqno"):
                        cur["eqno"] = ln["eqno"]
                    prev, prev_ended = ln, True
                    last_title = None
                    continue
                if ln["heading"]:
                    # A wrapped title ("5 OPTIMIZATION WITH ADAPTIVE DENSITY" + "CONTROL OF 3D
                    # GAUSSIANS") is one heading: its lines share a title box. A section and its
                    # first subsection right below it have a box each.
                    if ln["title"] is not None and ln["title"] == last_title:
                        paras[-1]["widx"].extend(ln["widx"])
                        continue
                    if cur:
                        paras.append(cur)
                    paras.append(
                        {"widx": list(ln["widx"]), "size": ln["size"], "heading": True}
                    )
                    cur, prev, prev_ended = None, None, True
                    last_title = ln["title"]
                    continue
                last_title = None
                if cur is not None and cur.get("equation"):
                    paras.append(cur)  # a prose line ends the equation paragraph
                    cur = None
                cont = False
                if cur is not None and prev is not None:
                    if ln["key"][0] == prev["key"][0]:  # same block
                        cont = True
                    elif not prev_ended and not (
                        captions and _CAPTION_LABEL.match(ln["text"])
                    ):
                        gap = _line_gap(prev, ln)
                        same_col = (
                            abs(ln["left"] - prev["left"]) < 40
                            and -5 <= gap <= prev["h"] * 2.2
                        )
                        col_jump = (
                            ln["left"] > prev["left"] + 120 and ln["top"] < prev["top"]
                        )
                        cont = same_col or col_jump
                if cont:
                    cur["widx"].extend(ln["widx"])
                else:
                    if cur:
                        paras.append(cur)
                    cur = {
                        "widx": list(ln["widx"]),
                        "size": ln["size"],
                        "heading": False,
                    }
                prev_ended = bool(re.search(r"[.!?][\"')\]]?$", ln["text"].strip()))
                prev = ln
            if cur:
                paras.append(cur)
            return paras

        # Captions, then footnotes, after the page's text: in reading order they sit between the
        # halves of a sentence that runs from the foot of one column to the top of the next and
        # split it, or a caption label stuck to it ("... the galaxy auto- Fig. 20."). Over 31
        # papers this made 75 sentences whole. Captions and footnotes never join each other.
        paras = _paragraphs([ln for ln in lines if not ln["aside"]])
        for kind in ("caption", "foot"):
            group = [ln for ln in lines if ln["aside"] == kind]
            for p in _paragraphs(group, captions=kind == "caption"):
                paras.append({**p, "aside": True, "caption": kind == "caption"})
        line_of = {g: li for li, ln in enumerate(lines) for g in ln["widx"]}

        # Page 0's footnote with an e-mail address is the authors' contact block (affiliations,
        # "Correspondence to: ..."): front matter, like the lines above the Abstract, set at the
        # foot of the page. Over 32 papers, all 10 such footnotes were one (one also held a
        # funding note, which goes with it); content footnotes (a definition, a URL) carry no
        # address.
        if page_index == 0:
            paras = [
                p
                for p in paras
                if not (
                    p.get("aside")
                    and not p.get("caption")
                    and _EMAIL.search(" ".join(words[g]["t"] for g in p["widx"]))
                )
            ]
            paras = [
                {**p, "widx": [g for g in p["widx"] if g not in note_words]}
                for p in paras
            ]
            paras = [p for p in paras if p["widx"]]

        # An appendix or supplement may open on a cover that repeats page 0's front matter
        # (title, authors, affiliations). Page 0 drops those lines, so a later paragraph made
        # only of them goes too; the model may type the author line as a title.
        front = _document_front_matter(pdf_bytes) if page_index > 0 and paras else set()
        if front:
            paras = [
                p
                for p in paras
                if not all(
                    _letters(lines[line_of[g]]["text"]) in front for g in p["widx"]
                )
            ]

        # 3) Split each paragraph into sentences (equations and headings are kept whole).
        numbered = set()
        for ln in lines:
            r = None if ln["heading"] or ln.get("math") else _line_item(ln, words)
            if r and r[1] is not None:
                numbered.add(r)
        sentences = []
        for pid, para in enumerate(paras):
            if para.get("equation"):
                st = " ".join(words[g]["t"] for g in para["widx"]).strip()
                if st:
                    heights = [words[g]["y1"] - words[g]["y0"] for g in para["widx"]]
                    sentences.append(
                        {
                            "text": st,
                            "words": list(para["widx"]),
                            "para": pid,
                            "size": round(statistics.median(heights), 1)
                            if heights
                            else 0,
                            "heading": False,
                            "equation": True,
                        }
                    )
                    if para.get("eqno"):
                        sentences[-1]["eqno"] = para["eqno"]
                continue
            text, local = _join_words(para["widx"], words)
            hard: frozenset[int] = frozenset()
            whole: list[tuple[int, int]] = []
            if para["heading"]:
                # one title, one segment: the splitter cut "A.1. Pre-training" after "A.1."
                split = [(0, len(text), text.strip(), [g for *_, g in local])]
            else:
                # a list item or an algorithm step that opens a line starts a sentence: a
                # colon lead-in ("... as follows:" + "1. ...") and steps with no period of
                # their own ("1: repeat" + "2: sample a batch", or the same with no line
                # numbers) were read as one sentence
                if not para.get("caption"):
                    plines = [
                        lines[li]
                        for li in dict.fromkeys(line_of[g] for g in para["widx"])
                    ]
                    at = {g: a for a, _, g in local}
                    items = _item_starts(plines, words, numbered)
                    pseudo = _pseudo_starts(plines, words)
                    starts = items + pseudo
                    if para.get("aside"):
                        # a footnote paragraph may hold several footnotes: each mark starts
                        # one, so a number no longer ends the footnote before it ("... all
                        # tasks 3" + "After each batch ...")
                        starts += [
                            ln["widx"][0]
                            for ln in plines[1:]
                            if _marked_note(words[ln["widx"][0]]["t"])
                            or _numbered_note([raw[g] for g in ln["widx"]])
                        ]
                    hard = frozenset(at[g] for g in starts if g in at)
                    # an algorithm step's own row is one step: the segmenter cut inside it
                    # ("Require: f(θ):" + "Stochastic objective ...", "9: //" + "For
                    # clarity, ..."); not the row of its caption ("Algorithm 1 ...") or the
                    # text after it
                    steps = _pseudo_starts(plines, words, steps_only=True) + [
                        g
                        for g in items
                        if (_line_item(lines[line_of[g]], words) or ("",))[0] == "colon"
                    ]
                    span = {g: (a, b) for a, b, g in local}
                    for g in steps:
                        ln = lines[line_of[g]]
                        if g not in span or words[g]["t"] == "Algorithm":
                            continue
                        end = max(
                            span[w][1]
                            for o in plines
                            if abs(o["cy"] - ln["cy"]) < ln["size"] / 2
                            for w in o["widx"]
                            if w in span and span[w][0] >= span[g][0]
                        )
                        stop = min((c for c in hard if c > span[g][0]), default=end)
                        whole.append((span[g][0], min(end, stop)))
                split = [
                    (s, e, st, [g for (a, b, g) in local if a < e and b > s])
                    for s, e, st in _split_sentences(text, hard, tuple(whole))
                ]
            near_eq = any(
                paras[q].get("equation")
                for q in (pid - 1, pid + 1)
                if 0 <= q < len(paras)
            )
            # a list or an algorithm keeps the short pieces its items and steps cut it into
            # (a lead-in "We study:", a step "repeat"): read whole, they were one sentence
            context = (
                2 if hard or any(len(ix) >= 5 for *_, ix in split) else int(near_eq)
            )
            # Inline sub/superscripts, marked for the translator only ("tex"): "text" stays the
            # plain PDF text that splitting, stitching and quote lookup work on.
            marks = {}
            if not para["heading"]:
                body = statistics.median(raw[g]["size"] for g in para["widx"])
                marks = _script_roles(para["widx"], words, raw, line_of, body)
            for s, e, st, idxs in split:
                # headings/labels are always kept (shown as titles), and so are list items
                # and algorithm steps ("5: end for"); body uses the filter. A footnote that
                # is only a link has nothing to translate.
                if (
                    idxs
                    and not (
                        para.get("aside") and not para.get("caption") and _link_only(st)
                    )
                    and (
                        para["heading"]
                        or (_lstrip_at(text, s) in hard and len(idxs) > 1)
                        or _keep_sentence(st, len(idxs), context)
                    )
                ):
                    heights = [words[g]["y1"] - words[g]["y0"] for g in idxs]
                    size = round(statistics.median(heights), 1) if heights else 0
                    sentences.append(
                        {
                            "text": st,
                            "words": idxs,
                            "para": pid,
                            "size": size,
                            "heading": para["heading"],
                        }
                    )
                    if marks and any(g in marks for g in idxs):
                        sentences[-1]["tex"] = _mark_scripts(text, s, e, local, marks)
                    w0 = words[idxs[0]]
                    r0 = raw[idxs[0]]
                    if (
                        para.get("caption")
                        or r0["bno"] in label_blocks
                        or (r0["bno"], r0["lno"]) in label_lines
                    ) or _in_rects(
                        (w0["x0"] + w0["x1"]) / 2,
                        (w0["y0"] + w0["y1"]) / 2,
                        caption_rects,
                    ):
                        sentences[-1]["caption"] = True
                    if para.get("aside"):
                        sentences[-1]["aside"] = True

        return {
            "width": round(page.rect.width, 2),
            "height": round(page.rect.height, 2),
            "words": words,
            "sentences": sentences,
        }
    finally:
        doc.close()


def full_text(pages: list[str], max_chars: int = 200_000) -> str:
    """Join page texts into a single document string, capped to stay sane."""
    joined = "\n\n".join(f"[Page {i + 1}]\n{t}" for i, t in enumerate(pages))
    if len(joined) > max_chars:
        joined = joined[:max_chars] + "\n\n[...truncated...]"
    return joined


def brief_source(pages: list[str], max_chars: int = 6000) -> str:
    """The front matter used to build a translation glossary: title, abstract, and the start
    of the introduction all live in the first pages, where a paper defines its abbreviations
    and key terms. Feeding only this (not the whole paper) keeps the glossary pass fast."""
    joined = "\n\n".join(pages[:2])
    return joined[:max_chars]


def crop_region_png(
    pdf_bytes: bytes,
    page_index: int,
    bbox: tuple[float, float, float, float],
    dpi: int = 220,
    pad: float = 5.0,
) -> bytes:
    """Render one page region (bbox in PDF points) to PNG bytes — the image a vision call
    reads to transcribe a display equation to LaTeX."""
    doc = pymupdf.open(stream=pdf_bytes, filetype="pdf")
    try:
        page = doc[page_index]
        x0, y0, x1, y1 = bbox
        clip = pymupdf.Rect(x0 - pad, y0 - pad, x1 + pad, y1 + pad) & page.rect
        return page.get_pixmap(dpi=dpi, clip=clip).tobytes("png")
    finally:
        doc.close()


def _caption_text(page, region: dict, captions: list[dict]) -> str:
    """Text of the caption box nearest to a figure/table region: horizontal overlap with the
    smallest vertical gap (a caption sits just below a figure or just above a table). '' when
    there is none."""
    best, best_gap = None, float("inf")
    for c in captions:
        if c["x1"] < region["x0"] or c["x0"] > region["x1"]:
            continue  # no horizontal overlap
        gap = min(abs(c["y0"] - region["y1"]), abs(region["y0"] - c["y1"]))
        if gap < best_gap:
            best, best_gap = c, gap
    if best is None:
        return ""
    rect = pymupdf.Rect(best["x0"], best["y0"], best["x1"], best["y1"])
    return " ".join(page.get_text("text", clip=rect).split())[:300]


def figure_catalog(pdf_bytes: bytes) -> dict:
    """Figures/tables (each with its caption) and whether any display math is present, for the
    review export. Requires the layout model. Returns
    {"figures": [{id, page (0-based), bbox, caption, kind}], "has_math": bool}.
    ids are human-readable: fig-p<1-based>-<n> / tbl-p<1-based>-<n>."""
    doc = pymupdf.open(stream=pdf_bytes, filetype="pdf")
    figures: list[dict] = []
    has_math = False
    try:
        for pi in range(doc.page_count):
            page = doc[pi]
            regions = layout_model.detect_page(page) or []
            captions = [r for r in regions if r["role"] == "caption"]
            if any(r["role"] == "formula" for r in regions):
                has_math = True
            counts: dict[str, int] = {}
            for r in regions:
                if r["role"] not in ("figure", "table"):
                    continue
                kind = "fig" if r["role"] == "figure" else "tbl"
                counts[kind] = counts.get(kind, 0) + 1
                figures.append(
                    {
                        "id": f"{kind}-p{pi + 1}-{counts[kind]}",
                        "page": pi,
                        "bbox": (r["x0"], r["y0"], r["x1"], r["y1"]),
                        "caption": _caption_text(page, r, captions),
                        "kind": kind,
                    }
                )
    finally:
        doc.close()
    return {"figures": figures, "has_math": has_math}
