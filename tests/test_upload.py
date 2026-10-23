import os
import tempfile
import threading
import unittest
from pathlib import Path
from unittest.mock import patch

from app import service


class SaveToLibraryTests(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.TemporaryDirectory()
        self.papers = Path(self.dir.name)
        self.p = patch.object(service, "PAPERS_DIR", self.papers)
        self.p.start()

    def tearDown(self):
        self.p.stop()
        self.dir.cleanup()

    def _names(self):
        return sorted(f.name for f in self.papers.iterdir())

    def test_saves_with_original_name(self):
        service._save_to_library("Attention.pdf", b"DATA")
        self.assertEqual(self._names(), ["Attention.pdf"])
        self.assertEqual((self.papers / "Attention.pdf").read_bytes(), b"DATA")

    def test_strips_path_components(self):
        service._save_to_library("../../etc/evil.pdf", b"DATA")
        self.assertEqual(self._names(), ["evil.pdf"])  # basename only, cannot escape

    def test_adds_pdf_extension(self):
        service._save_to_library("noext", b"DATA")
        self.assertEqual(self._names(), ["noext.pdf"])

    def test_identical_content_is_not_duplicated(self):
        service._save_to_library("paper.pdf", b"DATA")
        service._save_to_library("paper.pdf", b"DATA")
        self.assertEqual(self._names(), ["paper.pdf"])

    def test_same_name_different_content_gets_suffix(self):
        service._save_to_library("paper.pdf", b"ONE")
        service._save_to_library("paper.pdf", b"TWO")
        self.assertEqual(self._names(), ["paper-1.pdf", "paper.pdf"])
        self.assertEqual((self.papers / "paper.pdf").read_bytes(), b"ONE")
        self.assertEqual((self.papers / "paper-1.pdf").read_bytes(), b"TWO")

    def _race(self, first: bytes, second: bytes):
        """Two processes (threads here) save under one name and both reach the point where
        they commit the file before either has: whichever check precedes the write (an
        exists() test or an exclusive create), both pass it together."""
        barrier = threading.Barrier(2, timeout=2)
        waited = threading.local()

        def rendezvous(real):
            def call(*args, **kwargs):
                if not getattr(waited, "done", False):
                    waited.done = True
                    try:
                        barrier.wait()
                    except threading.BrokenBarrierError:
                        pass
                return real(*args, **kwargs)

            return call

        threads = [
            threading.Thread(target=service._save_to_library, args=("paper.pdf", data))
            for data in (first, second)
        ]
        with (
            patch.object(Path, "exists", rendezvous(Path.exists)),
            patch.object(os, "link", rendezvous(os.link)),
        ):
            for t in threads:
                t.start()
            for t in threads:
                t.join(5)

    def test_concurrent_different_content_keeps_both(self):
        self._race(b"ONE", b"TWO")
        self.assertEqual(self._names(), ["paper-1.pdf", "paper.pdf"])
        saved = {(self.papers / n).read_bytes() for n in self._names()}
        self.assertEqual(saved, {b"ONE", b"TWO"})

    def test_concurrent_identical_content_is_saved_once(self):
        self._race(b"DATA", b"DATA")
        self.assertEqual(self._names(), ["paper.pdf"])
        self.assertEqual((self.papers / "paper.pdf").read_bytes(), b"DATA")


if __name__ == "__main__":
    unittest.main()
