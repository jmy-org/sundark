"""Layout inference runs one at a time across threads and processes sharing data/."""

import os
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

import pymupdf
from filelock import FileLock

from app import layout_model, pdf_utils

# Generous deadline: it only bounds a hang, never measures speed.
DEADLINE = 20.0


class FakeModel:
    """Marks itself active in a shared directory while it "infers"."""

    names = {}

    def __init__(self, active: Path, hold=0.15, block=False):
        self.active, self.hold, self.block = active, hold, block
        self.peak = 0
        self.seq = 0

    def predict(self, img, **kw):
        self.seq += 1
        mark = self.active / f"{os.getpid()}-{threading.get_ident()}-{self.seq}"
        mark.touch()
        if self.block:
            (self.active.parent / f"held-{os.getpid()}").touch()
            time.sleep(3600)
        end = time.monotonic() + self.hold
        while time.monotonic() < end:
            self.peak = max(self.peak, len(os.listdir(self.active)))
            time.sleep(0.005)
        mark.unlink()
        return [SimpleNamespace(boxes=[])]


class FakePage:
    def get_pixmap(self, dpi):
        return SimpleNamespace(width=1, height=1, samples=b"\0\0\0")


WORKER = r"""
import os, threading, time
from pathlib import Path
from unittest.mock import patch
from tests.test_layout_lock import FakeModel, FakePage
from app import layout_model

tmp = Path(os.environ["T"])
model = FakeModel(tmp / "active", block=os.environ["ROLE"] == "hold")
with (
    patch.object(layout_model, "_LOCKS", tmp / "locks"),
    patch.object(layout_model, "_model", model),
    patch.object(layout_model, "_device", return_value="cpu"),
):
    (tmp / f"ready-{os.getpid()}").touch()
    while not (tmp / "go").exists():
        time.sleep(0.01)

    def three():
        for _ in range(3):
            layout_model.detect_page(FakePage())

    threads = [threading.Thread(target=three) for _ in range(2)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    (tmp / f"peak-{os.getpid()}").write_text(str(model.peak))
"""


class LayoutLockTests(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, self.tmp, True)
        (self.tmp / "active").mkdir()
        self.procs = []
        self.addCleanup(self._kill_all)

    def _kill_all(self):
        for p in self.procs:
            if p.poll() is None:
                p.kill()
            p.wait()

    def use(self, model):
        for p in (
            patch.object(layout_model, "_LOCKS", self.tmp / "locks"),
            patch.object(layout_model, "_model", model),
            patch.object(layout_model, "_device", return_value="cpu"),
        ):
            p.start()
            self.addCleanup(p.stop)

    def spawn(self, role, count=1):
        env = {**os.environ, "T": str(self.tmp), "ROLE": role}
        for _ in range(count):
            self.procs.append(
                subprocess.Popen(
                    [sys.executable, "-c", WORKER], env=env, cwd=Path.cwd()
                )
            )
        self.wait_for(lambda: self.count("ready-*") == count)
        (self.tmp / "go").touch()

    def count(self, pattern):
        return len(list(self.tmp.glob(pattern)))

    def wait_for(self, condition):
        end = time.monotonic() + DEADLINE
        while not condition():
            for p in self.procs:
                self.assertIn(p.poll(), (None, 0, -9), "a worker failed")
            self.assertLess(time.monotonic(), end, "timed out")
            time.sleep(0.01)

    def test_two_processes_infer_one_at_a_time(self):
        self.spawn("infer", count=2)
        self.wait_for(lambda: self.count("peak-*") == 2)
        peaks = [int(f.read_text()) for f in self.tmp.glob("peak-*")]
        self.assertEqual(peaks, [1, 1])

    def test_figure_catalog_and_page_layout_infer_one_at_a_time(self):
        # The review's figure catalog runs in its own thread, outside service's layout lock.
        model = FakeModel(self.tmp / "active")
        self.use(model)
        doc = pymupdf.open()
        for _ in range(3):
            doc.new_page(width=612, height=792)
        pdf = doc.tobytes()
        doc.close()
        page = pymupdf.open(stream=pdf, filetype="pdf")[0]
        threads = [
            threading.Thread(target=pdf_utils.figure_catalog, args=(pdf,)),
            threading.Thread(
                target=lambda: [layout_model.detect_page(page) for _ in range(3)]
            ),
        ]
        for t in threads:
            t.start()
        for t in threads:
            t.join(DEADLINE)
        self.assertEqual(model.seq, 6)
        self.assertEqual(model.peak, 1)

    def test_a_killed_holder_frees_the_lock(self):
        self.use(FakeModel(self.tmp / "active", hold=0))
        self.spawn("hold")
        self.wait_for(lambda: self.count("held-*") == 1)
        result = []
        waiter = threading.Thread(
            target=lambda: result.append(layout_model.detect_page(FakePage()))
        )
        waiter.start()
        waiter.join(0.3)
        self.assertTrue(waiter.is_alive())
        self.procs[0].kill()
        waiter.join(DEADLINE)
        self.assertEqual(result, [[]])

    def test_a_lock_failure_fails_the_page_instead_of_returning_no_regions(self):
        blocker = self.tmp / "file"
        blocker.write_text("")
        model = FakeModel(self.tmp / "active", hold=0)
        self.use(model)
        with patch.object(layout_model, "_LOCKS", blocker / "locks"):
            with self.assertRaises(OSError):
                layout_model.detect_page(FakePage())
        self.assertEqual(model.seq, 0)

    def test_a_gate_release_failure_frees_the_lock(self):
        model = FakeModel(self.tmp / "active", hold=0)
        self.use(model)
        made, real = [], layout_model.FileLock

        class Gate:
            def __init__(self, lock):
                self.lock = lock

            def __enter__(self):
                self.lock.acquire()

            def __exit__(self, *exc):
                self.lock.release()
                raise OSError("gate release failed")

        def file_lock(path, **kw):
            # Every lock made is kept alive: only an explicit release frees it.
            made.append(real(path, **kw))
            return Gate(made[-1]) if path.suffix == ".gate" else made[-1]

        with patch.object(layout_model, "FileLock", side_effect=file_lock):
            # Kept with its traceback (assertRaises would clear the frames).
            try:
                layout_model.detect_page(FakePage())
            except OSError as exc:
                failure = exc
            else:
                self.fail("did not raise")
        self.assertEqual(str(failure), "gate release failed")
        self.assertIsNotNone(failure.__traceback__)
        self.assertEqual(len(made), 2)
        self.assertEqual(model.seq, 0)
        lock = FileLock(
            self.tmp / "locks" / "layout-model.lock", fallback_to_soft=False
        )
        lock.acquire(blocking=False)
        lock.release()


if __name__ == "__main__":
    unittest.main()
