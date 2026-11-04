import unittest

from app.paper_id import identifiers, paper_id
from tests.pdfgen import make_pdf


class IdentifierTests(unittest.TestCase):
    def test_doi_from_metadata_wins_over_page_text(self):
        pdf = make_pdf(
            ["See also https://doi.org/10.9999/cited.1"],
            {"subject": "doi:10.0000/EXAMPLE.META.00002"},
        )
        self.assertEqual(identifiers(pdf)["doi"], "10.0000/example.meta.00002")

    def test_doi_from_first_page_strips_trailing_punctuation(self):
        pdf = make_pdf(["Title\nDOI: 10.0000/Example.Letter.00001).\nAbstract ..."])
        self.assertEqual(identifiers(pdf)["doi"], "10.0000/example.letter.00001")

    def test_arxiv_id_without_version(self):
        pdf = make_pdf(["arXiv:0000.00001v2 [cs.LG] 12 Jun 2025\nA Model for Learning"])
        self.assertEqual(identifiers(pdf), {"doi": None, "arxiv": "0000.00001"})

    def test_only_first_two_pages_are_read(self):
        pdf = make_pdf(["Intro", "Method", "References\n10.1000/late.ref"])
        self.assertEqual(identifiers(pdf), {"doi": None, "arxiv": None})

    def test_a_page_listing_many_dois_is_skipped(self):
        toc = "Example Discussions volume 1\n" + "\n".join(
            f"Paper {i}, Example Discuss., 2010 DOI: 10.0000/toc.0000{i}"
            for i in range(5)
        )
        pdf = make_pdf([toc, "Our paper\nDOI: 10.0000/our.paper\nAbstract"])
        self.assertEqual(identifiers(pdf)["doi"], "10.0000/our.paper")
        self.assertIsNone(identifiers(make_pdf([toc]))["doi"])


class PaperIdTests(unittest.TestCase):
    def test_priority_doi_arxiv_zotero_file(self):
        self.assertEqual(
            paper_id(fingerprint="f", doi="10.1/X", arxiv="2506.1", zotero_key="K"),
            "doi:10.1/x",
        )
        self.assertEqual(
            paper_id(fingerprint="f", arxiv="2506.1", zotero_key="K"), "arxiv:2506.1"
        )
        self.assertEqual(paper_id(fingerprint="f", zotero_key="K"), "zotero:K")
        self.assertEqual(paper_id(fingerprint="f"), "file:f")

    def test_arxiv_doi_becomes_arxiv_id(self):
        self.assertEqual(
            paper_id(fingerprint="f", doi="10.48550/arXiv.0000.00001"),
            "arxiv:0000.00001",
        )

    def test_arxiv_versions_share_one_id(self):
        v1 = identifiers(make_pdf(["arXiv:0000.00001v1 [cs.LG]"]))
        v2 = identifiers(make_pdf(["arXiv:0000.00001v2 [cs.LG] revised"]))
        self.assertEqual(
            paper_id(fingerprint="a", **v1), paper_id(fingerprint="b", **v2)
        )
