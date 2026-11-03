"""Sentence-splitting post-processing and page stitching (app/pdf_utils).

On top of the segmenter:
- Enumeration: the segmenter only breaks a list when its items end in terminal punctuation, so
  comma/"and"-joined lists and markerless items stay glued. `_split_on_markers` breaks a
  qualifying enumeration run itself, while leaving references and short subfigure phrases intact.
- Over-splits: the segmenter also breaks mid-sentence - at an inline math operator, a citation
  ("(FiLM)" | "Perez et al. (2018)", "VGG nets" | "[41] but"), a capital math symbol, a
  parenthesis, closing punctuation, or inside a word. `_mend_word_splits` and `_merge_fragments`
  rejoin those, but never across a finished sentence.
- Short prose that the label filter dropped (a lead-in before a display equation) is kept by
  paragraph context, and a sentence cut by a page break is stitched to its continuation.
Cases are taken from real papers in the evaluation corpus and from reported bugs.
"""

import unittest
from unittest.mock import patch

import pymupdf
from spacy import util as spacy_util

from app import pdf_utils as pu
from app.pdf_utils import (
    _enum_candidates,
    _merge_fragments,
    _split_on_markers,
    _starts_citation,
    _starts_lower_frag,
    _starts_math_cont,
    _stitch_idx,
    _tail_open,
)


def merge_at(text: str, cuts: list[int]) -> list[str]:
    """Split text at the given char positions, run _merge_fragments, and return the segment
    texts. Also checks the output ranges still tile the text in order: highlighting maps these
    ranges to word boxes, so they must stay sorted, disjoint and contiguous."""
    bounds = [0, *cuts, len(text)]
    raw = [(bounds[i], bounds[i + 1]) for i in range(len(bounds) - 1)]
    out = _merge_fragments(raw, text)
    assert out[0][0] == 0 and out[-1][1] == len(text), out
    assert all(a[1] == b[0] for a, b in zip(out, out[1:])), out
    return [t for _, _, t in out]


def n_at(text: str, *cut_at: str) -> int:
    """Number of segments after cutting text before each given substring and merging."""
    return len(merge_at(text, [text.index(c) for c in cut_at]))


def mend(text: str, cut: int) -> list[str]:
    """Run the in-word boundary mender on a two-piece split at `cut`; ranges must still tile."""
    out = pu._mend_word_splits([(0, cut), (cut, len(text))], text)
    assert out[0][0] == 0 and out[-1][1] == len(text), out
    assert all(a[1] == b[0] for a, b in zip(out, out[1:])), out
    return [text[s:e].strip() for s, e in out]


def whole(text: str) -> list[str]:
    """Run the marker split over the whole text as one range and return the segment strings."""
    return [text[s:e].strip() for s, e in _split_on_markers([(0, len(text))], text)]


def starts(text: str) -> tuple[int, int]:
    return (0, len(text))


# (text, markers that must each begin a produced segment)
POSITIVES = [
    (
        "Policy Representations. a) Explicit policy with different action representations. "
        "b) Implicit policy learns an energy function that minimizes the energy landscape "
        "c) Diffusion policy refines noise into actions via a learned gradient field.",
        ["a)", "b)", "c)"],
    ),
    (
        "We show that: 1) Our extremely deep residual nets are easy to optimize, but the plain "
        "nets exhibit higher training error when the depth increases; 2) Our deep residual nets "
        "can easily enjoy accuracy gains from greatly increased depth.",
        ["1)", "2)"],
    ),
    (
        "The conv layers follow two simple design rules: (i) for the same output feature map "
        "size, the layers have the same number of filters; and (ii) if the feature map size is "
        "halved, the number of filters is doubled.",
        ["(i)", "(ii)"],
    ),
    (
        "In Table 3 we compare three options: (A) zero-padding shortcuts are used; (B) projection "
        "shortcuts are used; and (C) all shortcuts are projections.",
        ["(A)", "(B)", "(C)"],
    ),
    (
        "ReDex follows a three-stage pipeline: (1) train a proprioception-only policy in "
        "simulation, (2) collect real-world corrections, and (3) train a force-conditioned policy.",
        ["(1)", "(2)", "(3)"],
    ),
]

# text -> expected: NOT split internally (stays one segment)
NEGATIVES = [
    "The shortcut connections in Eqn.(1) introduce neither extra parameter nor computation.",
    "We show (a) Screwdriver Rotation and (b) cellphone Object Flipping.",
    "We evaluate the PASCAL VOC metric (mAP @ IoU = 0.5) and the standard COCO metric.",
    "The dimensions of x and F must be equal in Eqn.(1) and in Eqn.(2).",
]


class EnumSplitTests(unittest.TestCase):
    def test_positive_lists_split_into_items(self):
        for text, markers in POSITIVES:
            segs = whole(text)
            for mk in markers:
                self.assertTrue(
                    any(s.startswith(mk + " ") for s in segs),
                    f"{mk!r} did not begin a segment in: {segs}",
                )

    def test_items_are_not_re_merged_by_merge_fragments(self):
        # The full post-processing order: marker split, then merge. A list item must survive.
        for text, markers in POSITIVES:
            split = _split_on_markers([(0, len(text))], text)
            segs = [t for _, _, t in _merge_fragments(split, text)]
            for mk in markers:
                self.assertTrue(
                    any(s.startswith(mk + " ") for s in segs),
                    f"{mk!r} was merged away in: {segs}",
                )

    def test_negatives_are_not_split(self):
        for text in NEGATIVES:
            self.assertEqual(
                whole(text), [text.strip()], f"should stay one segment: {text!r}"
            )

    def test_markerless_run_needs_three(self):
        # Two markers with no colon introduction: a subfigure-style phrase -> no split.
        two = "We compare (a) the baseline and (b) our method."
        self.assertEqual(whole(two), [two])
        # Three markers with no colon -> a real list, split.
        three = "Steps: a) load, b) run, c) save."  # colon present too
        self.assertGreaterEqual(len(whole(three)), 3)

    def test_reference_markers_filtered(self):
        # Eqn.(1)/(2) are references, not list items, so no candidates survive the abbr guard.
        cands = _enum_candidates("as shown in Eqn.(1) and Eqn.(2) above")
        self.assertEqual(cands, [])

    def test_enum_item_not_merged_as_lower_continuation(self):
        # "a) ..." starts lowercase but is a list item, not an inline-math over-split.
        t = "a) first item here"
        self.assertFalse(_starts_lower_frag(t, starts(t)))
        # a genuine lowercase continuation is still a continuation.
        t2 = "and then we proceed"
        self.assertTrue(_starts_lower_frag(t2, starts(t2)))


