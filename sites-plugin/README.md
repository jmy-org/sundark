# Sundark Sites / ChatGPT plugin port (draft)

This directory preserves the existing experimental Sites/plugin work for review. It is **not a completed replacement for Sundark**. The repository's original Python app, `web/`, default commands and workflows are unchanged.

## Architecture

- `app/original/` and `public/sundark-original/`: adaptation of the original Sundark browser reader. The adapter connects original reader endpoint shapes to this port's storage. Original files/functions and deliberate differences are recorded in `docs/UPSTREAM_FIDELITY.md`.
- `app/api/papers/`, `lib/papers.ts`, `db/`, `drizzle/`: owner-scoped D1 metadata/extracted text/model artifacts and private R2 PDF/figure storage. Protected file routes, input/size limits, source-version checks and optimistic concurrency are enforced server-side.
- `lib/pdf-engine.ts`, `lib/source-geometry.ts`: browser PDF.js extraction and explicit page-level English Tesseract OCR. These are approximate geometry engines, **not DocLayout-YOLO/PyMuPDF parity**.
- `app/mcp/route.ts`: authenticated search/read/prepare/save tools. ChatGPT generates output in the conversation and saves it with source hashes and model/provenance fields. No API key, background paid inference, local CLI process or user subscription token is configured.
- `lib/upstream-contract.ts`, `lib/analysis.ts`, `lib/review.ts`: original-derived translation/glossary/Anatomy/review contracts, exact segment ordering, validation and referenced-figure review ZIP.
- `lib/reader-resource.ts`: experimental embedded comparison resource. It currently contains text comparison only, **not the original PDF reader or PDF upload**.

## What works and what remains

The Site has metadata, collections/tags, notes, page/zoom persistence, PDF upload/reading, editable extraction, bounded page OCR, saved-result comparison and model-output storage. The original-derived reader retains paragraph batches, contiguous painting, source highlighting and document-switch/race protections. Its NDJSON adapter replays saved results; it does not implement live token generation.

The plugin tools were exercised with synthetic source → ChatGPT translation → save → read. However, embedded UI is **not verified working**: both standard MCP Apps and legacy Apps SDK resource formats returned successfully, while widget delivery returned `widget unavailable`. The latest compatibility probe is retained, not presented as a fix. PDF selection/upload and the original reader inside the plugin remain unimplemented. Production authenticated visual QA is incomplete.

Missing parity also includes learned semantic region detection, exact word boxes, cross-page sentence stitching, automatic formula localization/vision reconstruction and automatic original AI scheduling. Zotero account/library integration is not implemented. Do not treat the alternative extraction engine as a silent fallback for the original required layout model.

## Setup

Use Node 24 and run commands from this directory, independently of the root pnpm tooling:

```sh
npm run install:ci
npx tsc --noEmit
npm run build
node --test tests/upstream-contract.test.mjs tests/original-adapter.test.mjs tests/original-reader-races.mjs
node tests/pdf-ocr-geometry.mjs
```

`prebuild` copies pinned PDF.js/Tesseract assets from npm packages into ignored `public/vendor/`. They are served from the same origin rather than a remote OCR service. The optional real OCR smoke test is `node tests/pdf-ocr-smoke.mjs`; it requires the platform-compatible `@napi-rs/canvas` optional dependency. It is a Node/model test, not browser QA.

For a Sites deployment, use the normal Sites project setup/publish workflow to assign a new project ID, provision D1 binding `DB`, R2 binding `BUCKET`, and apply all `drizzle/*.sql` migrations in order. The checked-in hosting manifest intentionally has no private project ID. Set the public, non-secret `SUNDARK_SITE_URL` to that deployment's HTTPS origin for MCP reader links (otherwise links explicitly point to `https://example.invalid`). No production deployment is performed by this PR.

For local development, `npm run dev` uses the supplied portable Sites development adapter and synthetic local identity. Never expose that development server to an untrusted network. Production requires the Sites authentication gateway to overwrite trusted `oai-authenticated-user-*` headers; do not deploy the handler directly to the public Internet without that gateway.

`tests/integration.py` is an HTTP integration suite for an isolated local worker fixture on `127.0.0.1:8787`, with schema migrations applied. It intentionally supplies synthetic gateway headers; never point it at production. `tests/local-integration.py` targets the separate local browser-auth fixture on port 5175. Their fixture setup is not an automatic production-auth test. Historical integration results and current export checks are separated below.

## Verification

Export checks on 2026-10-23: TypeScript check, production build, 14 Node contract/adapter/race tests, geometry assertions and real English OCR smoke test passed. The OCR fixture is generated in memory and contains no user data.

Before this export, the deployed implementation passed 114 local HTTP integration checks and synthetic production MCP read/save/read checks. Those are historical checks, not a claim that this export has completed production browser or plugin UI QA. The original repository's full Python/browser suite is left to its existing CI; no full original-suite local pass is claimed.

No uploaded PDFs, personal library rows, DB/R2 contents, credentials, deployment IDs, personal Site address, runtime state or generated build artifacts are included. Upstream source attribution and bundled dependency licenses are preserved. No license grant is inferred from the upstream repository's public visibility.
