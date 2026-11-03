"""The shared reader presentation has one source, web/reader-ui.css.

The hosted Site keeps a generated copy (scripts/sync_reader_ui.py) that is exported into
hosted-reader/. A copy that differs from the source by one byte, or whose header does not
match its body, fails here; the Site build applies the same header check."""

import re
import unittest
from pathlib import Path

from scripts import sync_reader_ui as sync

ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / "web" / "reader-ui.css"
EXPORT = ROOT / "hosted-reader" / sync.TARGET


class ReaderUiParityTests(unittest.TestCase):
    def test_exported_site_copy_matches_the_source(self):
        self.assertTrue(EXPORT.exists(), f"{EXPORT} is missing; re-export the Site")
        self.assertEqual(sync.body(EXPORT.read_bytes()), SOURCE.read_bytes())

    def test_one_changed_byte_fails(self):
        copy = sync.generated(SOURCE.read_bytes())
        self.assertEqual(sync.body(copy), SOURCE.read_bytes())
        at = len(copy) - 2
        changed = copy[:at] + bytes([copy[at] ^ 1]) + copy[at + 1 :]
        with self.assertRaises(ValueError):
            sync.body(changed)
        with self.assertRaises(ValueError):
            sync.body(SOURCE.read_bytes())

    def test_check_mode_reports_drift(self):
        import tempfile

        with tempfile.TemporaryDirectory() as site:
            self.assertEqual(sync.main(["--site", site, "--check"]), 1)
            self.assertEqual(sync.main(["--site", site]), 0)
            self.assertEqual(sync.main(["--site", site, "--check"]), 0)
            target = Path(site) / sync.TARGET
            target.write_bytes(target.read_bytes() + b"\n")
            self.assertEqual(sync.main(["--site", site, "--check"]), 1)

    def test_inlinable_under_an_empty_csp(self):
        css = SOURCE.read_text(encoding="utf-8")
        for pattern in (r"@import", r"@font-face", r"url\(", r"https?://"):
            self.assertIsNone(re.search(pattern, css), pattern)
        self.assertNotIn("</", css, "would close the widget's inline <style>")

    def test_local_page_loads_it_before_its_own_styles(self):
        html = (ROOT / "web" / "index.html").read_text(encoding="utf-8")
        shared = html.index('href="/reader-ui.css"')
        self.assertLess(shared, html.index('href="/styles.css"'))


if __name__ == "__main__":
    unittest.main()