class InlineMergeTests(unittest.TestCase):
    """Rejoin fragments the segmenter broke mid-sentence at inline math or a citation. Both merge
    only when the running text is NOT already a finished sentence (guard against real boundaries).
    """

    def test_math_operator_tail_rejoins(self):
        t = "a sequence of continuous representations z = ( z 1 , ..., z n ) ."
        self.assertEqual(len(merge_at(t, [t.index("= (")])), 1)

    def test_math_operator_chain_rejoins(self):
        t = "we set x = y + z ."
        self.assertEqual(len(merge_at(t, [t.index("= y"), t.index("+ z")])), 1)

    def test_math_chain_stops_once_the_sentence_is_finished(self):
        t = "we set x = y . + z holds as well"
        self.assertEqual(len(merge_at(t, [t.index("= y"), t.index("+ z")])), 2)

    def test_math_operator_does_not_cross_a_finished_sentence(self):
        t = "The result was clear. = 5 holds in every run."
        self.assertEqual(len(merge_at(t, [t.index("= 5")])), 2)

    def test_dash_list_items_are_not_merged_as_math(self):
        # "$-$" item labels extract as U+2212; "− We ..." is a list item, not a math tail.
        t = "Our contributions: − We propose a new loss − We evaluate it on three benchmarks"
        cuts = [i for i, c in enumerate(t) if c == "−"]
        self.assertEqual(len(merge_at(t, cuts)), 3)

    def test_a_fragment_ending_on_an_operator_rejoins(self):
        # NeRF and Adam with CMEX10 decoded: the segmenter broke right after "∑" and after "<".
        t = "weights as w i = w i / ∑ Nc j =1 w j produces a constant PDF."
        self.assertEqual(len(merge_at(t, [t.index("Nc")])), 1)
        t = "we have that | m t / √ v t | < 1 therefore | Δ t | < α ."
        self.assertEqual(len(merge_at(t, [t.index("1 therefore")])), 1)
        t = "where C = 10 n ( t 0 − t ′ ) √ Q."
        self.assertEqual(len(merge_at(t, [t.index("√ Q")])), 1)

    def test_an_operator_inside_a_word_is_not_an_open_end(self):
        t = "We implemented it in C++ Our code is public."
        self.assertEqual(len(merge_at(t, [t.index("Our")])), 2)

    def test_math_operator_helper(self):
        for tail in ("= 64", "− 1 .", "· d", "+ b", "± 0.1", "< 0.5", "∑ i x i", "√ d"):
            self.assertTrue(_starts_math_cont(tail, starts(tail)), tail)
        # ASCII hyphen is deliberately not math (dash list items); neither is a capitalized
        # list item after a math-like label, nor plain text.
        for frag in ("- x", "− We propose", "· We evaluate", "Then"):
            self.assertFalse(_starts_math_cont(frag, starts(frag)), frag)

    def test_citation_tail_rejoins(self):
        t = (
            "we examine convolutional neural networks (CNNs) Ronneberger et al. ( 2015 ) "
            "and Transformers Vaswani et al. ( 2017 ), and compare them."
        )
        self.assertEqual(len(merge_at(t, [t.index("Ronneberger")])), 1)
        # both citations split off: still one sentence
        cuts = [t.index("Ronneberger"), t.index("Vaswani")]
        self.assertEqual(len(merge_at(t, cuts)), 1)

    def test_second_real_citation_example_rejoins(self):
        t = (
            "with Feature-wise Linear Modulation (FiLM) Perez et al. ( 2018 ) as well as "
            "denoising iteration k , shown in Fig 2 (b)."
        )
        self.assertEqual(len(merge_at(t, [t.index("Perez")])), 1)

    def test_citation_split_again_after_et_al_rejoins(self):
        # The year is in the NEXT fragment; the citation check looks past the fragment end and
        # _ABBR_TAIL then joins "et al." to the year.
        t = "with modulation (FiLM) Perez et al. ( 2018 ) as well as denoising iteration k ."
        cuts = [t.index("Perez"), t.index("( 2018")]
        self.assertEqual(len(merge_at(t, cuts)), 1)

    def test_citation_does_not_cross_a_finished_sentence(self):
        t = "This was shown earlier. Smith et al. ( 2020 ) proposed a method."
        self.assertEqual(len(merge_at(t, [t.index("Smith")])), 2)

    def test_finished_endings_block_a_citation_merge(self):
        # A curly closing quote, a footnote mark, or a spaced ". )" still ends the sentence.
        for t, author in (
            (
                "We call this “learning to learn.” Finn et al. ( 2017 ) proposed MAML.",
                "Finn",
            ),
            (
                "The code is publicly available.1 Ho et al. ( 2020 ) proposed DDPM.",
                "Ho ",
            ),
            ("Results improve ( see Appendix A . ) Ho et al. ( 2020 ) agree.", "Ho "),
        ):
            self.assertEqual(len(merge_at(t, [t.index(author)])), 2, t)

    def test_capitalized_non_citation_is_not_merged(self):
        t = "the model works well Then we evaluate it."  # no year-paren -> not a citation
        self.assertEqual(len(merge_at(t, [t.index("Then")])), 2)
        t2 = "The model is trained without augmentation In ( 2015 ), Smith showed it."
        self.assertEqual(len(merge_at(t2, [t2.index("In (")])), 2)

    def test_citation_helper(self):
        for c in (
            "Perez et al. ( 2018 ) as well",
            "Smith and Jones (2020) show",
            "Müller et al. ( 2020a , b ) show",
        ):
            self.assertTrue(_starts_citation(c, starts(c)), c)
        for c in ("Then we test", "In ( 2015 ), Smith", "ImageNet ( 1000 ) classes"):
            self.assertFalse(_starts_citation(c, starts(c)), c)


