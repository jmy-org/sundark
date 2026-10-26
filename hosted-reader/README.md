# Sundark Research Library
Private owner-only ChatGPT Site with per-user D1 metadata and R2 PDF storage.

- ChatGPT-managed identity, no application secrets or external AI API.
- Paper metadata, collections/tags, notes and reading page/zoom persist in D1.
- PDFs use protected authenticated routes, never public asset URLs.
- 20 MiB/PDF, 500 MiB/user, 2,000 records/user. PDF signatures checked; no antivirus/parser validation is implied.
- PDF.js canvas reader with page/zoom state, text extraction and normalized approximate region mapping.
- Tesseract English page OCR is local-browser, cancellable and limited to 120 seconds / 2 million raster pixels. Worker/core/model assets are bundled on the same Site, not a third-party OCR service.
- Extracted/OCR text is editable and persisted for up to 200 pages per PDF version, with a 50 MiB per-user extracted-text cap.
- This is not DocLayout parity: multi-column order, tables, equations and non-English text require review.
- JSON import/export excludes PDF bytes; BibTeX export is metadata only.
- Private Site MCP: search_library, read_paper_notes and read_paper_page, per-user read-only. Page tool reads saved extraction/OCR; it does not generate OCR or AI itself. `read_attached_pdf`, `prepare_attachment_task` and `render_attached_reader` read a ChatGPT-attached PDF without storing anything (the default); `import_paper_pdf` and `extract_paper_pages` save it and its text layer only on an explicit request (below).
- Core AI translation, summary, anatomy, Q&A and equation vision are not complete: inference-runtime authorization is pending. See CORE_PARITY.md. No fake model output is generated.
- No Zotero synchronization, citation-word-processor plugin or automatic metadata enrichment.

Run npm run db:generate for schema changes. Use supplied Sites build and publication helpers.

## ChatGPT plugin workflow

1. Ask Sundark to search/list the desired paper and available source pages.
2. `read_paper_source` retrieves only selected pages with a source hash and stable segment IDs.
3. ChatGPT generates the requested translation, summary, anatomy, explanation or Q&A. No server inference API or separate model key is used.
4. `save_paper_analysis` appends the result with source hash, language, page scope and plugin provenance. Translation requires every source segment; evidence quotes are validated. Identical retries are idempotent.
5. The Site reader displays saved translations and analysis; changed source marks old results stale. Results paginate rather than silently hiding old pages.

## PDF attached in ChatGPT: read without saving (default)

Reading or translating an attachment stores nothing. `read_attached_pdf`, `prepare_attachment_task`,
`render_attached_reader` and the empty-argument launcher `open_attachment_reader` (thread entrypoint,
`_meta["openai/ui"].entrypoints=[{type:"thread"}]`) never touch D1 or R2: no paper row, page row,
outcome row, R2 object, cache or temporary copy, on success, error, retry or concurrent calls
(`tests/attachment.test.mjs` runs every path against an env whose DB and BUCKET throw). They are
annotated read-only and open-world (they fetch the attachment). The MCP `initialize` result carries
standard `instructions`: a PDF attached with a mention of Sundark (@Sundark) and no other request goes
straight to `read_attached_pdf` (page 1, translation), without asking what to do and without saving.
`open_pdf_file` is the app-only PDF file entrypoint (`_meta.ui.visibility=["app"]`,
`_meta["openai/ui"].entrypoints=[{type:"file",extensions:[".pdf"]}]`): ChatGPT injects
`file:{name,resourceUri}`, the reader view reads that resource through the host, and the server
downloads nothing and does not echo the resource URI.

- Each call downloads the attachment into that request's memory under the same policy as the import
  below (https, exact configured hosts, no redirects/credentials/IPs/ports, 20 s, 20 MiB), extracts
  only the requested pages (at most 8, default page 1, 15 s budget) with the same pdf.js rules, and
  drops the bytes. Nothing is kept between calls and there is no per-user cache in Worker globals.
- Output: `{mode:"ephemeral",persistent:false,attachment:{fileId,fileName,pdfSha256,numPages},page,
  sourceHash,pages:[{page,width,height,segments,sourceHash}],translations,nextPages,needsOcrPages,
  failedPages,deferredPages,attemptedPages,unreadPages,complete,reportedComplete,progressBasis,pageLimit,extractablePages,
  translation:{language,instructions,batches:[{page,sourceHash,language,segmentIds}]},storageNotice}` as both model
  text and `structuredContent`, with the reader resource `ui://sundark/attachment-reader.html`
  (`_meta.ui.resourceUri` plus the `openai/outputTemplate` alias), so the first requested page's source
  shows before any translation. The download URL is never echoed, stored or logged.
