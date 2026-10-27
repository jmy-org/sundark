# Sundark core parity tracker

Reference: jmy-org/sundark main, inspected 2026-10-22. This Site is not yet a faithful port; library publication alone did not complete the original request.

| Flow | Original evidence | Site status |
| --- | --- | --- |
| Text PDF rendering + extraction | web/app.js PDF.js; app/pdf_utils.py PyMuPDF | Implemented; local extraction and persistence tests passed, authenticated production visual test pending |
| PDF attached in ChatGPT, read without saving (default) | upload + /api/layout | `read_attached_pdf` / `prepare_attachment_task` / `render_attached_reader`: per-request memory only, no D1/R2 writes, per-page sourceHash re-verified on render, ordered translation prefix and analysis validated with the saved-result rules. The reader view shows the original PDF in-band through the app-only `read_attachment_original` (2 MiB chunks in result `_meta` only, bound to `pdfSha256`), with an empty widget CSP. File hosts: one label under `oaiusercontent.com` (a namespace rule, not proof of provenance) or exact extras. Node tests with storage that throws passed; local workerd run (`tests/local-attachment.py dev`) passed with D1/R2 counts unchanged; live ChatGPT host gate, `download_url` on later turns, `_meta` delivery to the view, the result size ceiling and the reader widget pending |
| PDF attached in ChatGPT -> library (explicit save only) | upload + /api/layout | `import_paper_pdf` + `extract_paper_pages`: original bytes in R2, server pdf.js text layer with the browser's atom/sentence rules (no OCR, no DocLayout). Local workerd tests passed; live ChatGPT attachment host gate pending |
| Region-aware, two-column sentence mapping | required DocLayout-YOLO + PyMuPDF, main.py startup and pdf_utils.py | Not equivalent; browser row/box extraction only |
| Scanned-document OCR | README says not yet supported | Implemented English Tesseract OCR; real synthetic-image OCR passed, browser end-to-end test pending |
| Equation vision → LaTeX | main.py /api/math and ai.py equation_latex | ChatGPT plugin generation/persistence implemented; live model test pending |
| Side-by-side streaming translation | main.py /api/translate_stream, glossary + paragraph batching + segment cache | ChatGPT plugin source→model→immutable save implemented; saved side-by-side reader. In-Site streaming is not implemented. |
| Selection explanation | main.py /api/explain | ChatGPT plugin generation/persistence implemented; live model test pending |
| Summary, anatomy with verified quotes | /api/summarize, /api/anatomy | ChatGPT plugin generation/persistence implemented; live model test pending |
| Paper-context Q&A and history | /api/chat and paper identity | ChatGPT plugin generation/persistence implemented; live model test pending |
| Review export with cited figures | /api/review/{doc_id}, Markdown + ZIP PNGs | Pending core model/layout runtime |
| Zotero integration | local Zotero read-only API | User asked Zotero-like organization, not account integration; no automatic import |
| Collections, tags, PDF storage, notes | supporting library flow | Implemented with owner-private D1/R2 |

## Deployment constraint

Sites Workers cannot run the original Python/Torch/DocLayout-YOLO or CLI AI processes. No supported model-inference binding has yet been verified for this Site identity. The documented OSS ChatGPT-plan route uses local loopback OAuth plus protected credentials; native Sites and other supported website integration routes are still being checked. No credentials have been copied or created. The inference/runtime decision remains pending.

## OCR limits

Browser extraction and English OCR do not claim DocLayout equivalence. OCR is page-by-page, cancellable and bounded. Math, multi-column order, tables, non-English text and handwriting may be inaccurate; source images remain authoritative. Real text/OCR and live AI tests must be distinguished from deterministic mocks.

## Plugin model workflow

ChatGPT retrieves explicitly selected source pages, generates translations/summaries/anatomy/Q&A, and saves immutable artifacts with source hashes. The Site never pretends to call a model itself. Source changes mark old artifacts stale. Citation quotes are checked against page and segment. The optional MCP UI is not claimed supported until verified in the host. Original vision math recovery, DocLayout and review ZIP figures remain outside this increment.
