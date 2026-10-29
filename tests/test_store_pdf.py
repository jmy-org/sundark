import asyncio
import io
import os
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from contextlib import contextmanager
from pathlib import Path
from unittest.mock import patch

from app import service, store

ROOT = Path(__file__).resolve().parent.parent
PDF = b"%PDF-1.4 synthetic " + bytes(range(256)) * 64


class _PausedWriter:
    """A binary file that writes half its first payload, then waits to be resumed."""

    def __init__(self, stream, pause):
        self.stream, self.pause = stream, pause

    def write(self, data):
        view = memoryview(data)
        half = len(view) // 2
        self.stream.write(view[:half])
        self.stream.flush()
        self.pause()
        return half + self.stream.write(view[half:])

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return self.stream.__exit__(*exc)

    def __getattr__(self, name):
        return getattr(self.stream, name)


@contextmanager
def pause_binary_writes(pause, only=lambda: True):
    """Every binary write (Path.write_bytes or os.fdopen) goes through `pause`."""
    real_open = io.open

    def paused_open(file, mode="r", *args, **kwargs):
        stream = real_open(file, mode, *args, **kwargs)
        return _PausedWriter(stream, pause) if mode == "wb" and only() else stream

    with patch.object(io, "open", paused_open):
        yield


# Run in a second process: save the PDF, pausing mid-write until the parent says go.
_WRITER = """
import sys, time
from pathlib import Path
from app import store
from tests.test_store_pdf import PDF, pause_binary_writes

store.PDFS = Path(sys.argv[1])
marks = Path(sys.argv[2])

def pause():
    (marks / "paused").touch()
    deadline = time.monotonic() + 20
    while not (marks / "resume").exists() and time.monotonic() < deadline:
        time.sleep(0.01)

with pause_binary_writes(pause):
    store.save_pdf(sys.argv[3], PDF)
"""


class SavePdfTests(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.TemporaryDirectory()
        self.root = Path(self.dir.name)
        self.pdfs = self.root / "pdfs"
        self.pdfs.mkdir()
        self.patch = patch.object(store, "PDFS", self.pdfs)
        self.patch.start()

    def tearDown(self):
        self.patch.stop()
        self.dir.cleanup()

    def _wait_for(self, path: Path):
        deadline = time.monotonic() + 20
        while not path.exists():
            if time.monotonic() > deadline:
                self.fail(f"writer never reached {path.name}")
            time.sleep(0.01)

    def test_a_writer_in_another_process_never_publishes_a_partial_pdf(self):
        doc_id = store.doc_id_for(PDF)
        for existing in (None, PDF):
            with self.subTest(existing=existing is not None):
                final = store.pdf_path(doc_id)
                final.unlink(missing_ok=True)
                if existing is not None:
                    store.save_pdf(doc_id, existing)
                marks = Path(tempfile.mkdtemp(dir=self.root))
                writer = subprocess.Popen(
                    [sys.executable, "-c", _WRITER, str(self.pdfs), marks, doc_id],
                    cwd=ROOT,
                    env={**os.environ, "PYTHONPATH": str(ROOT)},
                )
                try:
                    self._wait_for(marks / "paused")
                    # The writer holds half the bytes: the published path is either
                    # absent (first save) or the complete earlier PDF, never partial.
                    if existing is None:
                        self.assertFalse(final.exists())
                    else:
                        self.assertEqual(final.read_bytes(), existing)
                finally:
                    (marks / "resume").touch()
                    self.assertEqual(writer.wait(timeout=30), 0)
                self.assertEqual(final.read_bytes(), PDF)
                self.assertEqual(
                    sorted(p.name for p in self.pdfs.iterdir()), [f"{doc_id}.pdf"]
                )

    def test_a_failed_save_keeps_no_partial_or_temporary_file(self):
        doc_id = store.doc_id_for(PDF)

        def fail():
            raise OSError("injected write failure")

        with pause_binary_writes(fail):
            with self.assertRaises(OSError):
                store.save_pdf(doc_id, PDF)
        self.assertEqual(list(self.pdfs.iterdir()), [])
        store.save_pdf(doc_id, PDF)
        with pause_binary_writes(fail):
            with self.assertRaises(OSError):
                store.save_pdf(doc_id, PDF)
        self.assertEqual(store.pdf_path(doc_id).read_bytes(), PDF)
        self.assertEqual(list(self.pdfs.iterdir()), [store.pdf_path(doc_id)])


class ConcurrentIngestTests(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.TemporaryDirectory()
        root = Path(self.dir.name)
        self.patches = [
            patch.object(store, "PDFS", root / "pdfs"),
            patch.object(store, "DOCS", root / "docs"),
            patch.object(store, "PAPERS", root / "papers"),
        ]
        for p in self.patches:
            p.start()
        for d in ("pdfs", "docs"):
            (root / d).mkdir()

    def tearDown(self):
        for p in reversed(self.patches):
            p.stop()
        self.dir.cleanup()

    def test_a_second_ingest_never_exposes_a_partial_pdf_behind_a_published_doc(self):
        """Two opens of the same unseen PDF both miss load_doc. The first publishes
        the PDF and its doc record; the second, still writing, must not truncate it."""
        doc_id = store.doc_id_for(PDF)
        events = [threading.Event() for _ in range(4)]
        late_missed, late_extract, late_paused, late_resume = events

        def extract(data):
            if threading.current_thread().name == "late":
                late_missed.set()  # past load_doc, which found no record
                late_extract.wait(10)
            return {"pages": ["TEXT"], "meta": {"num_pages": 1, "title": "T"}}

        async def identify(doc_id, *args):
            return f"file:{doc_id}"

        def pause():
            late_paused.set()
            late_resume.wait(10)

        late = threading.Thread(
            target=lambda: asyncio.run(service._ingest(PDF)), name="late"
        )
        with (
            patch.object(service.pdf_utils, "extract", side_effect=extract),
            patch.object(service, "_identify", side_effect=identify),
            pause_binary_writes(
                pause, only=lambda: threading.current_thread().name == "late"
            ),
        ):
            late.start()
            try:
                self.assertTrue(late_missed.wait(10), "late ingest never started")
                asyncio.run(service._ingest(PDF))
                late_extract.set()
                self.assertTrue(late_paused.wait(10), "late ingest never wrote")
                self.assertIsNotNone(store.load_doc(doc_id))
                self.assertEqual(store.pdf_path(doc_id).read_bytes(), PDF)
            finally:
                late_extract.set()
                late_resume.set()
                late.join(10)
        self.assertEqual(store.pdf_path(doc_id).read_bytes(), PDF)
        self.assertEqual(list(store.PDFS.iterdir()), [store.pdf_path(doc_id)])


if __name__ == "__main__":
    unittest.main()
