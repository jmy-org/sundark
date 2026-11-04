"""A heading is one model title box, and an appendix cover's copy of the front matter is dropped.

A title wrapped over two lines came out as two headings ("5 OPTIMIZATION WITH ADAPTIVE DENSITY" |
"CONTROL OF 3D GAUSSIANS"), and the sentence splitter cut "A.1. Pre-training" after "A.1.". The
appendix of 2007.06559 opens on a cover that repeats the paper's title and author line; the model
typed the author line as a title, so the authors became four headings."""

import unittest
from unittest.mock import patch

import pymupdf

from app import pdf_utils

TEXT = "The method keeps working well on every page."


def title(y0: float, y1: float) -> dict:
    return {"role": "title", "x0": 40, "y0": y0, "x1": 500, "y1": y1}


def _layout(data: bytes, page: int, regions: dict[int, list[dict]]) -> list[dict]:
    with patch.object(
        pdf_utils.layout_model,
        "detect_page",
        side_effect=lambda p: regions.get(p.number, []),
    ):
        return pdf_utils._page_layout(data, page)["sentences"]


def _headings(sentences: list[dict]) -> list[str]:
    return [s["text"] for s in sentences if s["heading"]]


class TitleBoxTests(unittest.TestCase):
    def setUp(self):
        doc = pymupdf.open()
        doc.new_page(width=595, height=842)
        p = doc.new_page(width=595, height=842)
        p.insert_text((50, 100), "5 Optimization with Adaptive Density", fontsize=12)
        p.insert_text((50, 116), "Control of 3D Gaussians", fontsize=12)
        p.insert_text((50, 150), TEXT, fontsize=10)
        p.insert_text((50, 200), "6 Experiments", fontsize=12)
        p.insert_text((50, 220), "6.1 Setup", fontsize=11)
        p.insert_text((50, 250), TEXT, fontsize=10)
        p.insert_text((50, 300), "A.1. Pre-training", fontsize=11)
        p.insert_text((50, 330), TEXT, fontsize=10)
        self.data = doc.tobytes()
        doc.close()

    def test_lines_of_one_title_box_are_one_heading(self):
        boxes = [title(85, 120), title(188, 204), title(209, 224), title(289, 304)]
        sentences = _layout(self.data, 1, {1: boxes})
        self.assertEqual(
            _headings(sentences),
            [
                "5 Optimization with Adaptive Density Control of 3D Gaussians",
                "6 Experiments",  # a section and its first subsection: a box each
                "6.1 Setup",
                "A.1. Pre-training",  # not cut after "A.1."
            ],
        )
        self.assertEqual([s["text"] for s in sentences].count(TEXT), 3)


class AppendixCoverTests(unittest.TestCase):
    def setUp(self):
        doc = pymupdf.open()
        p = doc.new_page(width=595, height=842)
        p.insert_text((150, 80), "Graph Structure of Neural Networks", fontsize=14)
        p.insert_text((150, 110), "Jiaxuan You 1 Jure Leskovec 1", fontsize=10)
        p.insert_text((50, 150), "Abstract", fontsize=12)
        p.insert_text((50, 170), TEXT, fontsize=10)
        p = doc.new_page(width=595, height=842)
        p.insert_text((50, 100), TEXT, fontsize=10)
        p = doc.new_page(width=595, height=842)  # the appendix cover
        p.insert_text((200, 80), "Appendix for", fontsize=14)
        p.insert_text((150, 98), '"Graph Structure of Neural Networks"', fontsize=14)
        p.insert_text((150, 130), "Jiaxuan You 1 Jure Leskovec 1", fontsize=10)
        p.insert_text((50, 170), "1. Details for Generating Graphs", fontsize=12)
        p.insert_text(
            (50, 190), "Here we give details on how Jure Leskovec", fontsize=10
        )
        p.insert_text((50, 202), "and Jiaxuan You generate the graphs.", fontsize=10)
        self.data = doc.tobytes()
        doc.close()
        self.cover = {2: [title(65, 103), title(120, 134), title(158, 174)]}

    def test_the_repeated_author_line_is_dropped(self):
        sentences = _layout(self.data, 2, self.cover)
        self.assertEqual(
            _headings(sentences),
            [
                'Appendix for "Graph Structure of Neural Networks"',
                "1. Details for Generating Graphs",
            ],
        )
        text = " ".join(s["text"] for s in sentences)
        self.assertNotIn("Jiaxuan You 1", text)
        # a sentence that names the authors is not a copy of the author line
        self.assertIn("how Jure Leskovec and Jiaxuan You generate the graphs.", text)

    def test_page_zero_still_drops_its_front_matter_by_position(self):
        text = " ".join(s["text"] for s in _layout(self.data, 0, {}))
        self.assertNotIn("Graph Structure", text)
        self.assertNotIn("Jiaxuan", text)
        self.assertIn(TEXT, text)

    def test_front_matter_is_the_lines_above_the_abstract(self):
        doc = pymupdf.open(stream=self.data, filetype="pdf")
        self.assertEqual(
            pdf_utils._front_matter(doc[0]),
            {"graphstructureofneuralnetworks", "jiaxuanyoujureleskovec"},
        )
        doc.close()

    def test_a_covers_figure_labels_are_no_front_matter(self):
        # a cover with no Abstract: its teaser figure's label names the method, and so does
        # a later section heading, which stays
        doc = pymupdf.open()
        p = doc.new_page(width=595, height=842)
        p.insert_text((150, 80), "Toy Models are Policies", fontsize=14)
        p.insert_text((150, 110), "Ann Lee  Bo Li", fontsize=10)
        p.insert_text((250, 400), "ToyPolicy", fontsize=6)
        p = doc.new_page(width=595, height=842)
        p.insert_text((50, 80), "Abstract", fontsize=12)
        p.insert_text((50, 100), TEXT, fontsize=10)
        p = doc.new_page(width=595, height=842)
        p.insert_text((50, 100), "3 ToyPolicy", fontsize=12)
        p.insert_text((50, 120), TEXT, fontsize=10)
        data = doc.tobytes()
        doc.close()
        sentences = _layout(data, 2, {2: [title(88, 104)]})
        self.assertEqual(_headings(sentences), ["3 ToyPolicy"])