class LoneCapitalMergeTests(unittest.TestCase):
    """A capital math symbol the segmenter took for a sentence start (σ²I, x^K)."""

    def test_capital_math_symbol_rejoins(self):
        for t, cut in (
            ("where N ( 0 , σ 2 I is Gaussian noise added at each iteration.", "I is"),
            (
                "Starting from x K sampled from Gaussian noise, the model denoises.",
                "K sam",
            ),
        ):
            self.assertEqual(len(merge_at(t, [t.index(cut)])), 1, t)

    def test_references_words_and_finished_sentences_are_not_math_tails(self):
        for t, cut in (
            ("Results are listed in Table 2 A comparison follows below.", "A com"),
            ("We set the value to x. K sampled points follow.", "K sam"),
            ("we train the model I think this works.", "I thi"),
        ):
            self.assertEqual(len(merge_at(t, [t.index(cut)])), 2, t)


def page(*sents) -> dict:
    """A minimal layout page: plain strings are prose; (text, flag) sets heading/equation."""
    out = []
    for s in sents:
        text, flag = (s, None) if isinstance(s, str) else s
        out.append({"text": text, **({flag: True} if flag else {})})
    return {"sentences": out}


class PageStitchTests(unittest.TestCase):
    """_stitch_idx decides, for BOTH the forward and the backward pass, which sentence at the top
    of the next page continues the previous page's last sentence."""

    FILM = "with Feature-wise Linear Modulation (FiLM)"
    PEREZ = (
        "Perez et al. ( 2018 ) as well as denoising iteration k , shown in Fig 2 (b)."
    )

    def test_lowercase_continuation_still_stitches(self):
        prev = page("First part of a sentence that wraps to the")
        nxt = page("next page and ends here.", "Another sentence.")
        self.assertEqual(_stitch_idx(prev, nxt), 0)

    def test_citation_after_a_page_break_stitches(self):
        self.assertEqual(_stitch_idx(page(self.FILM), page(self.PEREZ)), 0)
        # a display equation at the top of the next page is skipped
        nxt = page(("z = f ( x )", "equation"), self.PEREZ)
        self.assertEqual(_stitch_idx(page(self.FILM), nxt), 1)

    def test_finished_or_colon_tail_does_not_stitch_a_citation(self):
        nxt = page("Perez et al. ( 2018 ) proposed FiLM.")
        self.assertIsNone(_stitch_idx(page("This ends the paragraph."), nxt))
        self.assertIsNone(
            _stitch_idx(page("The objective is defined as follows:"), nxt)
        )

    def test_heading_or_non_citation_start_does_not_stitch(self):
        prev = page(self.FILM)
        self.assertIsNone(_stitch_idx(prev, page(("3 Method", "heading"), self.PEREZ)))
        self.assertIsNone(_stitch_idx(prev, page("Figure 3: Overview of the method.")))

    def test_tail_open(self):
        self.assertTrue(_tail_open(page(self.FILM)))
        self.assertFalse(_tail_open(page("Done.")))
        self.assertFalse(_tail_open(page("as follows:")))
        self.assertFalse(_tail_open(page(("1 Introduction", "heading"))))


class InWordBoundaryTests(unittest.TestCase):
    def test_punctuation_tail_is_merged(self):
        # Diffusion Policy p3: spaCy cut ');' -> the word was highlighted with two sentences
        t = "actively studied Ho et al. ( 2020 ); Nichol and Dhariwal ( 2021 )."
        self.assertEqual(len(mend(t, t.index("; Nichol"))), 1)
        # NeRF p23: 'Table 5:' cut before the colon
        t = "Table 5: Per-scene quantitative results from our real image dataset."
        self.assertEqual(len(mend(t, t.index(": Per"))), 1)
        # 2609.26280 p12: a dotted Java name is one token
        t = "• Ljavax.crypto.Cipher — API used for cryptographic operations;"
        self.assertEqual(len(mend(t, t.index("Cipher"))), 1)

    def test_sentence_final_tail_moves_the_boundary_to_the_word_end(self):
        # Planck p8: cut between ')' and '.' of '065).'
        t = "entirely, 1 . 180 ± 0 . 065). Switching to spectrum-based corrections."
        self.assertEqual(
            mend(t, t.index(". Switching")),
            [
                "entirely, 1 . 180 ± 0 . 065).",
                "Switching to spectrum-based corrections.",
            ],
        )

    def test_glued_sentences_stay_split(self):
        # 2609.26280 p10: the PDF lost the space - a real boundary inside one word
        t = "bit flips increases.The model starts at 0.9137 accuracy."
        self.assertEqual(len(mend(t, t.index("The model"))), 2)

    def test_boundaries_between_words_are_untouched(self):
        t = "First sentence. Second sentence."
        self.assertEqual(len(mend(t, t.index("Second"))), 2)


