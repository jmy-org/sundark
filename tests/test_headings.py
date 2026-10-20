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


class FirstPageTests(unittest.TestCase):
    def test_the_abstract_heading_is_a_word_that_opens_its_line(self):
        def words(*lines):
            return [
                {"t": t, "y0": y, "line": (n, 0)}
                for n, (y, text) in enumerate(lines)
                for t in text.split()
            ]

        # 2411.14499 has no Abstract heading; "abstracting" in its introduction is not one
        prose = words((300, "early work focused on abstracting the world"))
        self.assertEqual(pdf_utils._front_cut(prose, 800), 800 * 0.22)
        self.assertEqual(
            pdf_utils._front_cut(words((250, "Abstract—We study")), 800), 250
        )
        self.assertEqual(pdf_utils._front_cut(words((250, "ABSTRACT")), 800), 250)

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
