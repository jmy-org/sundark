import json
import unittest
from unittest.mock import patch

from app.backends import hermes
from app.errors import AIError, ModelUnavailableError, RateLimitError


def lines(*events):
    async def fake(args, stdin, env, timeout=300):
        fake.stdin = json.loads(stdin)
        for e in events:
            yield json.dumps(e) + "\n"

    return fake


class HermesBackendTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        patcher = patch(
            "app.backends.hermes._command", return_value=["/hermes/python", "runner.py"]
        )
        patcher.start()
        self.addCleanup(patcher.stop)

    async def test_stream_and_run(self):
        fake = lines({"type": "delta", "text": "가"}, {"type": "result", "text": "가"})
        with patch("app.backends.hermes.stream_process", new=fake):
            self.assertEqual([d async for d in hermes.stream("p", model="m")], ["가"])
            self.assertEqual(await hermes.run("p", model="m", images=[b"PNG"]), "가")
        self.assertEqual(fake.stdin["images"], ["UE5H"])

    async def test_error_kinds_map_to_error_classes(self):
        for kind, cls in (
            ("rate_limit", RateLimitError),
            ("model_unavailable", ModelUnavailableError),
            ("other", AIError),
        ):
            with patch(
                "app.backends.hermes.stream_process",
                new=lines({"type": "error", "kind": kind}),
            ):
                with self.assertRaises(cls):
                    await hermes.run("p", model="m")

    async def test_missing_result_is_error(self):
        with patch(
            "app.backends.hermes.stream_process",
            new=lines({"type": "delta", "text": "x"}),
        ):
            with self.assertRaises(AIError):
                await hermes.run("p", model="m")

    def test_env_drops_gateway_identity(self):
        with patch.dict(
            "os.environ",
            {
                "HERMES_SESSION_ID": "s",
                "HERMES_GATEWAY_X": "g",
                "PYTHONPATH": "/x",
                "HOME": "/h",
            },
            clear=True,
        ):
            env = hermes._env()
        self.assertEqual(env.get("HOME"), "/h")
        self.assertEqual(env["HERMES_SAFE_MODE"], "1")
        for name in ("HERMES_SESSION_ID", "HERMES_GATEWAY_X", "PYTHONPATH"):
            self.assertNotIn(name, env)


class HermesPythonDiscoveryTests(unittest.TestCase):
    def test_follows_bash_exec_shim_to_the_venv_python(self):
        import os
        import tempfile
        from pathlib import Path

        with tempfile.TemporaryDirectory() as d:
            root = Path(d)
            venv_bin = root / "venv" / "bin"
            venv_bin.mkdir(parents=True)
            python = venv_bin / "python3"
            python.write_text("")
            python.chmod(0o755)
            real = venv_bin / "hermes"
            real.write_text(f"#!{python}\nimport hermes_cli\n")
            real.chmod(0o755)
            shim_dir = root / "bin"
            shim_dir.mkdir()
            decoy = shim_dir / "python3"  # a different Python next to the shim
            decoy.write_text("")
            decoy.chmod(0o755)
            shim = shim_dir / "hermes"
            shim.write_text(
                f'#!/usr/bin/env bash\nunset PYTHONPATH\nexec "{real}" "$@"\n'
            )
            shim.chmod(0o755)
            with (
                patch.dict(os.environ, {}, clear=False),
                patch("app.backends.hermes.shutil.which", return_value=str(shim)),
            ):
                os.environ.pop("HERMES_PYTHON", None)
                cmd = hermes._command()
                self.assertEqual(Path(cmd[0]).resolve(), python.resolve())
                self.assertEqual(cmd[1:], [str(hermes.RUNNER)])

    def test_store_launcher_runs_the_runner_through_hermes_bootstrap(self):
        """A store-Python launcher (`exec python3 -I -c '...multi-line...'`) is resolved with
        `hermes --print-runtime-command`; the bootstrap is kept and only the entry point is
        swapped for the runner."""
        import os
        import subprocess
        import tempfile
        from pathlib import Path

        bootstrap = (
            "import os, sys, runpy; sys.path.insert(0, '/h'); import hermes_bootstrap; "
            "runpy.run_module('hermes_cli.main', run_name='__main__', alter_sys=True)"
        )
        with tempfile.TemporaryDirectory() as d:
            launcher = Path(d) / "hermes"
            launcher.write_text(
                "#!/bin/sh\nexec /store/python3 -I -c 'import os\n"
                "os.environ.pop('\"'\"'PYTHONHOME'\"'\"', None)\n' \"$@\"\n"
            )
            launcher.chmod(0o755)
            done = subprocess.CompletedProcess(
                [],
                0,
                stdout=json.dumps(["/store/python3", "-I", "-c", bootstrap]),
                stderr="",
            )
            with (
                patch.dict(os.environ, {}, clear=False),
                patch("app.backends.hermes.shutil.which", return_value=str(launcher)),
                patch("app.backends.hermes.subprocess.run", return_value=done) as run,
            ):
                os.environ.pop("HERMES_PYTHON", None)
                hermes._runtime.cache_clear()
                cmd = hermes._command()
        self.assertEqual(
            run.call_args.args[0], [str(launcher), "--print-runtime-command"]
        )
        self.assertEqual(cmd[:3], ["/store/python3", "-I", "-c"])
        self.assertIn("import hermes_bootstrap", cmd[3])
        self.assertTrue(
            cmd[3].endswith(
                f"runpy.run_path({str(hermes.RUNNER)!r}, run_name='__main__')"
            )
        )
        self.assertNotIn("hermes_cli.main", cmd[3])

    def test_unparseable_launcher_is_an_ai_error_not_a_crash(self):
        import os
        import subprocess
        import tempfile
        from pathlib import Path

        with tempfile.TemporaryDirectory() as d:
            launcher = Path(d) / "hermes"
            launcher.write_text("#!/bin/sh\nexec /x/python3 -c 'unclosed\n")
            failed = subprocess.CompletedProcess([], 2, stdout="", stderr="usage")
            with (
                patch.dict(os.environ, {}, clear=False),
                patch("app.backends.hermes.shutil.which", return_value=str(launcher)),
                patch("app.backends.hermes.subprocess.run", return_value=failed),
            ):
                os.environ.pop("HERMES_PYTHON", None)
                hermes._runtime.cache_clear()
                with self.assertRaises(AIError):
                    hermes._command()
