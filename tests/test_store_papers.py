import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from app import store


class PaperStoreTests(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.TemporaryDirectory()
        root = Path(self.dir.name)
        self.patches = [
            patch.object(store, "PAPERS", root / "papers"),
            patch.object(store, "CHATS", root / "chats"),
            patch.object(store, "CACHE", root / "cache"),
        ]
        for p in self.patches:
            p.start()
        self.root = root

    def tearDown(self):
        for p in reversed(self.patches):
            p.stop()
        self.dir.cleanup()

    def test_paper_round_trip(self):
        self.assertIsNone(store.paper_get("doi:10.1/x"))
        store.paper_put(
            "doi:10.1/x",
            {"title": "T", "authors": [], "year": 2020, "source": "crossref"},
        )
        self.assertEqual(store.paper_get("doi:10.1/x")["title"], "T")
        self.assertEqual(store.paper_get("doi:10.1/x")["paper_id"], "doi:10.1/x")

    def test_unsafe_paper_ids_map_to_safe_files(self):
        pid = "doi:10.1002/(sici)1097-4636;2-<../../x>"
        store.paper_put(pid, {"title": "T"})
        store.chat_put(pid, [{"role": "user", "text": "q"}])
        files = list((self.root / "papers").iterdir()) + list(
            (self.root / "chats").glob("*.json")
        )
        self.assertEqual(len(files), 2)
        for f in files:
            self.assertRegex(f.name, r"^[0-9a-f]{16}\.json$")
        self.assertEqual(store.chat_get(pid), [{"role": "user", "text": "q"}])

    def test_chat_migrates_from_doc_id(self):
        (self.root / "chats").mkdir()
        old = [
            {"role": "user", "text": "old q"},
            {"role": "assistant", "text": "old a"},
        ]
        (self.root / "chats" / "abcdef0123456789.json").write_text(
            json.dumps(old), "utf-8"
        )
        store.chat_migrate("abcdef0123456789", "doi:10.1/x")
        self.assertEqual(store.chat_get("doi:10.1/x"), old)
        self.assertFalse((self.root / "chats" / "abcdef0123456789.json").exists())

    def test_migration_never_overwrites_an_existing_paper_chat(self):
        store.chat_put("doi:10.1/x", [{"role": "user", "text": "kept"}])
        (self.root / "chats" / "abcdef0123456789.json").write_text("[]", "utf-8")
        store.chat_migrate("abcdef0123456789", "doi:10.1/x")
        self.assertEqual(
            store.chat_get("doi:10.1/x"), [{"role": "user", "text": "kept"}]
        )

    def test_paper_cache_id_is_shared_by_one_paper(self):
        cid = store.paper_cache_id("arxiv:2506.09762")
        store.cache_put(cid, "brief_Korean_x", {"brief": "G"})
        self.assertEqual(
            store.cache_get(store.paper_cache_id("arxiv:2506.09762"), "brief_Korean_x"),
            {"brief": "G"},
        )
        self.assertNotEqual(cid, store.paper_cache_id("arxiv:2506.09763"))

    def test_json_replacement_keeps_old_complete_record_until_publication(self):
        with patch.object(store, "DOCS", self.root / "docs"):
            operations = (
                (
                    lambda value: store.cache_put("doc", "summary", value),
                    lambda: store.cache_get("doc", "summary"),
                ),
                (
                    lambda value: store.save_doc("doc", value),
                    lambda: store.load_doc("doc"),
                ),
                (
                    lambda value: store.paper_put("doi:example", value),
                    lambda: store.paper_get("doi:example"),
                ),
            )
            for write, read in operations:
                with self.subTest(write=write):
                    write({"text": "old"})
                    replace = store.os.replace

                    def inspect_then_fail(source, destination):
                        self.assertEqual(read()["text"], "old")
                        self.assertEqual(
                            json.loads(Path(source).read_text())["text"], "new"
                        )
                        raise OSError("injected publication failure")

                    with patch.object(
                        store.os, "replace", side_effect=inspect_then_fail
                    ):
                        with self.assertRaises(OSError):
                            write({"text": "new"})
                    self.assertEqual(read()["text"], "old")

                    def inspect_then_publish(source, destination):
                        self.assertEqual(read()["text"], "old")
                        return replace(source, destination)

                    with patch.object(
                        store.os, "replace", side_effect=inspect_then_publish
                    ):
                        write({"text": "new"})
                    self.assertEqual(read()["text"], "new")
            self.assertEqual(list(self.root.rglob("*.tmp")), [])