class BracketContinuationTests(unittest.TestCase):
    def test_citation_and_interval_rejoin(self):
        # ResNet p0, Perelman p4
        t = "deeper than VGG nets [41] but still having lower complexity."
        self.assertEqual(n_at(t, "[41]"), 1)
        t = "Suppose that the gradient flow for F m exists for t ∈ [0 , T ] ."
        self.assertEqual(n_at(t, "[0 ,"), 1)
        # the subject before a citation is no longer cut off (and dropped): ResNet p7
        t = "We adopt Faster R-CNN [32] as the detection method."
        self.assertEqual(n_at(t, "[32]"), 1)

    def test_not_across_a_finished_sentence(self):
        t = "This was shown before. [41] proposed a different method."
        self.assertEqual(n_at(t, "[41]"), 2)


class ParenContinuationTests(unittest.TestCase):
    def test_non_marker_paren_rejoins(self):
        # Perelman p9, ResNet p6
        t = "a sequence of metric balls B k = B ( p k , r k ) at times t k ."
        self.assertEqual(n_at(t, "( p k"), 1)
        t = "Fig. 6 (middle) shows the behaviors of ResNets."
        self.assertEqual(n_at(t, "(middle)"), 1)

    def test_list_markers_and_finished_sentences_stay_split(self):
        t = "we consider two options: (A) zero-padding shortcuts are used"
        self.assertEqual(n_at(t, "(A)"), 2)
        t = "The proof is complete. (This also holds for n = 2.)"
        self.assertEqual(n_at(t, "(This"), 2)


class ClosingPunctuationContinuationTests(unittest.TestCase):
    def test_closing_or_connective_punctuation_rejoins(self):
        t = "In his seminal paper , Hamilton proved that this equation has a solution."
        self.assertEqual(n_at(t, ", Hamilton"), 1)  # Perelman p0
        t = "the minimizer f is 2 △ f −|∇ f | 2 + R = const."
        self.assertEqual(n_at(t, "| 2"), 1)  # Perelman p7
        t = "position t , and p e expert e ’s predicted distribution."
        self.assertEqual(n_at(t, "’s"), 1)  # 2609.37899 p2

    def test_not_across_a_finished_sentence(self):
        t = "The result was clear. ; this fragment is odd"
        self.assertEqual(n_at(t, "; this"), 2)


class CommaSemicolonEndTests(unittest.TestCase):
    def test_citation_list_and_math_list_rejoin(self):
        t = "standard sirens ( Holz & Hughes 2005 ; Abbott et al. 2017 ; Chen 2018 )."
        self.assertEqual(n_at(t, "Abbott"), 1)  # Planck p27
        t = "architecture ( LeCun et al. , 1998 ; Krizhevsky et al. , 2012 )."
        self.assertEqual(n_at(t, "Krizhevsky"), 1)  # 2007.06559 p0
        t = "GPU-hours sum work across devices, H = s P i g i τ i / 3600 ."
        self.assertEqual(n_at(t, "H ="), 1)  # 2609.37899 p27

    def test_list_items_after_a_semicolon_or_comma_stay_split(self):
        t = "zero-padding shortcuts are used; (B) projection shortcuts are used"
        self.assertEqual(n_at(t, "(B)"), 2)  # ResNet p3
        t = "on the complex unit circle, • F is the unitary discrete Fourier transform"
        self.assertEqual(n_at(t, "•"), 2)  # Halko p26


class CapitalMathSymbolTests(unittest.TestCase):
    def test_capital_symbol_rejoins(self):
        t = "we can estimate the residual error ∥ A − QQ ∗ A ∥ ."
        self.assertEqual(n_at(t, "A −"), 1)  # Halko p4
        t = "inversely proportional to a (scaled) L 2 norm of their gradients."
        self.assertEqual(n_at(t, "L 2"), 1)  # Adam p7
        t = "the error term is of size O ( y 2 max R 2 (log N ) 4 k )."
        self.assertEqual(n_at(t, "O ("), 1)  # 1311.4600 p9

    def test_words_and_finished_sentences_stay_split(self):
        t = "the images are sorted A 2D map is then built."  # article before a number
        self.assertEqual(n_at(t, "A 2D"), 2)
        t = "the cells were sorted T cells are shown in red."  # capital before a word
        self.assertEqual(n_at(t, "T cells"), 2)
        t = "We set the value to x. K is fixed afterwards."
        self.assertEqual(n_at(t, "K is"), 2)


class HyphenCompoundEndTests(unittest.TestCase):
    def test_compound_split_at_a_line_break_rejoins(self):
        t = "a five-rung pretraining ladder on LIBERO- Long alone, with four runs."
        self.assertEqual(n_at(t, "Long"), 1)  # 2610.04009 p5
        t = "GPT- 5.6 Sol with VISTA substantially outperforms baselines."
        self.assertEqual(n_at(t, "5.6"), 1)  # 2610.02200 p1

    def test_spaced_dash_is_not_a_compound(self):
        t = "the first item - Second item starts here"
        self.assertEqual(n_at(t, "Second"), 2)


class SpacedAbbreviationTests(unittest.TestCase):
    def test_spaced_et_al_and_vs_hold_the_next_fragment(self):
        t = "novel-view synthesis [Flynn et al . 2016; Zhou et al . 2016]."
        self.assertEqual(n_at(t, "2016; Z"), 1)  # 3DGS p1
        t = "Identity vs . Projection Shortcuts."
        self.assertEqual(n_at(t, "Projection"), 1)  # ResNet p5 (run-in heading)

    def test_ordinary_spaced_period_still_ends_a_sentence(self):
        t = "This is the end . Then we stop."
        self.assertEqual(n_at(t, "Then"), 2)