def _words(*lines, size: float = 10.0) -> list[dict]:
    """Words for `_front_cut`: (y, text) lines of a page, each in a PDF block of its own unless
    given as (y, text, block); words 6pt apart from x=50."""
    out = []
    for n, (y, text, *block) in enumerate(lines):
        for i, t in enumerate(text.split()):
            out.append(
                {
                    "t": t,
                    "x0": 50 + 40 * i,
                    "x1": 84 + 40 * i,
                    "y0": y,
                    "y1": y + 10,
                    "line": (block[0] if block else n, n),
                    "size": size,
                }
            )
    return out


ABSTRACT = (
    "we study how a model learns from data and show that it works well",
    "on every task we try and that it needs much less data than before",
)


class FirstPageTests(unittest.TestCase):
    def test_the_abstract_heading_is_a_word_that_opens_its_line(self):
        # a paper with no Abstract heading: "abstracting" in its introduction is not one
        prose = _words((300, "early work focused on abstracting the world"))
        self.assertNotEqual(pdf_utils._front_cut(prose, 800), 300)
        self.assertEqual(
            pdf_utils._front_cut(_words((250, "Abstract—We study")), 800), 250
        )
        self.assertEqual(pdf_utils._front_cut(_words((250, "ABSTRACT")), 800), 250)
        # small or spaced capitals come in pieces
        self.assertEqual(pdf_utils._front_cut(_words((250, "A BSTRACT")), 800), 250)
        self.assertEqual(
            pdf_utils._front_cut(_words((250, "A B S T R A C T")), 800), 250
        )
        self.assertNotEqual(
            pdf_utils._front_cut(_words((250, "A Better Model")), 800), 250
        )

    def test_without_a_heading_the_front_matter_ends_where_running_text_starts(self):
        # a long author list runs below the 22% that used to be the cut
        page = _words(
            (60, "Toy Models are Policies"),
            (120, "Ann Lee  Bo Li  Cy Park  Di Wu  Ed Kim"),
            (180, "Fay Ng  Gus Ho  Hal Ito  Ivy Ma  Jo Yu"),
            (200, "Example Lab, Example City, Country"),
            (230, ABSTRACT[0]),
            (244, ABSTRACT[1]),
        )
        self.assertEqual(pdf_utils._front_cut(page, 800), 230)
        # one line of running text is not enough (a short note under the authors)
        self.assertEqual(
            pdf_utils._front_cut(page[: -len(ABSTRACT[1].split())], 800), 800
        )

    def test_a_capitalized_first_line_goes_with_its_paragraph(self):
        page = _words(
            (120, "Ann Lee  Bo Li", 0),
            (
                216,
                "The Simple Modular Framework for Safe Robot Operations",
                1,
            ),
            (230, ABSTRACT[0], 1),
            (244, ABSTRACT[1], 1),
        )
        self.assertEqual(pdf_utils._front_cut(page, 800), 216)

    def test_a_page_without_running_text_is_a_cover(self):
        # title, authors and a teaser figure; the abstract is on the next page
        page = _words((60, "Toy Models are Policies"), (120, "Ann Lee  Bo Li"))
        self.assertEqual(pdf_utils._front_cut(page, 800), 800)

    def test_text_rows_join_pieces_of_a_line_but_not_two_columns(self):
        # an old PDF gives every word a line of its own; two columns stay apart
        pieces = [
            {"t": t, "x0": x, "x1": x + 30, "y0": 100, "y1": 110, "line": (0, i)}
            for i, (t, x) in enumerate([("Dep", 50), ("artment", 82), ("of", 114)])
        ]
        right = {"t": "Results", "x0": 320, "x1": 360, "y0": 100, "y1": 110}
        lines = {w["line"]: [w] for w in pieces} | {(1, 0): [right | {"line": (1, 0)}]}
        rows = pdf_utils._text_rows(lines)
        self.assertEqual(
            [[w["t"] for w in r["words"]] for r in rows],
            [["Dep", "artment", "of"], ["Results"]],
        )

    def test_a_cover_page_keeps_only_its_captions(self):
        doc = pymupdf.open()
        p = doc.new_page(width=595, height=842)
        p.insert_text((60, 80), "Toy Models are Policies", fontsize=16)
        for i, y in enumerate((120, 135, 150, 165, 180, 195, 210, 225)):
            p.insert_text((60, y), f"Ann Lee{i}  Bo Li{i}  Cy Park{i}", fontsize=9)
        p.insert_text((60, 240), "Example Lab  † Project Leads", fontsize=9)
        p.insert_text(
            (60, 650), "Figure 1: Overview. We predict video and action.", fontsize=9
        )
        p.insert_text(
            (60, 790), "© 2026 Example Corp. All rights reserved.", fontsize=8
        )
        data = doc.tobytes()
        doc.close()
        regions = [
            {"role": "caption", "x0": 55, "y0": 640, "x1": 550, "y1": 655},
            {"role": "furniture", "x0": 55, "y0": 780, "x1": 400, "y1": 795},
        ]
        text = " ".join(s["text"] for s in _layout(data, 0, {0: regions}))
        self.assertIn("We predict video and action.", text)
        for gone in ("Ann Lee", "Cy Park7", "Project Leads", "All rights reserved"):
            self.assertNotIn(gone, text)

    def test_a_notice_and_the_papers_own_citation_are_front_matter(self):
        doc = pymupdf.open()
        p = doc.new_page(width=595, height=842)
        p.insert_text((150, 80), "A Model for Learning from Data", fontsize=14)
        p.insert_text((50, 150), "Abstract", fontsize=12)
        p.insert_text((50, 170), TEXT, fontsize=10)
        p.insert_text(
            (50, 190), "We call it A Model for Learning from Data in 2025.", fontsize=10
        )
        p.insert_text((50, 300), "ACM Reference Format:", fontsize=10)
        p.insert_text(
            (50, 315),
            "Ann Lee and Bo Li. 2025. A Model for Learning from Data. In Proceedings",
            fontsize=8,
        )
        p.insert_text(
            (50, 326), "of the ACM Conference. ACM, New York, NY, USA.", fontsize=8
        )
        p.insert_text((50, 760), "1 We call the controller a policy.", fontsize=8)
        p.insert_text((50, 790), "This work is licensed under a Creative", fontsize=8)
        p.insert_text((50, 800), "Commons Attribution 4.0 License.", fontsize=8)
        p.insert_text((50, 810), "KDD ’25, Toronto, Canada © 2025", fontsize=8)
        data = doc.tobytes()
        doc.close()
        regions = [
            {"role": "title", "x0": 45, "y0": 290, "x1": 300, "y1": 303},
            {"role": "furniture", "x0": 45, "y0": 750, "x1": 400, "y1": 765},
            {"role": "furniture", "x0": 45, "y0": 780, "x1": 400, "y1": 815},
        ]
        sentences = _layout(data, 0, {0: regions})
        text = " ".join(s["text"] for s in sentences)
        self.assertIn(TEXT, text)
        # an abstract that names the paper is no citation of it
        self.assertIn("We call it A Model for Learning from Data in 2025.", text)
        self.assertIn("We call the controller a policy.", text)
        for gone in ("ACM Reference Format", "Ann Lee", "New York", "Creative", "KDD"):
            self.assertNotIn(gone, text)

    def test_a_contact_block_typed_as_text_is_front_matter(self):
        doc = pymupdf.open()
        p = doc.new_page(width=595, height=842)
        p.insert_text((150, 80), "A Model for Learning from Data", fontsize=14)
        p.insert_text((50, 150), "Abstract", fontsize=12)
        p.insert_text((50, 170), TEXT, fontsize=10)
        p.insert_text(
            (50, 400),
            "Authors' Contact Information: Ann Lee, ann@example.com, Example University,",
            fontsize=8,
        )
        p.insert_text(
            (50, 410),
            "Example City, Country; Bo Li, bo@example.com, Example Lab.",
            fontsize=8,
        )
        p.insert_text(
            (50, 500),
            "Write to data@example.com to get the full data set we use here.",
            fontsize=10,
        )
        data = doc.tobytes()
        doc.close()
        text = " ".join(s["text"] for s in _layout(data, 0, {}))
        self.assertIn(TEXT, text)
        self.assertNotIn("Example University", text)
        self.assertNotIn("bo@example.com", text)
        # running text that gives an address is read
        self.assertIn("to get the full data set we use here.", text)

    def test_a_caption_above_the_abstract_is_kept(self):
        # SAM: a teaser figure and its caption sit above the Abstract
        doc = pymupdf.open()
        p = doc.new_page(width=595, height=842)
        p.insert_text((150, 80), "Segment Anything", fontsize=14)
        p.insert_text(
            (50, 300), "Figure 1: We build a model for segmentation.", fontsize=9
        )
        p.insert_text((50, 400), "Abstract", fontsize=12)
        p.insert_text((50, 420), TEXT, fontsize=10)
        data = doc.tobytes()
        doc.close()
        cap = {"role": "caption", "x0": 45, "y0": 290, "x1": 550, "y1": 305}
        text = " ".join(s["text"] for s in _layout(data, 0, {0: [cap]}))
        self.assertIn("We build a model for segmentation.", text)
        self.assertNotIn("Segment Anything", text)
        self.assertIn(TEXT, text)

    def test_a_footnote_with_an_e_mail_address_is_front_matter(self):
        # the authors' affiliation and contact address sit at the foot of page 0; a content
        # footnote beside them is still read
        doc = pymupdf.open()
        p = doc.new_page(width=595, height=842)
        p.insert_text((150, 80), "A Model for Learning from Data", fontsize=14)
        p.insert_text((50, 150), "Abstract", fontsize=12)
        p.insert_text((50, 170), TEXT, fontsize=10)
        p.insert_text((50, 760), "1 We call the controller a policy.", fontsize=8)
        p.insert_text((50, 790), "Example Lab, Example City, Country.", fontsize=8)
        p.insert_text((50, 800), "Correspondence to: research@example.com", fontsize=8)
        data = doc.tobytes()
        doc.close()
        foot = [
            {"role": "furniture", "x0": 45, "y0": 750, "x1": 400, "y1": 765},
            {"role": "furniture", "x0": 45, "y0": 780, "x1": 400, "y1": 805},
        ]
        sentences = _layout(data, 0, {0: foot})
        text = " ".join(s["text"] for s in sentences)
        self.assertIn(TEXT, text)
        self.assertIn("We call the controller a policy.", text)
        self.assertNotIn("Example Lab", text)
        self.assertNotIn("research@example.com", text)
        # an address is an e-mail domain, not a metric at a cutoff
        self.assertEqual(
            pdf_utils._EMAIL.findall("mAP@0.5 and Recall@1, {a, b} @mit.edu"),
            ["@mit.edu"],
        )

    def _two_pages(self, first: str, second: list[tuple[float, str]]) -> bytes:
        doc = pymupdf.open()
        doc.new_page(width=595, height=842).insert_text((50, 60), first, fontsize=9)
        p = doc.new_page(width=595, height=842)
        for y, text in second:
            p.insert_text((50, y), text, fontsize=10)
        data = doc.tobytes()
        doc.close()
        return data

    def test_a_paper_after_a_notice_page_starts_on_the_next_page(self):
        # page 0 holds a publisher's notice; the title, authors and Abstract are on page 1
        data = self._two_pages(
            "This work has been submitted for possible publication.",
            [
                (80, "A Model for Learning from Data"),
                (110, "Ann Lee, Bo Li, and Cy Park, Member, IEEE"),
                (150, "Abstract. We study how a model learns from data."),
                (170, TEXT),
            ],
        )
        self.assertEqual(pdf_utils._first_page(data), 1)
        text = " ".join(s["text"] for s in _layout(data, 1, {}))
        self.assertIn(TEXT, text)
        self.assertNotIn("Ann Lee", text)
        # a sentence that opens with the word is no Abstract heading
        data = self._two_pages(
            "This work has been submitted for possible publication.",
            [(80, "Abstract syntax trees are what the parser builds from code.")],
        )
        self.assertEqual(pdf_utils._first_page(data), 0)
        # nor is a contents entry
        data = self._two_pages(
            "Final Project Report",
            [(80, "Abstract . . . . . . . . 1"), (95, "1 Introduction . . . . . . 2")],
        )
        self.assertEqual(pdf_utils._first_page(data), 0)

    def test_a_footnote_on_the_authors_is_front_matter(self):
        # an IEEE-style footnote with no address: who is with which department, and who
        # corresponds, go; the funding note beside them and a content footnote are read
        doc = pymupdf.open()
        p = doc.new_page(width=595, height=842)
        p.insert_text((150, 80), "A Model for Learning from Data", fontsize=14)
        p.insert_text((50, 150), "Abstract", fontsize=12)
        p.insert_text((50, 170), TEXT, fontsize=10)
        p.insert_text((50, 750), "1 We call the controller a policy.", fontsize=8)
        p.insert_text(
            (50, 780), "This work was supported by the Example Foundation.", fontsize=8
        )
        p.insert_text(
            (50, 790),
            "(Corresponding author: Ann Lee.) Ann Lee and Bo Li are",
            fontsize=8,
        )
        p.insert_text(
            (50, 800), "with the Department of Physics, Example University.", fontsize=8
        )
        data = doc.tobytes()
        doc.close()
        foot = [{"role": "furniture", "x0": 45, "y0": 740, "x1": 400, "y1": 805}]
        text = " ".join(s["text"] for s in _layout(data, 0, {0: foot}))
        self.assertIn(TEXT, text)
        self.assertIn("We call the controller a policy.", text)
        self.assertIn("supported by the Example Foundation.", text)
        self.assertNotIn("Corresponding author", text)
        self.assertNotIn("Department of Physics", text)

    def test_a_reports_list_of_authors_is_not_translated(self):
        doc = pymupdf.open()
        doc.new_page(width=595, height=842)
        p = doc.new_page(width=595, height=842)
        p.insert_text((50, 80), "Authors", fontsize=12)
        p.insert_text(
            (50, 100), "Ann Lee, Example University; Bo Li, Example Lab;", fontsize=10
        )
        p.insert_text(
            (50, 112), "Cy Park, Example Institute; Di Wu, Example Corp.", fontsize=10
        )
        p.insert_text(
            (50, 130),
            "All of the authors took part in the study we report here.",
            fontsize=10,
        )
        p.insert_text((50, 170), "1 Introduction", fontsize=12)
        p.insert_text((50, 190), TEXT, fontsize=10)
        data = doc.tobytes()
        doc.close()
        heads = {1: [title(70, 84), title(160, 174)]}
        sentences = _layout(data, 1, heads)
        text = " ".join(s["text"] for s in sentences)
        self.assertEqual(_headings(sentences), ["1 Introduction"])
        self.assertNotIn("Ann Lee", text)
        self.assertIn("took part in the study we report here.", text)
        self.assertIn(TEXT, text)

    def test_notices(self):
        notice = pdf_utils._NOTICE.search
        for t in (
            "© 2026 Example Corp. All rights reserved.",
            "©2019 IEEE",
            "c ⃝ Copyright owned by the author(s) under the terms of the licence.",
            "Copyright may be transferred without notice.",
            "Copyright 2022 by the author(s).",
            "This work is licensed under a Creative Commons Attribution 4.0 License.",
            "Permission to make digital or hard copies of all or part of this work ...",
            "Personal use of this material is permitted.",
        ):
            self.assertTrue(notice(t), t)
        for t in (
            "It runs in MATLAB (developed by the MathWorks ©) or Octave.",
            "Such data is scarce due to copyright restrictions.",
        ):
            self.assertFalse(notice(t), t)
        note = pdf_utils._AUTHOR_NOTE.search
        for t in (
            "Authors' Contact Information: Ann Lee, Example University.",
            "Ann Lee is a PhD student at Example University.",
            "This report was written by Ann Lee and Bo Li with equal contributions.",
        ):
            self.assertTrue(note(t), t)
        # a data statement is no note on the authors
        self.assertFalse(note("The data are available from the corresponding author."))

    def test_more_notices_and_contacts(self):
        # a notice broken at a line's end ("Copy-" + "right"), a short request to be
        # contacted that reads as text, and an author note in a footnote on page 1
        doc = pymupdf.open()
        p = doc.new_page(width=595, height=842)
        p.insert_text((150, 80), "A Model for Learning from Data", fontsize=14)
        p.insert_text((50, 150), "Abstract", fontsize=12)
        p.insert_text((50, 170), TEXT, fontsize=10)
        p.insert_text(
            (50, 400),
            "Corresponding authors can be contacted at team@example.org",
            fontsize=8,
        )
        p.insert_text((50, 750), "1 We call the controller a policy.", fontsize=8)
        p.insert_text(
            (50, 790), "Proceedings of the Example Conference, 2022. Copy-", fontsize=8
        )
        p.insert_text((50, 800), "right 2022 by the author(s).", fontsize=8)
        p = doc.new_page(width=595, height=842)
        p.insert_text((50, 100), TEXT, fontsize=10)
        p.insert_text(
            (50, 790),
            "*This report was written by Ann Lee and Bo Li with equal",
            fontsize=8,
        )
        p.insert_text(
            (50, 800), "contributions. We thank Example Lab for its help.", fontsize=8
        )
        data = doc.tobytes()
        doc.close()
        foot = {
            0: [
                {"role": "furniture", "x0": 45, "y0": 740, "x1": 400, "y1": 755},
                {"role": "furniture", "x0": 45, "y0": 780, "x1": 400, "y1": 805},
            ],
            1: [{"role": "furniture", "x0": 45, "y0": 780, "x1": 400, "y1": 805}],
        }
        text = " ".join(s["text"] for s in _layout(data, 0, foot))
        self.assertIn(TEXT, text)
        self.assertIn("We call the controller a policy.", text)
        self.assertNotIn("team@example.org", text)
        self.assertNotIn("by the author(s)", text)
        text = " ".join(s["text"] for s in _layout(data, 1, foot))
        self.assertIn(TEXT, text)
        self.assertNotIn("equal contributions", text)
        self.assertIn("We thank Example Lab for its help.", text)

    def _notes_page(self, notes: str, below: str = "") -> str:
        """Page 0's text with an author line marked "*" and "†", and `notes` (one PDF block,
        lines split by newlines) and `below` (a block of its own) in the footnote area."""
        doc = pymupdf.open()
        p = doc.new_page(width=595, height=842)
        p.insert_text((150, 80), "A Model for Learning from Data", fontsize=14)
        p.insert_text((150, 110), "Ann Lee*  Bo Li†", fontsize=10, fontname="japan")
        p.insert_text((50, 150), "Abstract", fontsize=12)
        p.insert_text((50, 170), TEXT, fontsize=10)
        p.insert_text((50, 740), notes, fontsize=8, fontname="japan")
        if below:
            p.insert_text((50, 800), below, fontsize=8)
        data = doc.tobytes()
        doc.close()
        foot = [{"role": "furniture", "x0": 45, "y0": 730, "x1": 400, "y1": 805}]
        return " ".join(s["text"] for s in _layout(data, 0, {0: foot}))

    def test_a_footnote_whose_mark_an_author_carries_is_front_matter(self):
        # an author note carries no address: its mark ties it to the author line. It runs to
        # the next mark ("is random." goes with it). A mark no author carries, or a numbered
        # footnote, belongs to the text and is still read
        text = self._notes_page(
            "*Equal contribution. Listing order\nis random.\n"
            "†Work done at Example Lab.\n‡We report the mean of three runs.",
            below="1 The code is available online.",
        )
        self.assertIn(TEXT, text)
        for note in ("Equal contribution", "is random", "Example Lab"):
            self.assertNotIn(note, text)
        self.assertIn("We report the mean of three runs.", text)
        self.assertIn("The code is available online.", text)

    def test_a_mark_in_a_caption_above_the_abstract_marks_no_author(self):
        # a teaser caption above the Abstract is kept, and its "*" is no author's: a footnote
        # with that mark belongs to the text
        doc = pymupdf.open()
        p = doc.new_page(width=595, height=842)
        p.insert_text((150, 80), "A Model for Learning from Data", fontsize=14)
        p.insert_text((150, 110), "Ann Lee  Bo Li", fontsize=10)
        p.insert_text(
            (50, 140), "Figure 1: The results; * marks the best run.", fontsize=9
        )
        p.insert_text((50, 170), "Abstract", fontsize=12)
        p.insert_text((50, 190), TEXT, fontsize=10)
        p.insert_text((50, 760), "*We report the mean of three runs.", fontsize=8)
        data = doc.tobytes()
        doc.close()
        regions = [
            {"role": "caption", "x0": 45, "y0": 130, "x1": 550, "y1": 145},
            {"role": "furniture", "x0": 45, "y0": 750, "x1": 400, "y1": 770},
        ]
        text = " ".join(s["text"] for s in _layout(data, 0, {0: regions}))
        self.assertIn("We report the mean of three runs.", text)

    def test_an_author_note_block_with_an_address_goes_whole(self):
        # the e-mail rule judges the whole block before the marked notes are taken out of it
        text = self._notes_page(
            "*Equal contribution. Correspondence to: ann@example.com\n"
            "Author contributions are listed in the appendix."
        )
        self.assertNotIn("Author contributions", text)
        self.assertIn(TEXT, text)

    def test_note_marks(self):
        # an author line's "∗" marks a "*" note
        self.assertEqual(pdf_utils._mark("∗"), pdf_utils._mark("*"))
        # a footnote number set smaller than its line opens a new footnote
        small = [{"t": "1", "size": 5.0}, {"t": "Code:", "size": 8.0}]
        self.assertTrue(pdf_utils._numbered_note(small))
        same = [{"t": "1", "size": 8.0}, {"t": "Code:", "size": 8.0}]
        self.assertFalse(pdf_utils._numbered_note(same))
        # a word at the line's size is no mark, though a larger symbol is beside it
        sizes = [("a", 8.0), ("Σ", 12.0), ("set", 8.0), ("of", 8.0), ("points", 8.0)]
        self.assertFalse(
            pdf_utils._numbered_note([{"t": t, "size": z} for t, z in sizes])
        )
        self.assertTrue(pdf_utils._numbered_note([{"t": "a", "size": 5.0}, small[1]]))
        # a sign of the text is no mark
        self.assertTrue(pdf_utils._marked_note("†Work"))
        for t in ("§4.2", "#tokens", "‖x‖"):
            self.assertFalse(pdf_utils._marked_note(t), t)