- `sourceHash` is per page: sha256 over the original file's sha256 and that page's exact geometry and
  segments. `render_attached_reader` downloads and extracts the page again and refuses a hash that does
  not match (`source_changed`), so source text always comes from the PDF, never from arguments.
  Its `translations` must be an ordered prefix of the page's segments (from the first, may stop
  partway) and pass the saved-translation rules (no source fallback, nothing out of order). The server
  is stateless, so render needs the same `language` as the read (it is in every batch and in the
  instructions); without it the check assumes Korean and the error says to pass it.
- Summary, anatomy, Q&A, explanation, equation, glossary and review: `prepare_attachment_task` returns
  up to 8 pages, a task `sourceHash` over their page hashes, the original generation instructions and
  the `save_paper_analysis` content shape; `render_attached_reader` `analysis` re-extracts those pages,
  checks the hash and validates the content with the same validators (exact citation quotes). A
  document-level analysis may be shown beside any page: the result keeps `analysis.sourcePages` and
  adds `coversShownPage`, so the reader labels which pages it covers.
- Whole document: the caller echoes `attemptedPages` and `unreadPages` from each result and calls again
  with `nextPages` until it is empty. Scanned (`needsOcrPages`) and failed pages are visited, so they are
  never offered again, and stay in `unreadPages`; `deferredPages` ran out of time and are offered again,
  even when the caller listed them as attempted. Each call reads its first page whatever the budget, so
  the loop always advances. The echoed lists carry no proof of which PDF they came from, so every
  result says `progressBasis:"caller-reported"`. `reportedComplete` is true when those lists and this
  call cover every page up to `pageLimit` (200) with a text layer; it is unverified. `complete` is true
  only when this call itself read every page of the PDF with a text layer (a PDF of at most 8 pages);
  it means the source text is available, not that it was translated. A longer PDF reports
  `extractablePages` and is never complete when it has more than 200 pages. The reader decides what it has from the pages it holds
  for the same `pdfSha256`. No server state, receipts or signing secret.
- Errors are `Attachment error (<reason>[, host <hostname>]): ...` with reasons `missing`, `malformed`,
  `unsupported_host`, `unsafe_url`, `expired`, `download`, `size`, `not_pdf`, `encrypted`,
  `invalid_pages`, `invalid_arguments`, `invalid_translation`, `invalid_analysis`, `source_changed`,
  `extract_failed`. Only `unsupported_host` names a host: the parsed, validated hostname, never the
  path, query or file id. It is a deployment setting (`SUNDARK_FILE_HOSTS`), so it does not ask the user
  to reattach. `expired` (401/403/404/410) asks for a fresh file reference to the same attachment.
  An `unsupported_host` refusal also writes one error-level Workers log line,
  `{"event":"sundark_attachment_policy","reason":"unsupported_host","host":"<hostname>"}`, so the
  Site owner can read the exact refused host before adding it to `SUNDARK_FILE_HOSTS`. Only the
  validated hostname is logged; other errors log nothing.
- The reader resource's CSP `connectDomains` (and `openai/widgetCSP`) list exactly the hosts the
  server download gate allows; nothing broader.
- ChatGPT's own file retention is outside Sundark. Results live only in the conversation.

## PDF attached in ChatGPT: explicit save

Only when the user explicitly asks to save or keep a PDF in their library. `import_paper_pdf` takes the PDF the user attaches in ChatGPT (`_meta["openai/fileParams"]=["file"]`;
`file` declares `download_url`, `file_id`, `mime_type`, `file_name`, the first two required) and
saves it without any Site visit:

1. Download: https, no redirects, no forwarded cookies or auth, 20 s, 20 MiB checked by header and
   while streaming, `%PDF-` signature, and the file must parse in pdf.js. Only exact hosts are
   allowed: `SUNDARK_FILE_HOSTS` (comma list) or the candidate default `files.oaiusercontent.com`.
   That host is not an official guarantee; the live ChatGPT attachment gate decides. IP literals,
   credentials in the URL, wildcards and non-default ports are refused. The URL and its query are
   never logged or stored.
