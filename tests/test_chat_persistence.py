import asyncio
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from app import service, store


class ChatPersistenceTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.root = Path(self.directory.name)
        self.patch = patch.object(store, "CHATS", self.root / "chats")
        self.patch.start()
        self.pid = "doi:10.1/example"

    def tearDown(self):
        self.patch.stop()
        self.directory.cleanup()

    async def test_absent_legacy_source_does_not_read_corrupt_destination(self):
        self.root.joinpath("chats").mkdir()
        destination = store._chat_path(self.pid)
        destination.write_text("corrupt history", encoding="utf-8")
        store.chat_migrate("missing-legacy", self.pid)
        self.assertEqual(destination.read_text("utf-8"), "corrupt history")
        with self.assertRaises(ValueError):
            store.chat_snapshot(self.pid)

    async def run_race(self, reset=False):
        entered = {q: asyncio.Event() for q in ("first", "second")}
        release = {q: asyncio.Event() for q in entered}

        async def answer(question, **kwargs):
            entered[question].set()
            await release[question].wait()
            return question.upper()

        with (
            patch.object(service, "_require_doc", return_value={"pages": []}),
            patch.object(service, "_paper_of", return_value=self.pid),
            patch.object(service.ai, "chat", side_effect=answer),
        ):
            first = asyncio.create_task(service.chat("doc", "first", "English"))
            second = asyncio.create_task(service.chat("doc", "second", "English"))
            await asyncio.wait_for(
                asyncio.gather(*(event.wait() for event in entered.values())), 5
            )
            if reset:
                await asyncio.to_thread(service.chat_reset, "doc")
            release["second"].set()
            if reset:
                with self.assertRaisesRegex(
                    service.InvalidRequestError, "history changed"
                ):
                    await second
            else:
                self.assertEqual(await second, "SECOND")
            release["first"].set()
            if reset:
                with self.assertRaisesRegex(
                    service.InvalidRequestError, "history changed"
                ):
                    await first
            else:
                self.assertEqual(await first, "FIRST")

    async def test_concurrent_completions_preserve_both_exchanges(self):
        await self.run_race()
        self.assertEqual(
            [turn["text"] for turn in store.chat_get(self.pid)],
            ["second", "SECOND", "first", "FIRST"],
        )

    async def test_reset_fences_inflight_answers_but_allows_new_requests(self):
        await self.run_race(reset=True)
        self.assertEqual(store.chat_get(self.pid), [])
        _, generation = store.chat_snapshot(self.pid)
        self.assertTrue(store.chat_append(self.pid, [{"text": "new"}], generation))
        self.assertEqual(store.chat_get(self.pid), [{"text": "new"}])

    async def test_atomic_replace_failure_keeps_previous_record(self):
        store.chat_put(self.pid, [{"text": "old"}])
        with patch.object(store.os, "replace", side_effect=OSError("injected")):
            with self.assertRaises(OSError):
                store.chat_clear(self.pid)
        self.assertEqual(store.chat_get(self.pid), [{"text": "old"}])
        self.assertEqual(list(store.CHATS.glob("*.tmp")), [])

    async def test_legacy_list_is_read_without_rewriting(self):
        store.CHATS.mkdir()
        path = store._chat_path(self.pid)
        original = json.dumps([{"text": "legacy"}])
        path.write_text(original)
        turns, generation = store.chat_snapshot(self.pid)
        self.assertEqual(path.read_text(), original)
        store.chat_append(self.pid, [{"text": "new"}], generation)
        self.assertEqual(store.chat_get(self.pid), turns + [{"text": "new"}])

    async def test_reset_blocks_legacy_migration_without_deleting_legacy_data(self):
        store.chat_clear(self.pid)
        legacy = store.CHATS / "abcdef0123456789.json"
        legacy.write_text(json.dumps([{"text": "old"}]))
        store.chat_migrate("abcdef0123456789", self.pid)
        self.assertEqual(store.chat_get(self.pid), [])
        self.assertTrue(legacy.exists())

    async def test_move_preserves_turns_and_fences_old_inflight_requests(self):
        store.chat_put(self.pid, [{"text": "old"}])
        _, generation = store.chat_snapshot(self.pid)
        store.chat_move(self.pid, "arxiv:1234.56789")
        self.assertFalse(store.chat_append(self.pid, [{"text": "late"}], generation))
        self.assertEqual(store.chat_get(self.pid), [])
        self.assertEqual(store.chat_get("arxiv:1234.56789"), [{"text": "old"}])

    async def test_processes_append_and_restart_preserves_reset_fence(self):
        code = """
import json, sys
from pathlib import Path
from app import store
store.CHATS = Path(sys.argv[1])
pid = sys.argv[2]
_, generation = store.chat_snapshot(pid)
print(generation, flush=True)
sys.stdin.readline()
print(json.dumps(store.chat_append(pid, [{"text": sys.argv[3]}], generation)), flush=True)
"""
        children = [
            subprocess.Popen(
                [sys.executable, "-c", code, str(store.CHATS), self.pid, str(i)],
                stdin=subprocess.PIPE,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
            )
            for i in range(2)
        ]
        try:
            for child in children:
                self.assertEqual(child.stdout.readline().strip(), "legacy")
            for child in children:
                child.stdin.write("go\n")
                child.stdin.flush()
            for child in children:
                output, error = child.communicate(timeout=10)
                self.assertEqual(child.returncode, 0, error)
                self.assertEqual(output.strip(), "true")
            self.assertEqual(
                sorted(turn["text"] for turn in store.chat_get(self.pid)), ["0", "1"]
            )
            _, old_generation = store.chat_snapshot(self.pid)
            store.chat_clear(self.pid)
            result = subprocess.run(
                [sys.executable, "-c", code, str(store.CHATS), self.pid, "fresh"],
                input="go\n",
                capture_output=True,
                text=True,
                timeout=10,
            )
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertNotEqual(result.stdout.splitlines()[0], old_generation)
            self.assertFalse(
                store.chat_append(self.pid, [{"text": "stale"}], old_generation)
            )
            self.assertEqual(store.chat_get(self.pid), [{"text": "fresh"}])
        finally:
            for child in children:
                if child.poll() is None:
                    child.kill()
                    child.communicate()

    async def test_repeated_identity_corrections_keep_appends_and_fence_snapshots(self):
        file_pid = "file:abcdef0123456789"
        store.chat_put(file_pid, [{"text": "original"}])
        expected = [{"text": "original"}]
        current = file_pid
        for target in (self.pid, file_pid, self.pid, "arxiv:1234", file_pid):
            _, stale = store.chat_snapshot(current)
            store.chat_move(current, target)
            self.assertFalse(store.chat_append(current, [{"text": "late"}], stale))
            self.assertEqual(store.chat_get(current), [])
            self.assertEqual(store.chat_get(target), expected)
            _, generation = store.chat_snapshot(target)
            turn = {"text": target}
            self.assertTrue(store.chat_append(target, [turn], generation))
            expected.append(turn)
            current = target

    async def test_reset_at_either_identity_prevents_history_return(self):
        for reset_old in (True, False):
            with self.subTest(reset_old=reset_old):
                old, new = f"file:{reset_old}", f"doi:{reset_old}"
                store.chat_put(old, [{"text": "original"}])
                store.chat_move(old, new)
                store.chat_clear(old if reset_old else new)
                store.chat_move(new, old)
                self.assertEqual(store.chat_get(old), [])
                self.assertEqual(
                    store.chat_get(new), [{"text": "original"}] if reset_old else []
                )

    async def test_new_history_at_vacated_id_is_not_overwritten_or_merged(self):
        store.chat_put(self.pid, [{"text": "original"}])
        other = "file:other"
        store.chat_move(self.pid, other)
        _, generation = store.chat_snapshot(self.pid)
        store.chat_append(self.pid, [{"text": "independent"}], generation)
        store.chat_move(other, self.pid)
        self.assertEqual(store.chat_get(self.pid), [{"text": "independent"}])
        self.assertEqual(store.chat_get(other), [{"text": "original"}])
        store.chat_move(self.pid, "file:third")
        store.chat_move(other, self.pid)
        self.assertEqual(store.chat_get(self.pid), [])
        self.assertEqual(store.chat_get(other), [{"text": "original"}])

    async def test_migration_cannot_fill_move_fence_or_replay_vacated_source(self):
        store.chat_put(self.pid, [{"text": "original"}])
        other = "file:other"
        store.chat_move(self.pid, other)
        legacy = store.CHATS / "abcdef0123456789.json"
        legacy.write_text(json.dumps([{"text": "legacy"}]))
        store.chat_migrate("abcdef0123456789", self.pid)
        self.assertTrue(legacy.exists())
        self.assertEqual(store.chat_get(self.pid), [])
        store.chat_move(self.pid, "file:third")
        self.assertFalse(store._chat_path("file:third").exists())
        store.chat_move(other, self.pid)
        self.assertEqual(store.chat_get(self.pid), [{"text": "original"}])

    async def test_failed_source_fence_preserves_both_copies(self):
        store.chat_put(self.pid, [{"text": "original"}])
        other = "file:other"
        replace = store.os.replace

        def fail_source(source, destination):
            if destination == store._chat_path(self.pid):
                raise OSError("injected source fence failure")
            return replace(source, destination)

        with patch.object(store.os, "replace", side_effect=fail_source):
            with self.assertRaises(OSError):
                store.chat_move(self.pid, other)
        self.assertEqual(store.chat_get(self.pid), [{"text": "original"}])
        self.assertEqual(store.chat_get(other), [{"text": "original"}])
        store.chat_move(self.pid, other)
        self.assertEqual(store.chat_get(self.pid), [{"text": "original"}])

    async def test_invalid_records_fail_closed_without_rewriting(self):
        store.CHATS.mkdir()
        path = store._chat_path(self.pid)
        store.chat_put("file:other", [{"text": "source history"}])
        (store.CHATS / "abcdef0123456789.json").write_text("[]")
        invalid = [
            "{broken",
            "null",
            '"text"',
            '{"turns": [], "generation": null}',
            '{"turns": [], "generation": 1}',
            '{"turns": [], "generation": ""}',
            '{"turns": {}, "generation": "valid"}',
            '{"turns": [], "generation": "valid", "move_id": 1}',
            '{"turns": [], "generation": "valid", "moved": true}',
        ]
        for original in invalid:
            with self.subTest(original=original):
                path.write_text(original)
                self.assertEqual(store.chat_get(self.pid), [])
                operations = (
                    lambda: store.chat_snapshot(self.pid),
                    lambda: store.chat_put(self.pid, [{"text": "new"}]),
                    lambda: store.chat_append(self.pid, [], "legacy"),
                    lambda: store.chat_clear(self.pid),
                    lambda: store.chat_move(self.pid, "file:other"),
                    lambda: store.chat_move("file:other", self.pid),
                    lambda: store.chat_migrate("abcdef0123456789", self.pid),
                )
                for operation in operations:
                    with self.assertRaises(ValueError):
                        operation()
                    self.assertEqual(path.read_text(), original)

    async def test_unreadable_record_fails_closed(self):
        store.chat_put(self.pid, [{"text": "original"}])
        original = store._chat_path(self.pid).read_bytes()
        with patch.object(Path, "read_text", side_effect=PermissionError("denied")):
            self.assertEqual(store.chat_get(self.pid), [])
            for operation in (
                lambda: store.chat_snapshot(self.pid),
                lambda: store.chat_put(self.pid, []),
                lambda: store.chat_append(self.pid, [], "legacy"),
                lambda: store.chat_clear(self.pid),
                lambda: store.chat_move(self.pid, "file:other"),
            ):
                with self.assertRaises(PermissionError):
                    operation()
        self.assertEqual(store._chat_path(self.pid).read_bytes(), original)

    async def test_existing_empty_history_and_unrelated_move_fence_block_move(self):
        store.chat_put(self.pid, [{"text": "original"}])
        store.chat_put("file:empty", [])
        store.chat_move(self.pid, "file:empty")
        self.assertEqual(store.chat_get(self.pid), [{"text": "original"}])
        store.chat_put("file:unrelated", [{"text": "unrelated"}])
        store.chat_move("file:unrelated", "file:elsewhere")
        store.chat_move(self.pid, "file:unrelated")
        self.assertEqual(store.chat_get(self.pid), [{"text": "original"}])
        self.assertEqual(store.chat_get("file:unrelated"), [])
        self.assertEqual(store.chat_get("file:elsewhere"), [{"text": "unrelated"}])

    async def test_corrupt_legacy_migration_source_is_preserved(self):
        store.CHATS.mkdir()
        legacy = store.CHATS / "abcdef0123456789.json"
        legacy.write_bytes(b"\xffinvalid utf8")
        with self.assertRaises(UnicodeDecodeError):
            store.chat_migrate("abcdef0123456789", self.pid)
        self.assertEqual(legacy.read_bytes(), b"\xffinvalid utf8")
        self.assertFalse(store._chat_path(self.pid).exists())

    async def test_migrated_legacy_chat_survives_identity_round_trip(self):
        store.CHATS.mkdir()
        legacy = store.CHATS / "abcdef0123456789.json"
        legacy.write_text(json.dumps([{"text": "legacy"}]))
        file_pid = "file:abcdef0123456789"
        store.chat_migrate("abcdef0123456789", file_pid)
        store.chat_move(file_pid, self.pid)
        _, generation = store.chat_snapshot(self.pid)
        store.chat_append(self.pid, [{"text": "new"}], generation)
        store.chat_move(self.pid, file_pid)
        self.assertEqual(
            store.chat_get(file_pid), [{"text": "legacy"}, {"text": "new"}]
        )
        self.assertFalse(legacy.exists())
