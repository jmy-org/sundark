# Sundark source fidelity audit

Reference: https://github.com/jmy-org/sundark/tree/47b680ebe65ac2e75911ba7879fc1d7e79787ca8 (main inspected 2026-10-22).

The current private Sites adaptation is not yet equivalent to Sundark. The upstream repository has no LICENSE file and GitHub reports license=null. This document records behavioral provenance, not a redistribution license. Implementations below must not be described as upstream code unless actually reused with appropriate rights.

| Original source and behavior | Current adaptation | Required correction |
|---|---|---|
| `app/pdf_utils.py::_page_layout`, `layout`: DocLayout regions, styled word boxes, sentence repair, paragraphs, running-header/end-matter exclusion, cross-page continuation | `lib/pdf-engine.ts::extractPage` uses PDF.js text items, approximate row sorting; OCR uses Tesseract | Remove unjustified row-order assumptions; define semantic source/geometry contract and distinguish fallback engine. Exact learned layout remains missing, not silently replaced. |
| `web/app.js::paragraphBatches`, `preparePage`, `paintFrontier`: paragraph batches, headings, strict contiguous paint order | Page-level saved translation rendering | Add stable sentence/paragraph mapping, bounded ordered batches and partial-progress state. ChatGPT tool batches are not the upstream HTTP NDJSON stream. |
| `app/ai.py::translate_brief`, `_REGISTER`, `_brief_block`; `main.py::_get_brief` | Per-artifact glossary, no shared document glossary | Persist document/language glossary; fixed academic register; include revision and selected-source provenance. |
| `app/ai.py::translate_stream`, `untranslated`; `main.py::translate_stream` | IDs and source hashes validated; incomplete/unchanged-language content may be accepted | Preserve exact count/order, detect likely untranslated long prose, and never save a source fallback as successful translation. Keep current stronger owner/CAS/idempotency checks. |
| `web/app.js::lineRects`, `segParts`, `highlightSource` | One bounding rectangle per text item | Multiple word/line rectangles and cross-page geometry, both-direction selection/scroll, explicit engine limits. |
| `app/ai.py::equation_latex`, `latex_ok`; `main.py` equation routes | Manual selected crop and vision MCP work prepared but not deployed; basic text artifact | Validated LaTeX, original equation association and equation numbers. Manual crops are not automatic DocLayout formula recognition. |
| `app/ai.py::_ANATOMY_SCHEMA`, `anatomy`, `verify_quote` | Generic sections and quotes | Fixed problem/gap/claim/method/evidence/limitations cards, present/not_present, author_stated/synthesis/ai_interpretation; validate supplied quotes without inventing absent evidence. |
| `app/ai.py::chat`, `explain` | Saved one-off questions/explanations | Bounded recent conversation context and selected excerpt/source references; distinguish paper-grounded claims from interpretation. |
| `app/ai.py::review`, `main.py::review_export` | Unpublished raw artifact/figure ZIP | Actual readable six-section review, verified frontmatter, only referenced figures. Raw backup ZIP must not be called an equivalent review. |
| `app/ai.py::cache_tag`, prompt revisions; `main.py` source segment signature | Source hash and immutable artifacts, model label | Retain current security and add schema/prompt revisions plus language/brief/source-signature-based reuse. |

## Runtime boundary

Sites Workers do not host the original Python/PyMuPDF/Torch/DocLayout process. Native ChatGPT model reasoning through MCP can generate translations, summaries, anatomy and Q&A without configuring a separate paid inference API, but it does not itself reproduce the upstream layout engine. Browser PDF.js/Tesseract are explicitly separate fallback engines. Scanned-page OCR is an added user requirement, not a feature the original README claimed to support.

## Verification state

Production: actual synthetic source → ChatGPT translation/summary/anatomy/Q&A → private storage → reread passed. Optional MCP Apps resource returned data but actual host widget rendering was unavailable. No authenticated visual browser session was available.

Local unpublished increment: 97 integration checks passed, including private crop storage, image validation, cross-user access rejection and bounded ZIP transport. Passing these tests does not establish upstream fidelity. No new changes are to be described as full Sundark parity.

## Remediation order

1. Source contract and original-driven reading/alignment semantics; explicitly surface layout limitations.
2. Shared glossary, ordered batch contracts, academic register and output checks.
3. Original structured Anatomy and review workflows, source-grounding and referenced figures.
4. Reader progression/alignment and original behavior tests, then private deployment and actual MCP verification.

## Original-frontend restoration, 2026-10-22

The earlier React-only reader was not a faithful frontend port. The additional `/original` reader now directly adapts the pinned upstream `web/index.html`, `web/styles.css`, and `web/app.js`. Provenance is recorded in each file. Retained functions include continuous page construction, zoom/viewport anchoring, paragraph batches, contiguous translation paint frontier, multi-part highlighting, quote-to-source navigation, and the structured Anatomy cards. PDF.js 6's native TextLayer replaces the older text-layer implementation. Markdown is sanitized and dependency assets are same-origin.

`public/sundark-original/adapter.js` maps the original endpoint contract to the existing owner-scoped D1/R2 store. Its NDJSON response transports already-saved model output; it is not new token streaming or autonomous inference. Missing output is an explicit error, never copied source text. Only displayed pages explicitly request browser extraction; scanned-page English OCR requires the current-page OCR button. Original local OAuth/Zotero/backend settings are not offered because they are not implemented in this runtime.

New contracts preserve sentence IDs, paragraph IDs and multiple rectangles with explicit `pdf-item` or `ocr-word` precision. They do not pretend to be original learned word/region geometry. Shared glossary, exact ordered translation batches, original nine-card Anatomy, LaTeX structural validation and six-section generated review export are implemented. Raw backup ZIP remains separate from generated review ZIP. `prepare_paper_task` provides bounded source and original-derived generation rules to the actual ChatGPT model, then `save_paper_analysis` persists its output using source-hash/CAS checks.

114 local HTTP integration checks and 13 contract/adapter checks passed before deployment. Browser visual verification is not established: Chromium could not start under the available environment restrictions. This does not establish automatic math localization, original DocLayout model parity, or an embedded ChatGPT widget. Those remain explicit gaps.
