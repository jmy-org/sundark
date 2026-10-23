"""Document layout detection via DocLayout-YOLO (optional).

This is the one heavy model in the pipeline. It takes a rendered page image and returns typed
regions (title, body, figure, table, formula, header/footer) as boxes in PDF points. The rest
of the app keeps using the PyMuPDF text layer for exact text and word coordinates, so
highlighting is unaffected; these regions only say WHAT each area is.

The dependency is optional: if torch / doclayout_yolo are not installed (or the model can't be
loaded), `available()` is False and callers fall back to the heuristic parser. Keeping it
optional means the app still runs as a pure-Python tool on machines without the model.

Model source: $DOCLAYOUT_MODEL if set (a local .pt path), else downloaded from the Hugging
Face hub on first use and cached there.
"""

from __future__ import annotations

import os
import threading
from contextlib import contextmanager

from filelock import FileLock

from .store import DATA

_DPI = 144
_SCALE = 72.0 / _DPI  # image pixels -> PDF points
_CONF = 0.30  # drop low-confidence boxes (also removes the odd duplicate detection)
_HF_REPO = "juliozhao/DocLayout-YOLO-DocStructBench"
_HF_FILE = "doclayout_yolo_docstructbench_imgsz1024.pt"

# DocStructBench class id -> our region role.
_CLASS_ROLE = {
    "title": "title",
    "plain text": "body",
    "abandon": "furniture",  # running header/footer/page number
    "figure": "figure",
    "figure_caption": "caption",
    "table": "table",
    "table_caption": "caption",
    "table_footnote": "table",
    "isolate_formula": "formula",
    "formula_caption": "caption",
}

# Inference runs one at a time across every thread and process that shares this data/
# directory: page layout, its neighbour peeks, and the review's figure catalog.
_LOCKS = DATA / ".locks"

_model = None
_load_lock = threading.Lock()
_load_failed = False


def _load():
    """Load the model once (thread-safe). Returns the model or None if unavailable."""
    global _model, _load_failed
    if _model is not None or _load_failed:
        return _model
    with _load_lock:
        if _model is not None or _load_failed:
            return _model
        try:
            from doclayout_yolo import YOLOv10

            path = os.environ.get("DOCLAYOUT_MODEL")
            if not path:
                from huggingface_hub import hf_hub_download

                path = hf_hub_download(repo_id=_HF_REPO, filename=_HF_FILE)
            _model = YOLOv10(path)
        except Exception:  # noqa: BLE001 — any failure => fall back to heuristics
            _load_failed = True
            _model = None
    return _model


def available() -> bool:
    """True if the layout model can be used (deps present and model loadable)."""
    return _load() is not None


def _device() -> str:
    try:
        import torch

        return "cuda:0" if torch.cuda.is_available() else "cpu"
    except Exception:  # noqa: BLE001
        return "cpu"


@contextmanager
def _one_at_a_time():
    """Hold the inference lock. Waiters queue on a gate first, so a thread that just
    released the lock cannot take it again ahead of one already waiting."""
    lock = None
    # The release covers the gate's exit too, so a failed gate release frees the lock.
    try:
        _LOCKS.mkdir(parents=True, exist_ok=True)
        kw = {"fallback_to_soft": False, "preserve_lock_file": True}
        # Fresh instances each time: separate open files exclude each other in one process.
        with FileLock(_LOCKS / "layout-model.gate", **kw):
            lock = FileLock(_LOCKS / "layout-model.lock", **kw)
            lock.acquire()
        yield
    finally:
        if lock is not None:
            lock.release()


def detect_page(page) -> list[dict] | None:
    """Typed regions for one PyMuPDF page: [{role, cls, x0, y0, x1, y1, conf}] in PDF points,
    ordered top-to-bottom. Returns None if the model is unavailable (caller falls back).
    Raises OSError when inference cannot be serialized, so no region-less layout is cached."""
    model = _load()
    if model is None:
        return None
    try:
        import pymupdf  # noqa: F401
        from PIL import Image

        pix = page.get_pixmap(dpi=_DPI)
        img = Image.frombytes("RGB", (pix.width, pix.height), pix.samples)
    except Exception:  # noqa: BLE001
        return None
    # A lock failure raises here instead of returning None, which would cache a layout
    # without regions.
    with _one_at_a_time():
        try:
            det = model.predict(
                img, imgsz=1024, conf=_CONF, device=_device(), verbose=False
            )
        except Exception:  # noqa: BLE001
            return None
    try:
        out: list[dict] = []
        for b in det[0].boxes:
            cls = model.names[int(b.cls)]
            x0, y0, x1, y1 = (v * _SCALE for v in b.xyxy[0].tolist())
            out.append(
                {
                    "role": _CLASS_ROLE.get(cls, "body"),
                    "cls": cls,
                    "x0": round(x0, 2),
                    "y0": round(y0, 2),
                    "x1": round(x1, 2),
                    "y1": round(y1, 2),
                    "conf": round(float(b.conf), 3),
                }
            )
        out.sort(key=lambda r: (r["y0"], r["x0"]))
        return out
    except Exception:  # noqa: BLE001
        return None