def _contents_page(p, y: float, entries, title_x: float = 80) -> float:
    """Write contents entries (number, title, page) from `y`: a dot leader up to the page number
    at the right edge. A title with a newline wraps onto a second line. Returns the next y."""
    for num, title, page in entries:
        p.insert_text((50, y), num, fontsize=10)
        *first, last = title.split("\n")
        for line in first:
            p.insert_text((title_x, y), line, fontsize=10)
            y += 12
        p.insert_text((title_x, y), last + " " + ". " * 20, fontsize=10)
        p.insert_text((530, y), str(page), fontsize=10)
        y += 18
    return y


class ContentsTests(unittest.TestCase):
    """A table of contents is not translated: its entries and its heading go, and the text
    below it, or text that only ends in numbers, stays."""

    def setUp(self):
        doc = pymupdf.open()
        doc.new_page(width=595, height=842)
        p = doc.new_page(width=595, height=842)
        p.insert_text((50, 80), "Contents", fontsize=12)
        entries = [
            ("1", "Introduction", 3),
            ("2", "Method", 4),
            ("2.1", "Model", 4),
            ("2.2", "Training", 5),
            ("3", "Experiments", 6),
            ("3.1", "Results on the benchmark tasks and a long title\nthat wraps", 7),
            ("4", "Conclusion", 8),
        ]
        y = _contents_page(p, 110, entries)
        p.insert_text((50, y + 30), TEXT, fontsize=10)
        p = doc.new_page(width=595, height=842)  # the contents go on, with no heading
        entries = [
            ("A", "Proofs", 9),
            ("B", "More results", 10),
            ("B.1", "Ablations", 10),
            ("B.2", "Runtime", 11),
            ("C", "Hyperparameters", 12),
        ]
        y = _contents_page(p, 80, entries)
        p.insert_text((50, y + 30), TEXT, fontsize=10)
        # numbers at the right edge, not going up
        p = doc.new_page(width=595, height=842)
        settings = [
            ("The number of layers in the encoder", 12),
            ("The number of heads in each layer", 8),
            ("The number of training epochs we use", 3),
            ("The number of warmup epochs we use", 2),
            ("The number of random seeds per run", 5),
        ]
        for k, (label, n) in enumerate(settings):
            p.insert_text((50, 80 + 18 * k), label, fontsize=10)
            p.insert_text((530, 80 + 18 * k), str(n), fontsize=10)
        self.data = doc.tobytes()
        doc.close()

    def _text(self, page: int) -> str:
        regions = {1: [title(68, 84)]}  # the "Contents" heading
        return " ".join(s["text"] for s in _layout(self.data, page, regions))

    def test_contents_and_their_heading_are_dropped(self):
        self.assertEqual(self._text(1), TEXT)

    def test_a_contents_page_without_a_heading_is_dropped(self):
        self.assertEqual(self._text(2), TEXT)

    def test_text_beside_or_above_contents_stays(self):
        # prose in the other column, at the same heights as the entries, and a running head
        # that ends in a page number above the text: neither belongs to the contents
        doc = pymupdf.open()
        doc.new_page(width=595, height=842)
        p = doc.new_page(width=595, height=842)
        for k in range(8):
            p.insert_text(
                (50, 100 + 18 * k), f"Left {k} keeps working well.", fontsize=10
            )
            p.insert_text((320, 100 + 18 * k), f"{k + 1} Section {k}", fontsize=10)
            p.insert_text((540, 100 + 18 * k), str(k + 2), fontsize=10)
        p = doc.new_page(width=595, height=842)
        p.insert_text((50, 60), "A Model for Learning from Data", fontsize=9)
        p.insert_text((530, 60), "3", fontsize=9)
        p.insert_text((50, 100), TEXT, fontsize=10)
        _contents_page(p, 400, [(f"A.{k + 1}", f"Part {k}", k + 3) for k in range(5)])
        data = doc.tobytes()
        doc.close()
        with patch.object(pdf_utils.layout_model, "detect_page", return_value=[]):
            left = [s["text"] for s in pdf_utils._page_layout(data, 1)["sentences"]]
            heads = {"amodelforlearningfromdata"}
            below = pdf_utils._page_layout(data, 2, headers=heads)["sentences"]
        self.assertEqual(left, [f"Left {k} keeps working well." for k in range(8)])
        self.assertEqual([s["text"] for s in below], [TEXT])

    def test_contents_that_run_on_in_the_next_column_take_only_their_own_lines(self):
        # the contents fill the left column and end in the right one, below a figure caption
        # and above the start of the text: those stay
        doc = pymupdf.open()
        doc.new_page(width=595, height=842)
        p = doc.new_page(width=595, height=842)
        caption = "Figure 1: The model and its training."
        text = "We study how models learn."
        for k in range(15):
            x, y = (50, 100 + 18 * k) if k < 10 else (320, 160 + 18 * (k - 10))
            p.insert_text((x, y), f"{k + 1} Part {k} " + ". " * 10, fontsize=10)
            p.insert_text((x + 220, y), str(k + 2), fontsize=10)
        p.insert_text((320, 100), caption, fontsize=10)
        p.insert_text((320, 280), text, fontsize=10)
        for _ in range(20):  # the pages the entries point to
            doc.new_page(width=595, height=842)
        data = doc.tobytes()
        doc.close()
        with patch.object(pdf_utils.layout_model, "detect_page", return_value=[]):
            texts = [s["text"] for s in pdf_utils._page_layout(data, 1)["sentences"]]
        self.assertEqual(texts, [caption, text])

    def test_contents_that_start_at_a_page_foot_go_with_their_heading(self):
        # two rows are enough right below a "Contents" heading; without it, so few rows are
        # no contents
        def texts(heading: bool) -> list[str]:
            doc = pymupdf.open()
            doc.new_page(width=595, height=842)
            p = doc.new_page(width=595, height=842)
            p.insert_text((50, 100), TEXT, fontsize=10)
            if heading:
                p.insert_text((50, 700), "Contents", fontsize=12)
            entries = [("1", "Introduction", 3), ("1.1", "Background", 4)]
            _contents_page(p, 730, entries)
            for _ in range(10):  # the pages the entries point to
                doc.new_page(width=595, height=842)
            data = doc.tobytes()
            doc.close()
            regions = {1: [title(688, 704)]} if heading else {}
            return [s["text"] for s in _layout(data, 1, regions)]

        self.assertEqual(texts(True), [TEXT])
        self.assertIn("Background", " ".join(texts(False)))

    def test_an_entry_named_like_a_running_head_is_an_entry(self):
        # a monograph's running heads repeat its chapter titles ("INTRODUCTION"): a running
        # head is one by where it stands, at the top or the foot of the page
        regions = {1: [title(68, 84)]}
        with patch.object(
            pdf_utils.layout_model,
            "detect_page",
            side_effect=lambda p: regions.get(p.number, []),
        ):
            layout = pdf_utils._page_layout(self.data, 1, headers={"introduction"})
        self.assertEqual(" ".join(s["text"] for s in layout["sentences"]), TEXT)

    def test_a_first_entry_that_wraps_goes_with_the_list(self):
        # the first title wraps above its number's row; it and the heading above it go too,
        # also when its number is a line of its own, set far from the title
        for title_x in (80, 84):
            doc = pymupdf.open()
            doc.new_page(width=595, height=842)
            p = doc.new_page(width=595, height=842)
            p.insert_text((50, 80), "List of Figures", fontsize=12)
            entries = [("2.1", "Two simple graphs with their inputs and\noutputs", 3)]
            entries += [(f"2.{k}", f"A larger graph {k}", k + 2) for k in range(2, 7)]
            y = _contents_page(p, 110, entries, title_x)
            p.insert_text((50, y + 30), TEXT, fontsize=10)
            data = doc.tobytes()
            doc.close()
            texts = [s["text"] for s in _layout(data, 1, {1: [title(68, 84)]})]
            self.assertEqual(texts, [TEXT], title_x)

    def test_a_last_title_that_runs_up_to_its_number_goes_too(self):
        doc = pymupdf.open()
        doc.new_page(width=595, height=842)
        p = doc.new_page(width=595, height=842)
        y = _contents_page(p, 100, [(f"{k}", f"Part {k}", k + 2) for k in range(1, 6)])
        last = "6 A last part whose long title runs on up to its page 9"
        p.insert_text(
            (536 - pymupdf.get_text_length(last, fontsize=10), y), last, fontsize=10
        )
        p.insert_text((50, y + 40), TEXT, fontsize=10)
        data = doc.tobytes()
        doc.close()
        self.assertEqual([s["text"] for s in _layout(data, 1, {})], [TEXT])

    def test_numbers_beside_the_other_columns_prose_are_not_contents(self):
        # a two-column page: small numbers on lines of their own in the right column (a
        # plot's ticks, a rank) beside the left column's prose
        doc = pymupdf.open()
        doc.new_page(width=595, height=842)
        p = doc.new_page(width=595, height=842)
        left = [f"Line {k} of the left column keeps going on" for k in range(12)]
        for k, text in enumerate(left):
            p.insert_text((50, 100 + 12 * k), text, fontsize=10)
        for k in range(6):
            p.insert_text((330, 100 + 24 * k), str(k + 1), fontsize=8)
        for _ in range(10):
            doc.new_page(width=595, height=842)
        data = doc.tobytes()
        doc.close()
        text = " ".join(s["text"] for s in _layout(data, 1, {}))
        for line in left:
            self.assertIn(line, text)

    def test_a_chapter_title_over_its_short_contents_stays(self):
        # a thesis chapter may open with the list of its sections: the band does not grow
        # past a heading, and only a list's own heading ("Contents") goes with it
        entries = [(f"1.{k}", f"Part {k}", k + 2) for k in range(1, 6)]
        for contents in (True, False):
            doc = pymupdf.open()
            doc.new_page(width=595, height=842)
            p = doc.new_page(width=595, height=842)
            p.insert_text((50, 100), "1 Introduction", fontsize=12)
            regions = [title(89, 103)]
            if contents:
                p.insert_text((50, 114), "Contents", fontsize=11)
                regions.append(title(104, 117))
            first = [("1.0", "A long first title that runs on\nto a second line", 3)]
            _contents_page(p, 128 if contents else 114, first + entries)
            p.insert_text((50, 400), TEXT, fontsize=10)
            data = doc.tobytes()
            doc.close()
            texts = [s["text"] for s in _layout(data, 1, {1: regions})]
            self.assertEqual(texts, ["1 Introduction", TEXT])

    def test_a_section_named_contents_over_two_rows_is_not_contents(self):
        # two rows are enough under a "Contents" heading only when one has a dot leader
        doc = pymupdf.open()
        doc.new_page(width=595, height=842)
        p = doc.new_page(width=595, height=842)
        p.insert_text((50, 100), TEXT, fontsize=10)
        p.insert_text((50, 130), "Contents", fontsize=12)
        for k, (label, n) in enumerate([("Images in the set", 3), ("Captions", 4)]):
            p.insert_text((50, 160 + 18 * k), label, fontsize=10)
            p.insert_text((400, 160 + 18 * k), str(n), fontsize=10)
        data = doc.tobytes()
        doc.close()
        regions = {1: [title(118, 134)]}
        texts = [s["text"] for s in _layout(data, 1, regions)]
        with patch.object(pdf_utils, "_toc_lines", return_value=set()):
            self.assertEqual(texts, [s["text"] for s in _layout(data, 1, regions)])
        self.assertIn("Contents", texts)

    def test_a_list_of_symbols_with_pages_is_not_contents(self):
        # its rows open with the symbol, where a contents entry has a title or a number
        doc = pymupdf.open()
        doc.new_page(width=595, height=842)
        p = doc.new_page(width=595, height=842)
        rows = [("x", "an input vector"), ("y", "its label"), ("θ", "the weights")]
        rows += [("η", "the learning rate"), ("L", "the loss")]
        for k, (sym, meaning) in enumerate(rows):
            y = 100 + 18 * k
            p.insert_text((50, y), sym, fontsize=10, fontname="japan")
            p.insert_text((80, y), meaning + " " + ". " * 20, fontsize=10)
            p.insert_text((530, y), str(k + 3), fontsize=10)
        for _ in range(10):  # the pages the rows point to
            doc.new_page(width=595, height=842)
        data = doc.tobytes()
        doc.close()
        text = " ".join(s["text"] for s in _layout(data, 1, {}))
        for _, meaning in rows:
            self.assertIn(meaning, text)

    def test_numbers_that_do_not_go_up_are_not_contents(self):
        text = self._text(3)
        self.assertIn("The number of layers in the encoder 12", text)
        with patch.object(pdf_utils, "_toc_lines", return_value=set()):
            self.assertEqual(text, self._text(3))


