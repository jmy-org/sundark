"""The AI concurrency setting bounds every process that shares the settings file."""

import asyncio
import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path
from unittest.mock import patch

from filelock import FileLock, Timeout

from app import ai
from app.errors import AIError

# Generous deadlines: they only bound a hang, never measure speed.
DEADLINE = 20.0

# A worker process: waits on the `go` barrier, then runs ROLE against a fake backend that
# marks itself active in the shared `active` directory.
WORKER = r"""
import asyncio, os, sys, time
from pathlib import Path
from unittest.mock import patch
from app import ai

tmp = Path(os.environ["T"])
role = os.environ["ROLE"]
active = tmp / "active"
me = f"{os.getpid()}"


def wait_for(path):
    while not path.exists():
        time.sleep(0.01)


class Fake:
    peak = 0
    seq = 0

    async def run(self, prompt, *, model, system=None, images=()):
        Fake.seq += 1
        mark = active / f"{me}-{Fake.seq}"
        mark.touch()
        if role == "hold":
            (tmp / f"held-{me}").touch()
            await asyncio.sleep(3600)
        end = time.monotonic() + float(os.environ.get("HOLD", "0.3"))
        while time.monotonic() < end:
            Fake.peak = max(Fake.peak, len(os.listdir(active)))
            await asyncio.sleep(0.01)
        mark.unlink()
        return "ok"

    async def stream(self, prompt, *, model, system=None):
        yield "1\tx\n"
        await asyncio.sleep(3600)


async def main():
    if role == "bound":
        await asyncio.gather(*(ai.explain("x") for _ in range(4)))
        (tmp / f"peak-{me}").write_text(str(Fake.peak))
    elif role == "hold":
        await ai.explain("x")
    elif role == "busy":
        for i in range(20):
            await ai.explain("x")
            (tmp / f"a-done-{i}").touch()
    elif role == "late":
        await ai.explain("x")
        done = len(list(tmp.glob("a-done-*")))
        (tmp / "b-result").write_text(str(done))
    elif role == "stream":
        stream = ai.translate_stream(["a", "b"], "Korean")
        await stream.__anext__()
        (tmp / "streaming").touch()
        wait_for(tmp / "close")
        await stream.aclose()
        (tmp / "closed").touch()
        await asyncio.sleep(3600)


with patch("app.ai.backends.get", return_value=Fake()):
    (tmp / f"ready-{role}-{me}").touch()
    wait_for(tmp / f"go-{role}")
    asyncio.run(main())
"""


class _Fake:
    def __init__(self, block=False):
        self.block = block
        self.calls = 0

    async def run(self, prompt, *, model, system=None, images=()):
        self.calls += 1
        if self.block:
            await asyncio.sleep(3600)
        return "ok"


