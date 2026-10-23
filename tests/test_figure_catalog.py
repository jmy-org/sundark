"""The review export's figure catalog: each figure/table gets its own caption."""

import unittest
from unittest.mock import patch

import pymupdf

from app import pdf_utils


def _box(role, cls, x0, y0, x1, y1) -> dict:
    return {"role": role, "cls": cls, "x0": x0, "y0": y0, "x1": x1, "y1": y1}


def _catalog(texts, regions) -> list[dict]:
    """figure_catalog of one Letter page holding `texts` [(x, baseline y, text)], with the
    layout model returning `regions`."""
    doc = pymupdf.open()
    page = doc.new_page(width=612, height=792)
    for x, y, text in texts:
        page.insert_text((x, y), text, fontsize=9)
    data = doc.tobytes()
    doc.close()
    with patch.object(pdf_utils.layout_model, "detect_page", return_value=regions):
        return pdf_utils.figure_catalog(data)["figures"]


class FigureCatalogCaptionTests(unittest.TestCase):
    def test_an_equation_number_above_a_figure_is_not_its_caption(self):
        # synthetic fixture p2: "(1)" is 16pt above the figure, its caption 19pt below
        texts = [(530, 260, "(1)"), (55, 632, "Figure 1: Error over the steps.")]
        regions = [
            _box("caption", "formula_caption", 529.15, 249.51, 545.07, 263.86),
            _box("figure", "figure", 45.38, 279.72, 541.31, 601.62),
            _box("caption", "figure_caption", 52.02, 620.85, 545.95, 636.09),
        ]
        [fig] = _catalog(texts, regions)
        self.assertEqual(fig["id"], "fig-p1-1")
        self.assertEqual(fig["caption"], "Figure 1: Error over the steps.")

    def test_a_table_takes_its_caption_above(self):
        texts = [
            (55, 195, "Table 1: Mean error per run."),
            (55, 420, "Figure 2: Overview."),
        ]
        regions = [
            _box("caption", "table_caption", 52, 184, 316, 199),
            _box("table", "table", 78, 213, 531, 306),
            _box("figure", "figure", 45, 320, 541, 400),
            _box("caption", "figure_caption", 52, 410, 545, 424),
        ]
        tbl, fig = _catalog(texts, regions)
        self.assertEqual(tbl["caption"], "Table 1: Mean error per run.")
        self.assertEqual(fig["caption"], "Figure 2: Overview.")

    def test_a_figure_does_not_take_a_table_caption(self):
        # a captionless figure right above a table whose caption sits between them
        texts = [(55, 215, "Table 2: Ablation.")]
        regions = [
            _box("figure", "figure", 45, 80, 541, 200),
            _box("caption", "table_caption", 52, 205, 545, 219),
            _box("table", "table", 60, 225, 530, 330),
        ]
        fig, tbl = _catalog(texts, regions)
        self.assertEqual(fig["caption"], "")
        self.assertEqual(tbl["caption"], "Table 2: Ablation.")

    def test_a_captionless_figure_does_not_take_the_next_figures_caption(self):
        texts = [(55, 432, "Figure 3: The second plot.")]
        regions = [
            _box("figure", "figure", 45, 80, 541, 200),
            _box("figure", "figure", 45, 230, 541, 415),
            _box("caption", "figure_caption", 52, 420, 545, 436),
        ]
        first, second = _catalog(texts, regions)
        self.assertEqual(first["caption"], "")
        self.assertEqual(second["caption"], "Figure 3: The second plot.")

    def test_a_caption_in_the_other_column_is_not_taken(self):
        texts = [(55, 232, "Figure 4: Left."), (320, 132, "Figure 5: Right.")]
        regions = [
            _box("figure", "figure", 45, 80, 290, 215),
            _box("caption", "figure_caption", 315, 120, 560, 136),
            _box("figure", "figure", 315, 140, 560, 300),
            _box("caption", "figure_caption", 50, 220, 290, 236),
        ]
        left, right = _catalog(texts, regions)
        self.assertEqual(left["caption"], "Figure 4: Left.")
        self.assertEqual(right["caption"], "Figure 5: Right.")

    def test_caption_text_stays_inside_its_box(self):
        texts = [
            (55, 232, "Figure 6: Only this line."),
            (55, 252, "Body text right below the caption."),
        ]
        regions = [
            _box("figure", "figure", 45, 80, 541, 215),
            _box("caption", "figure_caption", 50, 220, 545, 236),
        ]
        [fig] = _catalog(texts, regions)
        self.assertEqual(fig["caption"], "Figure 6: Only this line.")


if __name__ == "__main__":
    unittest.main()
