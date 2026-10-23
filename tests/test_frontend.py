import shutil
import subprocess
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


@unittest.skipUnless(shutil.which("node"), "node is only needed for JS checks")
class FrontendTests(unittest.TestCase):
    def node(self, script):
        r = subprocess.run(
            ["node", script], cwd=ROOT, capture_output=True, text=True, timeout=30
        )
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)

    def test_syntax(self):
        r = subprocess.run(["node", "--check", "web/app.js"], cwd=ROOT)
        self.assertEqual(r.returncode, 0)

    def test_rate_limit_stops_batch(self):
        self.node("tests/frontend_ratelimit.test.js")

    def test_rate_limit_drains_queued_batches_with_source(self):
        self.node("tests/frontend_ratelimit_queue.test.js")

    def test_output_language_settings_and_run_snapshot(self):
        self.node("tests/frontend_output_language.test.js")

    def test_preferences_handle_denied_browser_storage(self):
        self.node("tests/frontend_preference_storage.test.js")

    def test_errors_are_rendered_as_text(self):
        self.node("tests/frontend_error_html.test.js")

    def test_document_open_fences_late_pdf_and_panel_results(self):
        self.node("tests/frontend_open_generation.test.js")

    def test_upload_repick(self):
        self.node("tests/frontend_upload_repick.test.js")

    def test_reader_transport_contract(self):
        self.node("tests/frontend_transport.test.js")

    def test_markdown_keeps_latex_for_katex(self):
        self.node("tests/frontend_markdown_math.test.js")

    def test_pdf_wheel_zoom_keeps_pointer_and_browser_zoom_boundaries(self):
        self.node("tests/frontend_pdf_zoom.test.js")

    def test_copying_math_yields_latex(self):
        # KaTeX's copy-tex makes a copied formula paste as its LaTeX source instead of the
        # hidden MathML plus one line per glyph; it must match the loaded KaTeX version.
        html = (ROOT / "web" / "index.html").read_text(encoding="utf-8")
        import re

        versions = set(re.findall(r"KaTeX/([\d.]+)/", html))
        self.assertEqual(len(versions), 1, versions)
        self.assertIn(f"KaTeX/{versions.pop()}/contrib/copy-tex.min.js", html)

    def test_upload_is_reachable_by_keyboard(self):
        # A `hidden` file input is display:none, so Tab skipped Upload. The input stays
        # rendered (visually hidden) and the label shows its keyboard focus.
        import re

        html = (ROOT / "web" / "index.html").read_text(encoding="utf-8")
        css = (ROOT / "web" / "styles.css").read_text(encoding="utf-8")
        label = re.search(r'<label class="upload-btn">(.*?)</label>', html, re.S)
        assert label, "the file input sits inside the Upload label"
        tag = re.search(r'<input id="file"[^>]*>', label.group(1))
        assert tag
        self.assertNotRegex(tag.group(0), r"\s(hidden|tabindex|role)[\s=/>]")
        rule = re.search(r"\.upload-btn input\s*\{([^}]*)\}", css)
        assert rule, "the file input is visually hidden, not display:none"
        self.assertNotRegex(rule.group(1), r"display:\s*none|visibility:\s*hidden")
        self.assertRegex(
            css, r"\.upload-btn:has\(input:focus-visible\)\s*\{[^}]*outline:"
        )

    def test_sentence_navigator_shares_the_pin(self):
        self.node("tests/frontend_sentence_nav.test.js")

    def test_unrenderable_math_is_not_swapped_in(self):
        self.node("tests/frontend_math_guard.test.js")

    def test_zotero_collections_are_listed_as_a_tree(self):
        self.node("tests/frontend_zotero.test.js")

    def test_zotero_list_ignores_stale_replies_and_pages_by_next(self):
        self.node("tests/frontend_zotero_list.test.js")
