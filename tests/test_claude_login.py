import asyncio
import os
import unittest
from unittest.mock import AsyncMock, patch

from fastapi.testclient import TestClient

from app import main
from app.backends import claude


class FakeProc:
    def __init__(self):
        self.returncode = None
        self._done = asyncio.Event()

    async def wait(self):
        await self._done.wait()
        return self.returncode

    def kill(self):
        self.finish(-9)

    def finish(self, code):
        self.returncode = code
        self._done.set()


class ClaudeLoginTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.procs, self.calls = [], []
        patches = [
            patch.object(claude, "_login", None),
            patch.object(claude, "_login_watch", None),
            patch.dict(os.environ, {"ANTHROPIC_API_KEY": "sk-test"}),
            patch("app.backends.claude.asyncio.create_subprocess_exec", new=self.spawn),
        ]
        for p in patches:
            p.start()
            self.addCleanup(p.stop)

    async def spawn(self, *args, **kwargs):
        self.calls.append((args, kwargs))
        self.procs.append(FakeProc())
        return self.procs[-1]

    async def test_one_sign_in_runs_at_a_time_and_reports_its_end(self):
        self.assertEqual(claude.login_state(), "idle")
        await claude.start_login()
        await claude.start_login()
        self.assertEqual(len(self.procs), 1)
        args, kwargs = self.calls[0]
        self.assertEqual(args, ("claude", "auth", "login", "--claudeai"))
        self.assertEqual(kwargs["stdin"], asyncio.subprocess.DEVNULL)
        self.assertNotIn("ANTHROPIC_API_KEY", kwargs["env"])
        self.assertEqual(claude.login_state(), "running")
        self.procs[0].finish(0)
        await claude._login_watch
        self.assertEqual(claude.login_state(), "done")
        await claude.start_login()  # a later sign-in starts a new one
        self.assertEqual(len(self.procs), 2)

    async def test_a_sign_in_left_waiting_is_stopped(self):
        with patch.object(claude, "LOGIN_TIMEOUT", 0.01):
            await claude.start_login()
            await claude._login_watch
        self.assertEqual(claude.login_state(), "failed")


class ClaudeLoginApiTests(unittest.TestCase):
    def setUp(self):
        self.client = TestClient(main.app, base_url="http://127.0.0.1:8743")
        self.origin = {"Origin": "http://127.0.0.1:8743"}

    def test_sign_in_starts_only_from_this_page_on_this_computer(self):
        with (
            patch.object(main.claude_backend, "start_login", new=AsyncMock()) as start,
            patch.object(main.claude_backend, "login_state", return_value="running"),
        ):
            for headers in ({}, {"Origin": "https://example.org"}):
                r = self.client.post("/api/claude/login", headers=headers)
                self.assertEqual(r.status_code, 403)
            remote = TestClient(main.app, base_url="http://192.168.0.5:8743")
            r = remote.post(
                "/api/claude/login", headers={"Origin": "http://192.168.0.5:8743"}
            )
            self.assertEqual(r.status_code, 403)
            start.assert_not_awaited()
            r = self.client.post("/api/claude/login", headers=self.origin)
        self.assertEqual(r.status_code, 200)
        self.assertEqual(r.json(), {"state": "running"})
        start.assert_awaited_once()

    def test_state_says_whether_the_cli_is_signed_in_once_it_ended(self):
        with (
            patch.object(main.claude_backend, "login_state", return_value="running"),
            patch.object(main.claude_backend, "signed_in") as signed_in,
        ):
            r = self.client.get("/api/claude/login")
        self.assertEqual(r.json(), {"state": "running", "signed_in": None})
        signed_in.assert_not_called()
        with (
            patch.object(main.claude_backend, "login_state", return_value="done"),
            patch.object(main.claude_backend, "signed_in", return_value=True),
        ):
            r = self.client.get("/api/claude/login")
        self.assertEqual(r.json(), {"state": "done", "signed_in": True})


if __name__ == "__main__":
    unittest.main()
