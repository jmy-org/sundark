"""Local filesystem storage for uploaded PDFs and cached AI results.

Layout (all under ./data, gitignored):
  data/pdfs/<doc_id>.pdf        original upload
  data/docs/<doc_id>.json       extracted {"pages": [...], "meta": {...}}
  data/cache/<doc_id>/<key>.json cached AI outputs (summary, translations)
  data/papers/<key>.json         Bibliographic Record per Paper ID (key = hash of the Paper ID)
  data/chats/<key>.json          Chat History per Paper ID
"""

from __future__ import annotations

import hashlib
import json
import os
import tempfile
import uuid
from contextlib import ExitStack
from pathlib import Path

from filelock import FileLock

DATA = Path(__file__).resolve().parent.parent / "data"
PDFS = DATA / "pdfs"
DOCS = DATA / "docs"
CACHE = DATA / "cache"
CHATS = DATA / "chats"
PAPERS = DATA / "papers"

for _d in (PDFS, DOCS, CACHE):
    _d.mkdir(parents=True, exist_ok=True)


def doc_id_for(pdf_bytes: bytes) -> str:
    return hashlib.sha256(pdf_bytes).hexdigest()[:16]


def save_pdf(doc_id: str, pdf_bytes: bytes) -> None:
    (PDFS / f"{doc_id}.pdf").write_bytes(pdf_bytes)


def pdf_path(doc_id: str) -> Path:
    return PDFS / f"{doc_id}.pdf"


def _atomic_json_write(path: Path, value: object) -> None:
    """Publish one complete JSON value; concurrent writers are last-complete-wins."""
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, name = tempfile.mkstemp(dir=path.parent, prefix=".json-", suffix=".tmp")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as stream:
            json.dump(value, stream, ensure_ascii=False)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(name, path)
    finally:
        Path(name).unlink(missing_ok=True)


def save_doc(doc_id: str, extracted: dict) -> None:
    _atomic_json_write(DOCS / f"{doc_id}.json", extracted)


def load_doc(doc_id: str) -> dict | None:
    p = DOCS / f"{doc_id}.json"
    if not p.exists():
        return None
    return json.loads(p.read_text(encoding="utf-8"))


def cache_get(doc_id: str, key: str) -> dict | None:
    p = CACHE / doc_id / f"{key}.json"
    if not p.exists():
        return None
    return json.loads(p.read_text(encoding="utf-8"))


def cache_put(doc_id: str, key: str, value: dict) -> None:
    _atomic_json_write(CACHE / doc_id / f"{key}.json", value)


def _key(pid: str) -> str:
    """Filesystem-safe name for a Paper ID (DOIs may contain '/', '<', ';', ...)."""
    return hashlib.sha256(pid.encode("utf-8")).hexdigest()[:16]


def paper_get(pid: str) -> dict | None:
    try:
        return json.loads((PAPERS / f"{_key(pid)}.json").read_text("utf-8"))
    except (OSError, ValueError):
        return None


def paper_put(pid: str, record: dict) -> None:
    _atomic_json_write(PAPERS / f"{_key(pid)}.json", {"paper_id": pid, **record})


def paper_cache_id(pid: str) -> str:
    """A cache_get/cache_put id for caches that belong to the Paper, not to one PDF file."""
    return f"paper_{_key(pid)}"


def _chat_path(pid: str) -> Path:
    return CHATS / f"{_key(pid)}.json"


def _chat_lock(path: Path) -> FileLock:
    locks = CHATS / ".locks"
    locks.mkdir(parents=True, exist_ok=True)
    return FileLock(locks / f"{path.name}.lock")


def _chat_record(path: Path) -> dict:
    """Only a missing file is an empty history; invalid records fail closed."""
    try:
        record = json.loads(path.read_text("utf-8"))
    except FileNotFoundError:
        return {"turns": [], "generation": "legacy"}
    if isinstance(record, list):
        return {"turns": record, "generation": "legacy"}
    if (
        not isinstance(record, dict)
        or not isinstance(record.get("turns"), list)
        or not isinstance(record.get("generation"), str)
        or not record["generation"]
        or (
            "move_id" in record
            and not (isinstance(record["move_id"], str) and record["move_id"])
        )
        or (
            "moved" in record
            and (
                record["moved"] is not True
                or "move_id" not in record
                or record["turns"]
            )
        )
    ):
        raise ValueError("Invalid chat record")
    return record


def _chat_read(path: Path) -> tuple[list[dict], str]:
    record = _chat_record(path)
    return record["turns"], record["generation"]


def _chat_write(
    path: Path,
    turns: list[dict],
    generation: str,
    *,
    move_id: str | None = None,
    moved: bool = False,
) -> None:
    """Replace the complete record atomically, including the reset fence."""
    record = {"generation": generation, "turns": turns}
    if move_id is not None:
        record["move_id"] = move_id
    if moved:
        record["moved"] = True
    _atomic_json_write(path, record)


def chat_snapshot(pid: str) -> tuple[list[dict], str]:
    """Read history and its reset fence in one short cross-process transaction."""
    path = _chat_path(pid)
    with _chat_lock(path):
        return _chat_read(path)


def chat_get(pid: str) -> list[dict]:
    # Atomic replacement lets readers see an entire old or new record without waiting.
    try:
        return _chat_read(_chat_path(pid))[0]
    except (OSError, ValueError):
        return []


def chat_put(pid: str, turns: list[dict]) -> None:
    path = _chat_path(pid)
    with _chat_lock(path):
        _chat_record(path)  # Never replace unreadable user work as if absent.
        _chat_write(path, turns, uuid.uuid4().hex)


def chat_append(pid: str, turns: list[dict], generation: str) -> bool:
    """Append in completion order unless reset/replacement invalidated the snapshot."""
    path = _chat_path(pid)
    with _chat_lock(path):
        record = _chat_record(path)
        if record["generation"] != generation:
            return False
        # A new exchange at a vacated ID starts an independent history.
        move_id = None if record.get("moved") else record.get("move_id")
        _chat_write(path, record["turns"] + turns, generation, move_id=move_id)
        return True


def chat_clear(pid: str) -> None:
    # Keep a durable empty record: deletion would revive a legacy in-flight snapshot.
    chat_put(pid, [])


def _chat_move(old: Path, new: Path, *, keep_fence: bool) -> None:
    if old == new:
        return
    with ExitStack() as stack:
        for path in sorted((old, new)):
            stack.enter_context(_chat_lock(path))
        if not old.exists():
            return
        source = _chat_record(old)
        if source.get("moved"):
            return
        destination = _chat_record(new)
        move_id = source.get("move_id") or uuid.uuid4().hex
        if new.exists() and not (
            keep_fence
            and destination.get("moved")
            and destination.get("move_id") == move_id
        ):
            return
        # Destination first: interruption can duplicate, never lose, turns.
        _chat_write(new, source["turns"], uuid.uuid4().hex, move_id=move_id)
        if keep_fence:
            _chat_write(old, [], uuid.uuid4().hex, move_id=move_id, moved=True)
        else:
            old.unlink()


def chat_move(old_pid: str, new_pid: str) -> None:
    """Carry chat across identity changes without overwriting history/reset fences."""
    _chat_move(_chat_path(old_pid), _chat_path(new_pid), keep_fence=True)


def chat_migrate(doc_id: str, pid: str) -> None:
    """Move a chat saved per doc_id (before Paper IDs), never overwriting."""
    _chat_move(CHATS / f"{doc_id}.json", _chat_path(pid), keep_fence=False)