class BareListMarkerTests(unittest.TestCase):
    def test_letter_marker_joins_its_item(self):
        t = "we consider two options: (A) The shortcut still performs identity mapping."
        segs = merge_at(t, [t.index("(A)"), t.index("The shortcut")])  # ResNet p3
        self.assertEqual(segs[-1], "(A) The shortcut still performs identity mapping.")

    def test_number_or_marker_followed_by_marker_stays(self):
        t = "(21) At fixed model size, more shards make each expert cheaper."
        self.assertEqual(n_at(t, "At fixed"), 2)  # an equation number, 2609.37899 p25
        t = "(a) (c) Graph measures vs. neural network performance."
        self.assertEqual(n_at(t, "(c)"), 2)  # 2007.06559 p5 subfigure labels


class ShortColonLabelTests(unittest.TestCase):
    def test_label_joins_the_sentence_after_it(self):
        t = "Right: Each cell in the mask is one block."
        self.assertEqual(n_at(t, "Each"), 1)  # 2610.04009 p2
        t = "Figure 13: Ablation studies of our data engine stages."
        self.assertEqual(n_at(t, "Ablation"), 1)  # SAM p11

    def test_list_intro_and_long_clauses_stay_split(self):
        t = "We ask: 1) Can ReDex improve the real-world policy?"
        self.assertEqual(n_at(t, "1)"), 2)  # 2610.07525 p3
        t = "We consider the following external data sets: Planck and BAO."
        self.assertEqual(n_at(t, "Planck"), 2)


class KeepProseByContextTests(unittest.TestCase):
    def test_short_prose_is_kept_in_context(self):
        # Halko/1311.4600: a lead-in cut off by a display equation
        self.assertFalse(pu._keep_sentence("Then we have", 3))
        self.assertTrue(pu._keep_sentence("Then we have", 3, 2))
        self.assertTrue(pu._keep_sentence("Then we have", 3, 1))
        # a one-word lead-in only inside a prose paragraph
        self.assertFalse(pu._keep_sentence("Then", 1, 1))
        self.assertTrue(pu._keep_sentence("Then", 1, 2))
        # a page tail that wraps to the next page (ResNet p1)
        self.assertTrue(pu._keep_sentence("In addition, high-", 3, 2))
        self.assertTrue(pu._keep_sentence("• Ljavax.crypto.Cipher", 2, 2))

    def test_labels_and_numbers_are_still_dropped(self):
        self.assertFalse(pu._keep_sentence("PSNR ↑", 2, 1))  # NeRF table header
        self.assertFalse(pu._keep_sentence("Cross Attention", 2, 0))
        self.assertFalse(pu._keep_sentence("(1.1)", 1, 2))  # equation number


class HyphenPageTailTests(unittest.TestCase):
    def test_hyphenated_page_tail_stitches(self):
        prev = page("We then use RoI pooling to extract fea-")  # 1812.05038 p1
        self.assertTrue(pu._tail_unfinished(prev))
        nxt = page("tures for all person detections at each time-step.", "Next one.")
        self.assertEqual(pu._stitch_idx(prev, nxt), 0)

    def test_number_range_tail_does_not(self):
        self.assertFalse(pu._tail_unfinished(page("covering the years 2018-")))


class ParenIsNotAListMarkerTests(unittest.TestCase):
    def test_closing_paren_of_math_is_not_a_marker(self):
        t = "We claim that R ( z , 0) /R ( z k , 0) is bounded, and R ( y , 0) is too."
        self.assertEqual(pu._enum_candidates(t), [])  # Perelman p30

    def test_real_items_are_still_found(self):
        t = "We show that: 1) Our nets are easy to optimize; 2) Our nets gain accuracy."
        self.assertEqual(len(pu._enum_candidates(t)), 2)


class DegreeSignIsNotABulletTests(unittest.TestCase):
    def whole(self, t):
        return [t[s:e].strip() for s, e in pu._split_on_bullets([(0, len(t))], t)]

    def test_degree_and_composition_signs(self):
        t = "measured to an accuracy of approximately 1 ◦ and the efficiencies to 1 %"
        self.assertEqual(len(self.whole(t)), 1)  # Planck p4
        t = "formulating F Θ as a composition F Θ = F ′ Θ ◦ γ , one learned"
        self.assertEqual(len(self.whole(t)), 1)  # NeRF p6

    def test_bullets_after_a_clause_still_split(self):
        self.assertEqual(len(self.whole("Two parts: ◦ First item. ◦ Second item.")), 3)
        self.assertEqual(
            len(self.whole("contributions are: • We introduce X • We show Y")), 3
        )


class CaptionAwareStitchTests(unittest.TestCase):
    def test_caption_and_mid_paragraph_fragments_are_skipped(self):
        # NeRF p17: a caption piece and a mid-paragraph lowercase fragment precede the
        # continuation, which opens its own paragraph
        nxt = {
            "sentences": [
                {
                    "text": "Fig. 7: A visualization of our network.",
                    "para": 0,
                    "caption": True,
                },
                {
                    "text": "final layer outputs the radiance.",
                    "para": 0,
                    "caption": True,
                },
                {"text": "Input vectors are shown in green.", "para": 1},
                {"text": "ﬁnal layer (with a sigmoid) outputs RGB.", "para": 1},
                {"text": "dataset requires 640k rays per image.", "para": 2},
            ]
        }
        self.assertEqual(pu._continuation_idx(nxt), 4)

    def test_captions_do_not_use_up_the_scan(self):
        caps = [
            {"text": f"Caption line {i}.", "para": 0, "caption": True}
            for i in range(20)
        ]
        nxt = {"sentences": caps + [{"text": "continues here.", "para": 1}]}
        self.assertEqual(pu._continuation_idx(nxt), 20)

    def test_pages_without_para_keys_behave_as_before(self):
        self.assertEqual(pu._continuation_idx(page("next page ends here.", "More.")), 0)
        self.assertEqual(
            pu._continuation_idx(page("Figure 3: Caption.", "rest of it.")), 1
        )