class PdfTitleTests(unittest.TestCase):
    """The library title of an unopened PDF: the largest lines at the top of page 0."""

    def _title(self, place) -> str:
        doc = pymupdf.open()
        p = doc.new_page(width=612, height=792)
        tw = pymupdf.TextWriter(p.rect)
        place(tw)
        tw.write_text(p)
        p.insert_text((256, 160), "Example Lab", fontsize=11)
        data = doc.tobytes()
        doc.close()
        return pdf_utils.title_of(data)

    def test_a_larger_symbol_does_not_set_the_title_size(self):
        # a math symbol that opens the title is set larger than the rest of its line, and as
        # the line's size it left out the title's second line
        def place(tw):
            _, end = tw.append((74, 80), "X", fontsize=26)
            tw.append(end, "0: A Model for Learning", fontsize=24)
            tw.append((194, 108), "from Many Small Tasks", fontsize=24)

        self.assertEqual(
            self._title(place), "X0: A Model for Learning from Many Small Tasks"
        )

    def test_lines_on_one_row_read_left_to_right(self):
        # a small-caps title comes word by word, and a short word sits a hair lower
        def place(tw):
            tw.append((100, 100), "LEARNING", fontsize=14)
            tw.append((200, 102), "FROM", fontsize=14)
            tw.append((260, 100), "SMALL", fontsize=14)
            tw.append((100, 120), "DATA", fontsize=14)

        self.assertEqual(self._title(place), "LEARNING FROM SMALL DATA")
