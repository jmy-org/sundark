import os
import re
import tempfile
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, patch

from fastapi.testclient import TestClient

from app import main, settings, store


class SampleApiTests(unittest.TestCase):
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
            patch.object(main, "PAPERS_DIR", root / "library"),
            patch("app.main._schedule_prewarm", side_effect=lambda meta: meta),
            patch("app.main.biblio.lookup", new=AsyncMock(return_value=None)),
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

    def test_samples_are_offered_mamba_first(self):
        r = self.client.get("/api/samples")
        self.assertEqual(r.status_code, 200)
        ids = [s["id"] for s in r.json()["samples"]]
        self.assertEqual(ids, ["mamba", "chain-of-thought", "llama"])
        # Only what the start screen shows; no file names or paths.
        self.assertEqual(
            set(r.json()["samples"][0]), {"id", "title", "credit", "arxiv"}
        )

    def test_every_sample_is_attributed_as_cc_by(self):
        readme = (main.SAMPLES_DIR / "README.md").read_text()
        for s in main.SAMPLES:
            self.assertTrue((main.SAMPLES_DIR / s["file"]).is_file(), s["file"])
            row = next(line for line in readme.splitlines() if f"`{s['file']}`" in line)
            self.assertIn(f"https://arxiv.org/abs/{s['arxiv']}", row)
            self.assertIn("CC BY 4.0", row)
        listed = set(re.findall(r"`([^`]+\.pdf)`", readme))
        on_disk = {p.name for p in main.SAMPLES_DIR.glob("*.pdf")}
        self.assertEqual(listed, on_disk, "every shipped PDF has an attribution row")

    def test_open_sample_reads_one_page_and_leaves_the_library_alone(self):
        r = self.client.post("/api/samples/open", json={"id": "mamba"})
        self.assertEqual(r.status_code, 200, r.text)
        meta = r.json()
        self.assertEqual(meta["num_pages"], 1)
        self.assertIn("Mamba", meta["title"])
        self.assertEqual(list((self.root / "library").iterdir()), [])
        self.assertEqual(self.client.get("/api/papers").json()["papers"], [])

    def test_open_takes_an_id_never_a_path(self):
        for bad in ("../README.md", "README.md", "mamba-2312.00752v2-p1.pdf", ""):
            r = self.client.post("/api/samples/open", json={"id": bad})
            self.assertEqual(r.status_code, 404, bad)

    def test_missing_files_are_not_offered(self):
        with patch.object(main, "SAMPLES_DIR", self.root / "none"):
            self.assertEqual(self.client.get("/api/samples").json()["samples"], [])
            r = self.client.post("/api/samples/open", json={"id": "mamba"})
            self.assertEqual(r.status_code, 404)


if __name__ == "__main__":
    unittest.main()