class NonAsciiLowercaseContinuationTests(unittest.TestCase):
    def test_greek_and_ligature_starts_rejoin_an_unfinished_fragment(self):
        t = "moderate tensions at about the 2 . 5 σ level."
        self.assertEqual(n_at(t, "σ level"), 1)  # Planck p2
        t = "a complete solution to the Ricci ﬂow whenever the curvatures stay bounded."
        self.assertEqual(n_at(t, "ﬂow"), 1)  # Perelman p1

    def test_not_across_a_finished_sentence(self):
        t = "The noise is small. σ is the noise level."
        self.assertEqual(n_at(t, "σ is"), 2)


class SpacedEllipsisTests(unittest.TestCase):
    """TeX's \\dots comes out as spaced periods ("{ x 1 , . . . , x n }"), and the segmenter
    ended the sentence inside them, so one sentence came out as several short pieces."""

    @staticmethod
    def _merged(text: str, cuts: list[str]) -> list[str]:
        """Merge `text` cut before each string in `cuts` (the segmenter's boundaries)."""
        starts = [0] + [text.index(c) for c in cuts]
        raw = list(zip(starts, starts[1:] + [len(text)]))
        return [t for *_, t in _merge_fragments(raw, text)]

    def test_a_list_goes_on_after_the_dots(self):
        t = "Let the set { x 1 , . . . , x n } and { y 1 , . . . } be given. Each is a vector."
        self.assertEqual(
            self._merged(t, [". , x n }", "} be given.", "Each is"]),
            [
                "Let the set { x 1 , . . . , x n } and { y 1 , . . . } be given.",
                "Each is a vector.",
            ],
        )

    def test_an_operator_or_a_closing_quote_goes_on(self):
        t = "Choose 0 ≤ h 1 < . . . < h k so that it holds."
        self.assertEqual(self._merged(t, ["< h k"]), [t])
        t = "As marked by “. . . ”, parts are omitted."
        self.assertEqual(self._merged(t, ["”, parts"]), [t])

    def test_a_new_sentence_or_a_page_number_starts_anew(self):
        t = "Let σ 1 ≥ σ 2 ≥ . . . . Choose a target rank k."
        self.assertEqual(
            self._merged(t, ["Choose"]),
            ["Let σ 1 ≥ σ 2 ≥ . . . .", "Choose a target rank k."],
        )
        t = "2.1 Setup . . . . . . . 4 2.2 Results . . . . . . 5"
        self.assertEqual(
            self._merged(t, ["4 2.2"]),
            ["2.1 Setup . . . . . . .", "4 2.2 Results . . . . . . 5"],
        )

    def test_a_symbol_after_a_range_goes_on(self):
        # three dots after a value end no sentence before a one-letter symbol; "A" may open
        # one
        t = "2: for k = 1 . . . K do"
        self.assertEqual(self._merged(t, ["K do"]), [t])
        t = "We count t = 1 . . . A new run starts."
        self.assertEqual(
            self._merged(t, ["A new"]), ["We count t = 1 . . .", "A new run starts."]
        )


def item_starts(*lines: str, numbered=()) -> list[str]:
    """The markers `_item_starts` finds in a paragraph of `lines`, given the page's
    line-opening (kind, number) readings `numbered`."""
    words, ls = [], []
    for text in lines:
        ls.append({"widx": [], "text": text})
        for t in text.split():
            ls[-1]["widx"].append(len(words))
            words.append({"t": t})
    return [words[g]["t"] for g in pu._item_starts(ls, words, set(numbered))]


class LineItemTests(unittest.TestCase):
    """A list item or an algorithm step that opens a line starts a sentence, given evidence
    that a list is laid out there: a colon before it, or the next or previous number."""

    def test_a_colon_or_a_neighbouring_number_is_evidence(self):
        self.assertEqual(
            item_starts("We take two steps:", "1. Train the model"), ["1."]
        )
        steps = {("colon", 1), ("colon", 2)}
        self.assertEqual(
            item_starts("1: repeat", "2: sample a batch", numbered=steps), ["1:", "2:"]
        )

    def test_a_marker_alone_is_prose(self):
        # a sentence-final number wrapped onto a new line
        self.assertEqual(item_starts("The batch size was", "8. The model is small"), [])
        # a panel reference: letters are no evidence of a list
        self.assertEqual(item_starts("as shown in panel", "(b) and the curve"), [])
        # the end of a parenthesis the line before opened
        near = {("paren", 2), ("paren", 4)}
        self.assertEqual(
            item_starts("as small (ideally", "3) as possible", numbered=near), []
        )
        # an equation or table reference, though the numbers around it open lines
        near = {("paren", 1), ("paren", 3)}
        self.assertEqual(
            item_starts("follows from Eq.", "(2) and holds", numbered=near), []
        )

    def test_a_broken_word_or_an_equation_the_text_goes_on_from_is_no_item(self):
        self.assertEqual(
            item_starts(
                "compare it with the top-", "5. We then train", numbered={("dot", 4)}
            ),
            [],
        )
        self.assertEqual(
            item_starts(
                "Substituting into", "(3) and (4) gives it", numbered={("paren", 2)}
            ),
            [],
        )

    def test_a_number_that_does_not_count_up_refers_back(self):
        # a list counts up: "2." after item 3 is the step it sends the reader back to
        self.assertEqual(
            item_starts(
                "1. Sample a batch from the data",
                "2. Take a gradient step on it",
                "3. If the loss is high, go to step",
                "2. Otherwise stop the training",
                numbered={("dot", 1), ("dot", 2), ("dot", 3)},
            ),
            ["1.", "2.", "3."],
        )

    def test_an_equation_number_alone_on_its_line_is_not_an_item(self):
        self.assertIsNone(pu._line_item({"widx": [0]}, [{"t": "(5)"}]))
        self.assertEqual(
            pu._line_item({"widx": [0, 1]}, [{"t": "(5)"}, {"t": "We"}]), ("paren", 5)
        )


