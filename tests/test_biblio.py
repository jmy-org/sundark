import json
import unittest
from unittest.mock import patch

from app import biblio

CROSSREF = {
    "message": {
        "title": ["A Simple Model of Hard Disks:  From Dense Packing\n to Free Flow"],
        "author": [
            {"given": "Ann C.", "family": "Lee"},
            {"given": "Bo", "family": "Li"},
        ],
        "issued": {"date-parts": [[2015, 1, 21]]},
    }
}
ARXIV = b"""<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom"><entry>
<title>A Model for Learning
 from Data</title><published>2025-06-11T00:00:00Z</published>
<author><name>Ann Lee</name></author><author><name>Bo Li</name></author>
</entry></feed>"""


class LookupTests(unittest.IsolatedAsyncioTestCase):
    async def test_crossref_record(self):
        seen = []

        def fake(url):
            seen.append(url)
            return json.dumps(CROSSREF).encode()

        with patch("app.biblio._get", new=fake):
            rec = await biblio.lookup("doi:10.0000/example.letter.00001")
        self.assertEqual(
            rec,
            {
                "title": "A Simple Model of Hard Disks: From Dense Packing to Free Flow",
                "authors": ["Ann C. Lee", "Bo Li"],
                "year": 2015,
                "source": "crossref",
            },
        )
        self.assertEqual(
            seen, ["https://api.crossref.org/works/10.0000/example.letter.00001"]
        )

    async def test_arxiv_record(self):
        with patch("app.biblio._get", return_value=ARXIV):
            rec = await biblio.lookup("arxiv:0000.00001")
        self.assertEqual(
            rec["title"],
            "A Model for Learning from Data",
        )
        self.assertEqual(rec["authors"], ["Ann Lee", "Bo Li"])
        self.assertEqual((rec["year"], rec["source"]), (2025, "arxiv"))

    async def test_network_or_parse_failure_is_none(self):
        for error in (OSError("offline"), ValueError("bad json")):
            with patch("app.biblio._get", side_effect=error):
                self.assertIsNone(await biblio.lookup("doi:10.1/x"))
        with patch(
            "app.biblio._get",
            return_value=b"<feed xmlns='http://www.w3.org/2005/Atom'/>",
        ):
            self.assertIsNone(await biblio.lookup("arxiv:0000.00001"))

    async def test_file_and_zotero_ids_are_not_looked_up(self):
        with patch("app.biblio._get", side_effect=AssertionError("no network")):
            self.assertIsNone(await biblio.lookup("file:abc"))
            self.assertIsNone(await biblio.lookup("zotero:ABCD1234"))


class MatchTests(unittest.TestCase):
    PAGE = "PHYSICAL REVIEW LETTERS\nA Simple Model of Hard Disks: From Dense Packing\nto Free Flow\nAnn C. Lee"

    def test_title_matches_its_own_first_page(self):
        self.assertTrue(
            biblio.title_matches(CROSSREF["message"]["title"][0], self.PAGE)
        )

    def test_title_matches_rejects_unrelated_title(self):
        self.assertFalse(
            biblio.title_matches("Fast sorting of images with small models", self.PAGE)
        )

    def test_byline(self):
        self.assertEqual(
            biblio.byline({"authors": ["A B", "C D", "E F"], "year": 2020}),
            "A B et al. (2020)",
        )
        self.assertEqual(
            biblio.byline({"authors": ["A B", "C D"], "year": None}), "A B, C D"
        )
        self.assertEqual(biblio.byline(None), "")

    def test_title_matches_korean_and_ligatures(self):
        self.assertTrue(
            biblio.title_matches(
                "고분자 용융체의 상전이 연구",
                "한국고분자학회지\n고분자 용융체의 상전이 연구\n홍길동",
            )
        )
        self.assertTrue(
            biblio.title_matches(
                "Efficient Diffusion Models for Image Classification",
                "E\ufb03cient Di\ufb00usion Models for Image Classi\ufb01cation",
            )
        )


class LookupRobustnessTests(unittest.IsolatedAsyncioTestCase):
    async def test_any_http_failure_is_none(self):
        import http.client

        with patch("app.biblio._get", side_effect=http.client.IncompleteRead(b"")):
            self.assertIsNone(await biblio.lookup("doi:10.1/x"))


class PlainTitleTests(unittest.TestCase):
    def test_arxiv_tex_reads_as_text(self):
        for tex, plain in (
            ("$\\alpha_1$-Net: A Model", "α₁-Net: A Model"),
            ("$β_2$-Net", "β₂-Net"),
            ("$k$-means revisited", "k-means revisited"),
            ("Model$^2$", "Model²"),
            ("$\\text{CO}_2$ Emissions", "CO₂ Emissions"),
            ("$\\mathcal{O}(n^2)$ attention", "O(n²) attention"),
            ("Toward $\\infty$ Context", "Toward ∞ Context"),
            ("Learning $\\pi_t$", "Learning πt"),
            ("A \\$100 model", "A $100 model"),
        ):
            self.assertEqual(biblio.plain_title(tex), plain)

    def test_crossref_tags_read_as_text(self):
        self.assertEqual(
            biblio.plain_title(
                "Growth of <i>Drosophila</i> in H<sub>2</sub>O &amp; air"
            ),
            "Growth of Drosophila in H₂O & air",
        )

    def test_a_plain_title_is_unchanged(self):
        title = CROSSREF["message"]["title"][0]
        self.assertEqual(biblio.plain_title(title), biblio._squash(title))