class AiLimitTests(unittest.IsolatedAsyncioTestCase):
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

    def use(self, concurrency, fake=None):
        """This test process shares the workers' settings file and lock directory."""
        settings = self.tmp / "settings.json"
        settings.write_text(
            json.dumps({"backend": "hermes", "concurrency": {"hermes": concurrency}})
        )
        env = patch.dict(os.environ, {"SUNDARK_SETTINGS": str(settings)})
        env.start()
        self.addCleanup(env.stop)
        if fake is not None:
            p = patch("app.ai.backends.get", return_value=fake)
            p.start()
            self.addCleanup(p.stop)
        return settings

    async def spawn(self, role, count=1, go=True, **extra):
        env = {
            **os.environ,
            "T": str(self.tmp),
            "ROLE": role,
            "SUNDARK_SETTINGS": str(self.tmp / "settings.json"),
            **extra,
        }
        for _ in range(count):
            self.procs.append(
                subprocess.Popen(
                    [sys.executable, "-c", WORKER], env=env, cwd=Path.cwd()
                )
            )
        await self.wait_for(lambda: self.count(f"ready-{role}-*") == count)
        if go:
            (self.tmp / f"go-{role}").touch()

    def count(self, pattern):
        return len(list(self.tmp.glob(pattern)))

    async def wait_for(self, condition):
        end = time.monotonic() + DEADLINE
        while not condition():
            for p in self.procs:
                self.assertIn(p.poll(), (None, 0, -9), "a worker failed")
            self.assertLess(time.monotonic(), end, "timed out")
            await asyncio.sleep(0.01)

    def break_gate(self, on_exit):
        """Gates release, then run on_exit (which raises); every lock made is kept alive,
        so only an explicit release can free the slot, never a destructor."""
        made, real = [], ai._file_lock

        class Gate:
            def __init__(self, lock):
                self.lock = lock

            async def __aenter__(self):
                await self.lock.acquire()

            async def __aexit__(self, *exc):
                await self.lock.release()
                await on_exit()

        def file_lock(path):
            made.append(real(path))
            return Gate(made[-1]) if path.suffix == ".gate" else made[-1]

        p = patch("app.ai._file_lock", side_effect=file_lock)
        p.start()
        self.addCleanup(p.stop)
        return made

    async def raised(self, awaitable):
        try:
            await awaitable
        except BaseException as exc:  # noqa: BLE001
            return exc
        self.fail("did not raise")

    def free(self, name):
        lock = FileLock(self.tmp / ".locks" / name, fallback_to_soft=False)
        try:
            lock.acquire(blocking=False)
        except Timeout:
            return False
        lock.release()
        return True

    async def test_two_processes_share_one_bound(self):
        self.use(2)
        await self.spawn("bound", count=2)
        await self.wait_for(lambda: self.count("peak-*") == 2)
        for p in self.procs:
            self.assertEqual(p.wait(timeout=DEADLINE), 0)
        peaks = [int(f.read_text()) for f in self.tmp.glob("peak-*")]
        self.assertTrue(all(1 <= peak <= 2 for peak in peaks), peaks)

    async def test_a_killed_holder_frees_its_slot(self):
        self.use(1, _Fake())
        await self.spawn("hold")
        await self.wait_for(lambda: self.count("held-*") == 1)
        call = asyncio.create_task(ai.explain("x"))
        await asyncio.sleep(0.3)
        self.assertFalse(call.done())
        self.procs[0].kill()
        self.assertEqual(await asyncio.wait_for(call, DEADLINE), "ok")

    async def test_cancelled_waiters_leave_nothing_held(self):
        # The worker holds both slots; one waiter here holds the gate, the other waits on it.
        self.use(2, _Fake())
        await self.spawn("hold", count=2)
        await self.wait_for(lambda: self.count("held-*") == 2)
        self.assertFalse(self.free("ai-hermes-0.lock") or self.free("ai-hermes-1.lock"))

        waiters = [asyncio.create_task(ai.explain("x")) for _ in range(2)]
        await self.wait_for(lambda: not self.free("ai-hermes.gate"))
        await asyncio.sleep(0.1)
        for w in waiters:
            w.cancel()
        results = await asyncio.gather(*waiters, return_exceptions=True)
        self.assertTrue(all(isinstance(r, asyncio.CancelledError) for r in results))
        self.assertTrue(self.free("ai-hermes.gate"))

        for p in self.procs:
            p.kill()
        self.assertEqual(await asyncio.wait_for(ai.explain("x"), DEADLINE), "ok")

    async def test_a_cancelled_running_call_frees_its_slot(self):
        blocked = _Fake(block=True)
        self.use(1, blocked)
        call = asyncio.create_task(ai.explain("x"))
        await self.wait_for(lambda: blocked.calls == 1)
        self.assertFalse(self.free("ai-hermes-0.lock"))
        call.cancel()
        with self.assertRaises(asyncio.CancelledError):
            await call
        self.assertTrue(self.free("ai-hermes-0.lock"))
        blocked.block = False
        self.assertEqual(await asyncio.wait_for(ai.explain("x"), DEADLINE), "ok")

    async def test_a_busy_process_does_not_starve_another(self):
        self.use(1)
        await self.spawn("late", go=False)
        await self.spawn("busy", HOLD="0.1")
        # B asks once A is already busy, then must not wait for all 20 of A's calls.
        await self.wait_for(lambda: (self.tmp / "a-done-0").exists())
        (self.tmp / "go-late").touch()
        await self.wait_for(lambda: (self.tmp / "b-result").exists())
        self.assertLess(int((self.tmp / "b-result").read_text()), 10)

    async def test_a_stream_holds_its_slot_until_closed(self):
        self.use(1, _Fake())
        await self.spawn("stream")
        await self.wait_for(lambda: (self.tmp / "streaming").exists())
        call = asyncio.create_task(ai.explain("x"))
        await asyncio.sleep(0.3)
        self.assertFalse(call.done())
        (self.tmp / "close").touch()
        self.assertEqual(await asyncio.wait_for(call, DEADLINE), "ok")
        self.assertTrue((self.tmp / "closed").exists())
        self.assertIsNone(self.procs[0].poll())  # closing freed the slot, not exiting

    async def test_waiting_for_a_slot_leaves_the_loop_running(self):
        self.use(1, _Fake())
        await self.spawn("hold")
        await self.wait_for(lambda: self.count("held-*") == 1)
        call = asyncio.create_task(ai.explain("x"))
        gaps, last = [], time.monotonic()
        end = last + 0.5
        while time.monotonic() < end:
            await asyncio.sleep(0.01)
            now = time.monotonic()
            gaps.append(now - last)
            last = now
        self.assertFalse(call.done())
        # A blocking wait would stall the loop for the whole half second.
        self.assertGreater(len(gaps), 5)
        self.assertLess(max(gaps), 0.25)
        call.cancel()
        with self.assertRaises(asyncio.CancelledError):
            await call

    async def test_a_lock_failure_is_a_clear_error(self):
        blocker = self.tmp / "file"
        blocker.write_text("")
        fake = _Fake()
        self.use(1)  # load() below reads the temp settings, never the real ones
        s = ai.settings.load()
        with (
            patch.dict(os.environ, {"SUNDARK_SETTINGS": str(blocker / "s.json")}),
            patch("app.ai.settings.load", return_value=s),
            patch("app.ai.backends.get", return_value=fake),
        ):
            with self.assertRaisesRegex(AIError, "Could not coordinate AI requests"):
                await ai.explain("x")
        self.assertEqual(fake.calls, 0)

    async def test_a_gate_release_failure_frees_the_slot(self):
        fake = _Fake()
        self.use(1, fake)

        async def fail():
            raise OSError("gate release failed")

        made = self.break_gate(fail)
        # Kept with its traceback (assertRaises would clear the frames).
        failure = await self.raised(ai.explain("x"))
        self.assertIsInstance(failure, AIError)
        self.assertEqual(str(failure), "Could not coordinate AI requests")
        self.assertIsInstance(failure.__cause__, OSError)
        self.assertIsNotNone(failure.__traceback__)
        self.assertEqual(fake.calls, 0)
        self.assertEqual(len(made), 2)  # the slot was taken before the gate failed
        self.assertTrue(self.free("ai-hermes-0.lock"))

    async def test_a_cancel_at_the_gate_frees_the_slot(self):
        fake = _Fake()
        self.use(1, fake)
        exiting = asyncio.Event()

        async def stall():
            exiting.set()
            await asyncio.sleep(3600)

        made = self.break_gate(stall)
        call = asyncio.create_task(ai.explain("x"))
        await asyncio.wait_for(exiting.wait(), DEADLINE)
        call.cancel()
        call.cancel()
        failure = await self.raised(call)
        self.assertIsInstance(failure, asyncio.CancelledError)
        self.assertIsNotNone(failure.__traceback__)
        self.assertEqual(fake.calls, 0)
        self.assertEqual(len(made), 2)
        self.assertTrue(self.free("ai-hermes-0.lock"))


if __name__ == "__main__":
    unittest.main()
