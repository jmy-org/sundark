import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, patch

from fastapi.testclient import TestClient

from app import main, settings, store
from tests.pdfgen import make_pdf

TITLE = "A Simple Model of Hard Disks From Dense Packing to Free Flow"
RECORD = {
    "title": TITLE,
    "authors": ["A. Lee", "B. Li"],
    "year": 2015,
    "source": "crossref",
}
PAGE = f"PHYSICAL REVIEW LETTERS\n{TITLE}\nA. Lee and B. Li\nDOI: 10.0000/Example.Letter.00001"


class PaperApiTests(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.TemporaryDirectory()
        root = Path(self.dir.name)
        self.patches = [
            patch.dict(os.environ, {"SUNDARK_SETTINGS": str(root / "settings.json")}),
            patch.object(store, "PDFS", root / "pdfs"),
            patch.object(store, "DOCS", root / "docs"),
            patch.object(store, "CACHE", root / "cache"),
            patch.object(store, "CHATS", root / "chats"),
            patch.object(store, "PAPERS", root / "papers"),
            patch.object(store, "TRASH", root / "trash"),
            # upload() copies each PDF into the library folder; keep it out of papers/
            patch.object(main, "PAPERS_DIR", root / "library"),
            patch("app.main._schedule_prewarm", side_effect=lambda meta: meta),
        ]
        for p in self.patches:
            p.start()
        for d in ("pdfs", "docs", "cache", "library"):
            (root / d).mkdir()
        self.root = root
        settings.save("hermes", {}, 8)
        self.client = TestClient(main.app)

    def tearDown(self):
        for p in reversed(self.patches):
            p.stop()
        self.dir.cleanup()

    def upload(self, pdf):
        r = self.client.post(
            "/api/upload", files={"file": ("p.pdf", pdf, "application/pdf")}
        )
        self.assertEqual(r.status_code, 200, r.text)
        return r.json()

    def test_doi_paper_gets_record_title_and_byline(self):
        with patch("app.main.biblio.lookup", new=AsyncMock(return_value=RECORD)):
            meta = self.upload(make_pdf([PAGE]))
        self.assertEqual(meta["paper_id"], "doi:10.0000/example.letter.00001")
        self.assertEqual(meta["title"], TITLE)
        self.assertEqual(meta["byline"], "A. Lee, B. Li (2015)")

    def test_doi_from_a_citation_is_rejected(self):
        other = {**RECORD, "title": "Fast sorting of images with small models"}
        with patch("app.main.biblio.lookup", new=AsyncMock(return_value=other)):
            meta = self.upload(make_pdf([PAGE]))
        self.assertEqual(meta["paper_id"], f"file:{meta['doc_id']}")
        self.assertIsNone(store.paper_get("doi:10.0000/example.letter.00001"))
        self.assertEqual(meta["byline"], "")

    def test_offline_open_uses_pdf_title_then_fills_record_later(self):
        pdf = make_pdf([PAGE])
        with patch("app.main.biblio.lookup", new=AsyncMock(return_value=None)):
            first = self.upload(pdf)
        self.assertEqual(first["paper_id"], "doi:10.0000/example.letter.00001")
        self.assertEqual(first["byline"], "")
        with patch(
            "app.main.biblio.lookup", new=AsyncMock(return_value=RECORD)
        ) as lookup:
            second = self.upload(pdf)
        lookup.assert_awaited_once()
        self.assertEqual(second["title"], TITLE)

    def test_two_files_of_one_paper_share_chat(self):
        with patch("app.main.biblio.lookup", new=AsyncMock(return_value=RECORD)):
            a = self.upload(make_pdf([PAGE]))
            b = self.upload(make_pdf([PAGE + "\n(annotated copy)"]))
        self.assertNotEqual(a["doc_id"], b["doc_id"])
        with patch("app.main.ai.chat", new=AsyncMock(return_value="A1")):
            self.client.post(
                "/api/chat", json={"doc_id": a["doc_id"], "question": "Q1"}
            )
        turns = self.client.get(f"/api/chat/{b['doc_id']}").json()["turns"]
        self.assertEqual([t["text"] for t in turns], ["Q1", "A1"])

    def test_legacy_doc_chat_still_visible(self):
        with patch("app.main.biblio.lookup", new=AsyncMock(return_value=RECORD)):
            meta = self.upload(make_pdf([PAGE]))
        doc = store.load_doc(meta["doc_id"])
        del doc["meta"]["paper_id"]  # a doc ingested before Paper IDs existed
        store.save_doc(meta["doc_id"], doc)
        store.chat_clear(meta["paper_id"])
        (self.root / "chats").mkdir(exist_ok=True)
        (self.root / "chats" / f"{meta['doc_id']}.json").write_text(
            json.dumps([{"role": "user", "text": "legacy"}]), "utf-8"
        )
        turns = self.client.get(f"/api/chat/{meta['doc_id']}").json()["turns"]
        self.assertEqual(turns, [{"role": "user", "text": "legacy"}])

    def test_zotero_doi_overrides_pdf_doi(self):
        import asyncio

        with patch("app.main.biblio.lookup", new=AsyncMock(return_value=RECORD)):
            meta = asyncio.run(
                main._ingest(
                    make_pdf([PAGE]), {"key": "ABCD1234", "doi": "10.5555/Zot"}
                )
            )
        self.assertEqual(meta["paper_id"], "doi:10.5555/zot")

    def test_no_identifier_uses_file_fingerprint_without_network(self):
        with patch(
            "app.main.biblio.lookup",
            new=AsyncMock(side_effect=AssertionError("no lookup")),
        ):
            meta = self.upload(make_pdf(["A paper with no identifiers at all"]))
        self.assertEqual(meta["paper_id"], f"file:{meta['doc_id']}")

    def test_cached_record_of_a_cited_doi_is_not_inherited(self):
        with patch("app.main.biblio.lookup", new=AsyncMock(return_value=RECORD)):
            self.upload(make_pdf([PAGE]))  # paper P: its record is now cached
        citing = "A Different Preprint About Hard Disks\nWe build on [1].\n[1] DOI: 10.0000/Example.Letter.00001"
        with patch("app.main.biblio.lookup", new=AsyncMock(return_value=RECORD)):
            q = self.upload(make_pdf([citing]))
        self.assertEqual(q["paper_id"], f"file:{q['doc_id']}")
        self.assertNotEqual(q["title"], TITLE)
        self.assertEqual(q["byline"], "")

    def test_rejected_doi_falls_back_to_the_arxiv_id(self):
        page = "arXiv:0000.00001v2 [cs.LG]\nOur Own Preprint Title\n[1] DOI: 10.0000/Example.Letter.00001"

        async def lookup(pid):
            return (
                RECORD
                if pid.startswith("doi:")
                else {
                    "title": "Our Own Preprint Title",
                    "authors": ["A B"],
                    "year": 2025,
                    "source": "arxiv",
                }
            )

        with patch("app.main.biblio.lookup", new=lookup):
            meta = self.upload(make_pdf([page]))
        self.assertEqual(meta["paper_id"], "arxiv:0000.00001")

    def test_chat_read_before_identification_follows_the_paper(self):
        pdf = make_pdf([PAGE])
        with patch("app.main.biblio.lookup", new=AsyncMock(return_value=RECORD)):
            meta = self.upload(pdf)
        doc = store.load_doc(meta["doc_id"])
        del doc["meta"]["paper_id"]  # ingested before Paper IDs existed
        store.save_doc(meta["doc_id"], doc)
        store.chat_clear(meta["paper_id"])
        (self.root / "chats").mkdir(exist_ok=True)
        (self.root / "chats" / f"{meta['doc_id']}.json").write_text(
            json.dumps([{"role": "user", "text": "legacy"}]), "utf-8"
        )
        self.client.get(f"/api/chat/{meta['doc_id']}")  # an old open tab asks first
        with patch("app.main.biblio.lookup", new=AsyncMock(return_value=RECORD)):
            again = self.upload(pdf)
        self.assertEqual(again["paper_id"], "doi:10.0000/example.letter.00001")
        turns = self.client.get(f"/api/chat/{meta['doc_id']}").json()["turns"]
        self.assertEqual(turns, [{"role": "user", "text": "legacy"}])

    def test_library_title_never_comes_from_an_unvalidated_doi(self):
        with patch("app.main.biblio.lookup", new=AsyncMock(return_value=RECORD)):
            self.upload(make_pdf([PAGE]))
        citing = make_pdf(
            ["Citing Paper Own Title\n[1] DOI: 10.0000/Example.Letter.00001"]
        )
        lib = self.root / "lib"
        lib.mkdir()
        (lib / "q.pdf").write_bytes(citing)
        with (
            patch.object(main, "PAPERS_DIR", lib),
            patch.object(main, "_titles", {}),
            patch.object(main, "_TITLES_FILE", self.root / "titles.json"),
            patch("app.main.biblio.lookup", new=AsyncMock(return_value=RECORD)),
        ):
            self.upload(citing)  # opening it validates and rejects the cited DOI
            names = [p["name"] for p in self.client.get("/api/papers").json()["papers"]]
        self.assertNotIn(TITLE, names)

    def test_docs_extracted_by_an_older_version_are_re_extracted(self):
        pdf = make_pdf([PAGE])
        with patch("app.main.biblio.lookup", new=AsyncMock(return_value=RECORD)):
            meta = self.upload(pdf)
        doc = store.load_doc(meta["doc_id"])
        doc["pages"] = ["stale text ~1!"]
        del doc["meta"]["text_version"]
        store.save_doc(meta["doc_id"], doc)
        with patch("app.main.biblio.lookup", new=AsyncMock(return_value=RECORD)):
            again = self.upload(pdf)
        fresh = store.load_doc(meta["doc_id"])
        self.assertNotEqual(fresh["pages"], ["stale text ~1!"])
        self.assertEqual(fresh["meta"]["paper_id"], meta["paper_id"])
        self.assertEqual(again["paper_id"], meta["paper_id"])

    def test_record_title_is_shown_as_plain_text(self):
        # arXiv titles carry TeX ("$\\alpha_1$-Net: ...")
        tex = {**RECORD, "title": "$\\alpha_1$: " + TITLE}
        with patch("app.main.biblio.lookup", new=AsyncMock(return_value=tex)):
            meta = self.upload(make_pdf([PAGE]))
        self.assertEqual(meta["title"], "α₁: " + TITLE)

    def test_library_title_read_by_an_older_version_is_read_again(self):
        lib = self.root / "lib"
        lib.mkdir()
        path = lib / "q.pdf"
        path.write_bytes(make_pdf([PAGE]))
        st = path.stat()
        old = {
            f"q.pdf:{int(st.st_mtime)}:{st.st_size}": {"title": "Stale", "doc_id": None}
        }
        with (
            patch.object(main, "PAPERS_DIR", lib),
            patch.object(main, "_titles", old),
            patch.object(main, "_TITLES_FILE", self.root / "titles.json"),
        ):
            names = [p["name"] for p in self.client.get("/api/papers").json()["papers"]]
        self.assertNotIn("Stale", names)

    def _library(self, *names):
        # resolved, as main.PAPERS_DIR is: a macOS temp dir lies behind a symlink (/var)
        lib = (self.root / "lib").resolve()
        (lib / "sub").mkdir(parents=True)
        for name in names:
            (lib / name).write_bytes(make_pdf([PAGE]))
        return lib

    def test_remove_moves_the_pdf_to_trash_and_keeps_its_data(self):
        lib = self._library("q.pdf", "sub/r.pdf")
        with (
            patch.object(main, "PAPERS_DIR", lib),
            patch.object(main, "_titles", {}),
            patch.object(main, "_TITLES_FILE", self.root / "titles.json"),
            patch("app.main.biblio.lookup", new=AsyncMock(return_value=RECORD)),
        ):
            meta = self.client.post("/api/open", json={"rel": "q.pdf"}).json()
            store.chat_put(meta["paper_id"], [{"role": "user", "content": "hi"}])
            r = self.client.post("/api/papers/remove", json={"rel": "q.pdf"})
            self.assertEqual(r.status_code, 200, r.text)
            self.assertEqual(
                self.client.post(
                    "/api/papers/remove", json={"rel": "sub/r.pdf"}
                ).status_code,
                200,
            )
            files = [p["rel"] for p in self.client.get("/api/papers").json()["papers"]]
        self.assertEqual(files, [])
        self.assertTrue((self.root / "trash" / "q.pdf").is_file())
        self.assertTrue((self.root / "trash" / "sub" / "r.pdf").is_file())
        # nothing keyed by the file or the paper is touched
        self.assertIsNotNone(store.load_doc(meta["doc_id"]))
        self.assertEqual(len(store.chat_get(meta["paper_id"])), 1)

    def test_remove_keeps_an_earlier_trashed_copy(self):
        lib = self._library("q.pdf")
        (self.root / "trash").mkdir()
        (self.root / "trash" / "q.pdf").write_bytes(b"earlier")
        with patch.object(main, "PAPERS_DIR", lib):
            r = self.client.post("/api/papers/remove", json={"rel": "q.pdf"})
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual((self.root / "trash" / "q.pdf").read_bytes(), b"earlier")
        self.assertTrue((self.root / "trash" / "q-1.pdf").is_file())

    def test_remove_only_touches_pdfs_inside_the_library(self):
        lib = self._library("q.pdf")
        outside = self.root / "outside.pdf"
        outside.write_bytes(make_pdf([PAGE]))
        (lib / "notes.txt").write_text("x")
        with patch.object(main, "PAPERS_DIR", lib):
            for rel, code in (
                ("../outside.pdf", 400),
                ("missing.pdf", 404),
                ("notes.txt", 404),
            ):
                r = self.client.post("/api/papers/remove", json={"rel": rel})
                self.assertEqual(r.status_code, code, rel)
        self.assertTrue(outside.is_file())
        self.assertTrue((lib / "notes.txt").is_file())
        self.assertFalse((self.root / "trash").exists())

    def test_remove_moves_a_symlink_itself_not_its_target(self):
        lib = self._library("q.pdf")
        outside = self.root / "outside.pdf"
        outside.write_bytes(make_pdf([PAGE]))
        try:
            os.symlink(lib / "q.pdf", lib / "q-link.pdf")
            os.symlink(outside, lib / "out-link.pdf")
        except (OSError, NotImplementedError):
            self.skipTest("symlinks are not available here")
        with patch.object(main, "PAPERS_DIR", lib):
            for rel in ("q-link.pdf", "out-link.pdf"):
                r = self.client.post("/api/papers/remove", json={"rel": rel})
                self.assertEqual(r.status_code, 200, r.text)
        # the other entry and the outside file are untouched; only the links moved
        self.assertTrue((lib / "q.pdf").is_file())
        self.assertTrue(outside.is_file())
        self.assertTrue((self.root / "trash" / "q-link.pdf").is_symlink())
        self.assertTrue((self.root / "trash" / "out-link.pdf").is_symlink())

    def test_a_failed_move_is_reported_and_leaves_no_copy(self):
        lib = self._library("q.pdf")
        trashed = self.root / "trash" / "q.pdf"

        def copy_then_fail(src, dst):
            # a move across disks copies first; the delete that follows fails
            Path(dst).write_bytes(Path(src).read_bytes())
            raise PermissionError("read-only folder")

        with (
            patch.object(main, "PAPERS_DIR", lib),
            patch("app.main.shutil.move", side_effect=copy_then_fail),
        ):
            r = self.client.post("/api/papers/remove", json={"rel": "q.pdf"})
        self.assertEqual(r.status_code, 500)
        self.assertEqual(r.json()["detail"], "Could not move the PDF to data/trash")
        self.assertTrue((lib / "q.pdf").is_file())
        self.assertFalse(trashed.exists())
