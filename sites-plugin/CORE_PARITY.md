# Current port boundary

This experimental port is not feature-equivalent to the original Sundark application.

Implemented: owner-scoped metadata/PDF storage; original-derived browser reader; PDF.js extraction and explicit English page OCR; source/provenance persistence; bounded MCP task preparation; ChatGPT-produced artifact storage; glossary/translation/Anatomy/review validation; selected figure storage and referenced-figure review export.

Incomplete: an actually displayed ChatGPT embedded UI; PDF upload and the original reader inside that UI; original automatic inference workflow; exact DocLayout/PyMuPDF geometry; cross-page stitching and automatic equation detection/reconstruction. A successful MCP tool response or HTML resource request does not prove that a widget rendered.

The latest UI resource is a compatibility probe, not a verified fix. No automatic server-side AI or billable API key is configured. See README.md for setup and verification, and docs/UPSTREAM_FIDELITY.md for the original-to-port source map.