def pseudo_starts(*lines) -> list[str]:
    """The words `_pseudo_starts` opens a step at, in a paragraph of `lines`: one row each,
    or (row, text) to set a line on an earlier row."""
    words, ls = [], []
    for k, line in enumerate(lines):
        row, text = line if isinstance(line, tuple) else (k, line)
        ls.append({"widx": [], "text": text, "cy": 12.0 * row, "size": 10.0})
        for t in text.split():
            ls[-1]["widx"].append(len(words))
            words.append({"t": t})
    return [words[g]["t"] for g in pu._pseudo_starts(ls, words)]


class PseudoCodeTests(unittest.TestCase):
    """Pseudo-code with no line numbers: each step opens a row, once a row closes a block or
    two signs show that the paragraph is pseudo-code."""

    def test_each_step_of_a_loop_starts_a_sentence(self):
        self.assertEqual(
            pseudo_starts(
                "Initialize the weights θ",
                "for each iteration do",
                "Sample a batch from the data",
                "θ ← θ − η g",
                "end for",
                "the loop stops when the loss is small",
            ),
            ["for", "Sample", "θ", "end", "the"],
        )
        self.assertEqual(
            pseudo_starts("repeat", "Sample a batch", "until converged"),
            ["Sample", "until"],
        )

    def test_a_wrapped_step_or_a_piece_of_its_row_goes_on(self):
        self.assertEqual(
            pseudo_starts(
                "for t = 1 to T do",
                "Select an action with noise and",
                "observe the reward r",
                "end for",
            ),
            ["Select", "end"],
        )
        self.assertEqual(
            pseudo_starts(
                "repeat",
                "Require: f ( θ ) :",
                (1, "Stochastic objective function"),
                "until converged",
            ),
            ["Require:", "until"],
        )
        # a step number set apart from its step keeps its step
        self.assertEqual(pseudo_starts("4:", "Sample a batch", "end for"), ["end"])

    def test_prose_before_the_algorithm_stays_whole(self):
        self.assertEqual(
            pseudo_starts(
                "We now describe how the weights of the",
                "Transformer model are trained in detail.",
                "for each batch do",
                "Update the weights",
                "end for",
            ),
            ["for", "Update", "end"],
        )

    def test_a_step_that_wraps_on_a_word_goes_on(self):
        self.assertEqual(
            pseudo_starts(
                "for t = 1 to T do",
                "Update the network with",
                "SGD and a decayed rate",
                "end for",
            ),
            ["Update", "end"],
        )

    def test_a_loop_over_a_spaced_ellipsis_opens_a_block(self):
        self.assertEqual(
            pseudo_starts(
                "for t = 1 , . . . , T do",
                "Sample a batch",
                "for k = 1 . . . K do",
                "Update it",
            ),
            ["Sample", "for", "Update"],
        )

    def test_one_row_that_opens_with_for_and_ends_in_do_is_prose(self):
        self.assertEqual(
            pseudo_starts(
                "We check the bound in each case,",
                "for every set we study, as we do",
                "Recover it from the lemma",
            ),
            [],
        )
        # nor is a word "end" on a row of its own, or a math definition beside an "if"
        self.assertEqual(
            pseudo_starts("The training runs from one", "end", "To the other side"), []
        )
        self.assertEqual(
            pseudo_starts(
                "Let f := g + h be the map, and",
                "if x is in A then",
                "f is positive on A.",
            ),
            [],
        )