2. Storage: the exact original bytes go to R2 (sha256 in D1 and R2 metadata), then one conditional
   D1 insert enforces 2,000 papers and 500 MiB per user; a lost race deletes its R2 object.
   `requestId` (UUID) plus a sha256 fingerprint of `file_id` make retries idempotent: a replay
   returns the saved paper without downloading, and the same `requestId` with another file is
   rejected.
3. Extraction: server pdf.js (legacy build, in-thread worker) feeds the browser reader's own
   `pdfTextAtoms` and `buildSentenceSegments`, so segment IDs and geometry match a Site extraction.
   Import extracts pages 1-4; `extract_paper_pages` does up to 8 pages per call and returns
   `extractedPages`, `missingPages`, `nextPages` and `complete`, so ChatGPT finishes the whole PDF
   over repeated calls until `nextPages` is empty. Pages without a text layer come back in
   `needsOcrPages` and are never given invented text; they and `failedPages` are remembered per
   file version (`page_outcomes`), so `nextPages` never offers them again and a replay reports
   them. Password-protected PDFs are kept and reported. Server extraction is insert-only: a page
   the reader saved (OCR or a correction), even mid-extraction, is not overwritten.
   This is text-layer extraction only: no OCR, no DocLayout, no server AI.
4. ChatGPT then runs `prepare_paper_task` -> `save_paper_analysis` -> `render_paper_reader` as above.

`import_paper_text` saves explicitly provided text as a paper, not a PDF. OCR of scanned pages
runs only in the private Site reader.

Local test against workerd (synthetic PDFs only; the fixture origin is honoured only in dev builds):
`SUNDARK_DEV_FILE_ORIGIN=http://127.0.0.1:5199 CLOUDFLARE_INCLUDE_PROCESS_ENV=true npm run dev -- --port 5175 --strictPort`,
apply `drizzle/` to `.wrangler/state` (`wrangler d1 migrations apply DB --local`), then
`python3 -I tests/local-pdf-import.py <dev-log>` and `node --test tests/pdf-import.test.mjs tests/pdf-extract.test.mjs tests/attachment.test.mjs`. The attachment reader has its own workerd run, which starts and stops its own server on a free port:
`python3 -I tests/local-attachment.py dev` (D1/R2 counts unchanged, source binding, finite loops,
resource metadata) and, after `npm run build`, `python3 -I tests/local-attachment.py prod` (the
production bundle ignores `SUNDARK_DEV_FILE_ORIGIN`). The reader view itself is tested in real
Chromium under a fake MCP Apps host (not ChatGPT): `npm run test:browsers:install` once, then
`npm run test:attachment-reader`, which builds the widget first; a missing browser fails it, never
skips it. Node 24 is the test baseline, as in CI. The Node test loader
(`tests/fixtures/worker-loader.mjs`) needs `stripTypeScriptTypes` in transform mode, and it fails
under Node 26, so run the `node --test` suites with Node 24. Original DocLayout, equation-image vision reconstruction, and figure ZIP export are not claimed as implemented.

## Local Sundark companion (optional)

The paper reader has a collapsed "로컬 Sundark로 분석하기" panel. It sends this paper's PDF from the
owner's browser to Sundark running on the owner's own computer, which does layout, summary,
Research Anatomy and page translation with the AI it is set up with (Sign in with ChatGPT,
Claude Code or Hermes). Start it with
`uv run python -m app.mcp_server --http --site-origin <this Site's exact origin>` in the Sundark
checkout and paste the token it prints.

- The browser talks only to `http://127.0.0.1:<port>/mcp` (`lib/local-core.ts`). The companion
  answers only this exact origin, requires the token on every request and offers only upload,
  layout, summary, anatomy and page translation for PDFs uploaded in that run.
- The token stays in the tab's memory: never in storage, cookies, URLs, D1 or the Site server.
  Disconnecting, switching papers or closing the page forgets it. The ChatGPT sign-in never leaves the
  owner's computer.
- Results are shown in the panel only; nothing is written to D1 or R2, and saved plugin results
  are unchanged. Its sentences come from the local layout, so they can differ from the
  extracted text above.
- Chrome asks once for permission to reach apps on this device (Local Network Access); allow it
  for this Site only. Other browsers and other machines are not verified.