# Only when the model is already installed: loading it here must not trigger a download.
@unittest.skipUnless(
    spacy_util.is_package("en_core_web_sm"), "spaCy model not installed"
)
class LineItemSplitTests(unittest.TestCase):
    def test_an_item_offset_always_starts_a_sentence(self):
        t = "We take two steps: 1. Train the model on the data 2. Test it on new data"
        hard = frozenset(t.index(m) for m in ("1. Train", "2. Test"))
        self.assertEqual(
            [st for *_, st in pu._split_sentences(t, hard)],
            [
                "We take two steps:",
                "1. Train the model on the data",
                "2. Test it on new data",
            ],
        )

    def test_a_footnote_mark_before_an_item_ends_the_item_before(self):
        t = "The data is public. § 2. Test it on new data"
        hard = frozenset([t.index("2. Test")])
        self.assertEqual(
            [st for *_, st in pu._split_sentences(t, hard)],
            ["The data is public. §", "2. Test it on new data"],
        )

    def test_a_step_number_apart_from_its_step_is_not_a_sentence(self):
        doc = pymupdf.open()
        doc.new_page(width=595, height=842)
        p = doc.new_page(width=595, height=842)
        p.insert_text((50, 100), "3: take a gradient step", fontsize=10)
        p.insert_text((50, 160), "4:", fontsize=10)
        p.insert_text((50, 220), "5: until converged", fontsize=10)
        data = doc.tobytes()
        doc.close()
        with patch.object(pu.layout_model, "detect_page", return_value=[]):
            texts = [s["text"] for s in pu._page_layout(data, 1)["sentences"]]
        self.assertEqual(texts, ["3: take a gradient step", "5: until converged"])

    def test_list_items_and_algorithm_steps_on_a_page(self):
        doc = pymupdf.open()
        doc.new_page(width=595, height=842)
        p = doc.new_page(width=595, height=842)
        lines = [
            (50, 100, "We study the model in the following two settings:"),
            (60, 114, "1. Training on the full dataset with all of its"),
            (72, 126, "labels available to the learner"),
            (60, 140, "2. Training on half of the data"),
            (50, 240, "Algorithm 1 Training"),
            (50, 254, "1: repeat"),
            (50, 266, "2: sample a batch from the data"),
            (50, 278, "3: take a gradient step"),
            (50, 290, "4: until converged"),
            (50, 400, "The model was trained with a batch size of"),
            (50, 412, "8. The results are listed in the table below."),
        ]
        for x, y, text in lines:
            p.insert_text((x, y), text, fontsize=10)
        data = doc.tobytes()
        doc.close()
        with patch.object(pu.layout_model, "detect_page", return_value=[]):
            texts = [s["text"] for s in pu._page_layout(data, 1)["sentences"]]
        self.assertEqual(
            texts,
            [
                "We study the model in the following two settings:",
                "1. Training on the full dataset with all of its labels available to the "
                "learner",
                "2. Training on half of the data",
                "Algorithm 1 Training",
                "1: repeat",  # a short step is kept
                "2: sample a batch from the data",
                "3: take a gradient step",
                "4: until converged",
                "The model was trained with a batch size of 8.",  # a wrapped number
                "The results are listed in the table below.",
            ],
        )

    def test_the_short_pieces_of_a_list_or_an_algorithm_are_kept(self):
        # read whole, each was one sentence long enough to keep; cut at its items and steps,
        # a lead-in and a one-word step are pieces of a list, no figure labels
        for lines in (
            ["We consider:", "1. Speed", "2. Memory"],
            ["repeat", "Sample a batch", "until done"],
        ):
            doc = pymupdf.open()
            doc.new_page(width=595, height=842)
            p = doc.new_page(width=595, height=842)
            for k, text in enumerate(lines):
                p.insert_text((50, 100 + 12 * k), text, fontsize=10)
            data = doc.tobytes()
            doc.close()
            with patch.object(pu.layout_model, "detect_page", return_value=[]):
                texts = [s["text"] for s in pu._page_layout(data, 1)["sentences"]]
            self.assertEqual(texts, lines)

    def test_a_step_row_is_one_sentence(self):
        # the segmenter cut inside a step's own row ("Require: f(θ):" + "Stochastic ...");
        # the text after an algorithm keeps its sentences
        doc = pymupdf.open()
        doc.new_page(width=595, height=842)
        p = doc.new_page(width=595, height=842)
        lines = [
            (50, 100, "1: repeat"),
            (50, 112, "2: Compute the loss. Update the weights."),
            (50, 124, "3: until converged"),
            (50, 300, "for each batch do"),
            (62, 312, "Update the weights"),
            (50, 324, "end for"),
            (50, 336, "Is it done? The answer is yes."),
        ]
        for x, y, text in lines:
            p.insert_text((x, y), text, fontsize=10)
        data = doc.tobytes()
        doc.close()
        with patch.object(pu.layout_model, "detect_page", return_value=[]):
            texts = [s["text"] for s in pu._page_layout(data, 1)["sentences"]]
        self.assertEqual(
            texts, [t for *_, t in lines[:-1]] + ["Is it done?", "The answer is yes."]
        )

    def test_pseudo_code_without_line_numbers_on_a_page(self):
        doc = pymupdf.open()
        doc.new_page(width=595, height=842)
        p = doc.new_page(width=595, height=842)
        lines = [
            (50, 100, "Initialize the weights of the model"),
            (50, 112, "for each iteration do"),
            (62, 124, "Sample a batch from the data"),
            (62, 136, "Update the weights with the batch"),
            (50, 148, "end for"),
        ]
        for x, y, text in lines:
            p.insert_text((x, y), text, fontsize=10)
        data = doc.tobytes()
        doc.close()
        with patch.object(pu.layout_model, "detect_page", return_value=[]):
            texts = [s["text"] for s in pu._page_layout(data, 1)["sentences"]]
        self.assertEqual(texts, [text for *_, text in lines])


# Only when the model is already installed: loading it here must not trigger a download.
@unittest.skipUnless(
    spacy_util.is_package("en_core_web_sm"), "spaCy model not installed"
)
class EndToEndNoSharedWordTests(unittest.TestCase):
    """With the real segmenter: no boundary inside a word, citation list kept whole."""

    def test_diffusion_policy_citation_list(self):
        t = (
            "The noise schedule has been actively studied Ho et al. ( 2020 ); Nichol and "
            "Dhariwal ( 2021 ). The next sentence starts here."
        )
        segs = pu._split_sentences(t)
        for s, _e, _st in segs:
            self.assertTrue(s == 0 or t[s - 1].isspace() or t[s].isspace(), segs)
        self.assertEqual(len(segs), 2, [st for *_, st in segs])

    def test_spaced_ellipsis_stays_in_its_sentence(self):
        t = (
            "Given observations { O t − h +1 , . . . , O t } and actions { A t − h , . . . , "
            "A t − 1 } , our goal is to predict { A t , . . . , A t + h ′ − 1 } . The next "
            "sentence starts here."
        )
        self.assertEqual(len(pu._split_sentences(t)), 2, pu._split_sentences(t))


if __name__ == "__main__":
    unittest.main()
