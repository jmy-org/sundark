# Hosted reader (ChatGPT Site)

`hosted-reader/` holds the source of the hosted Sundark reader: a private ChatGPT Site
(vinext/Next.js on Cloudflare Workers) that reads a PDF in ChatGPT and in the browser. It is
a separate TypeScript project. It shares no code or runtime with the local Python reader in
`app/` and `web/`; `hosted-reader/public/sundark-original/` adapts this repository's `web/`
files, and each of those files records its provenance.

## Source and provenance

The authoritative source is the Site's own git checkout, the one that publishes to the Site
named by `hosted-reader/.openai/hosting.json` (`project_id`). Nothing under `hosted-reader/`
is edited in this repository: a change is made and reviewed in the Site checkout, committed
there, and exported here.

| Field | Value |
| --- | --- |
| Exported Site commit | `7c2b57055205bd974e6f2f2aab25745f25f1b8e5` ("Add a transient ChatGPT PDF reader") |
| Export method | `git archive` of that commit; working-tree changes are never copied |
| Excluded | `tsconfig.tsbuildinfo` (tsc output, ignored here instead), `examples/` (template sample, excluded by `tsconfig.json` and unused) |

Everything else in the commit is exported unchanged: the app, the five maintained
`build/` files (Vite plugins, workers and the plugin license), the vendored shadcn CSS with its license, `drizzle/`
migrations, `.openai/hosting.json`, `package-lock.json`, scripts and tests. Ignored local
state (`node_modules/`, `public/vendor/`, `dist/`, `.wrangler/`, `.sites-runtime/`) is not in
the Site commit, so it is not exported; `hosted-reader/.gitignore` keeps it out here too.

`.openai/hosting.json` carries only the Site's identity and binding names (`DB`, `BUCKET`),
no credentials, so a publication from this source updates the existing Site rather than
creating a new one.

### Updating the export

From the repository root, with `SITE` the Site checkout and `SHA` its reviewed commit:

```bash
git rm -r -q hosted-reader && mkdir -p hosted-reader
git -C "$SITE" archive "$SHA" -- . ':(exclude)tsconfig.tsbuildinfo' ':(exclude)examples' \
  | tar -x -C hosted-reader
git add hosted-reader
```

`git rm` first, so files deleted at the Site are deleted here. Then record the new commit in
the table above. Check that the staged export is exact; no output means every path, mode and
byte matches the Site commit:

```bash
diff <(git -C "$SITE" ls-tree -r "$SHA" | grep -vE $'\t(tsconfig\\.tsbuildinfo|examples/)') \
     <(git ls-tree -r "$(git write-tree --prefix=hosted-reader/)")
```

## Build, test and deploy

Node 24 (`engines` allows 22.13+) and npm with the committed `package-lock.json`:

```bash
cd hosted-reader
npm ci
npx --no-install playwright install chromium  # the Chromium pinned by the locked playwright
npm run build                 # prebuild vendors pdf.js, Tesseract, KaTeX, marked, DOMPurify,
                              # and builds the attachment reader widget (lib/generated/)
npx tsc --noEmit -p .          # requires the generated widget module from the build
node --test tests/*.test.mjs  # CHROME=<path> runs the Markdown browser test; it skips without Chrome
for t in tests/original-reader-*.mjs tests/pdf-ocr-geometry.mjs; do node "$t"; done
npm run test:attachment-reader              # state tests and real Chromium under a fake MCP Apps host
python3 -I tests/local-attachment.py prod     # wrangler dev --local on the built dist/ (workerd)
python3 -I tests/local-attachment.py dev      # vinext dev (workerd); D1 and R2 stay unchanged
```

`.github/workflows/hosted-reader.yml` runs these steps for changes under `hosted-reader/`, and
installs Chromium with its system libraries (`--with-deps`). The attachment reader test fails
if Playwright is missing, locally and in CI. The two `local-attachment.py` runs use synthetic PDFs, synthetic
identities and a 127.0.0.1 fixture file host; each starts and stops its own server. `prod` runs
first because it needs `dist/` from the build; `dev` applies `drizzle/` to `.wrangler/state` and
seeds one synthetic paper through the legacy import before it checks the attachment tools. CI
does not run:

- `npm run lint`: the exported commit has existing ESLint errors in `lib/` and `app/`; they
  are fixed at the Site, then the lint step can be added.
- `tests/integration.py`, `tests/local-integration.py`, `tests/local-pdf-import.py`: they
  drive a local workerd dev server with synthetic identities (see `hosted-reader/README.md`)
  for the library and the explicit save, not the attachment reader.
  These standalone stdlib scripts are excluded from the root Ruff checks
  (`[tool.ruff] extend-exclude` in `pyproject.toml`) rather than reformatted here, which would
  break the exact export.
- `tests/pdf-ocr-smoke.mjs`: it needs `@napi-rs/canvas`, which is not a dependency.

Deployment is not done from this repository or its CI. The Site is published with the Sites
build and publication helpers from the Site checkout, to the existing project identity.

## Storage and AI policy

The hosted reader runs no server-side AI and holds no API key: ChatGPT does the model work
through the Site's MCP tools, and the Site only reads source pages and validates what ChatGPT
returns, storing it only for a paper saved in the library. Identity is ChatGPT-managed.

A PDF attached in ChatGPT is read **without any Site storage by default**.
`read_attached_pdf`, `prepare_attachment_task`, `render_attached_reader` and the launcher
`open_attachment_reader` never touch D1 or R2 (`open_pdf_file` hands the widget a host file
resource and downloads nothing): no paper, page or result row,
no R2 object, cache or temporary copy, on success, error or retry. Each call downloads the
attachment into that request's memory, extracts only the requested pages and drops the bytes;
nothing is kept between calls. `tests/attachment.test.mjs` runs these paths against bindings that
throw on any `DB` or `BUCKET` access, and `tests/local-attachment.py dev` checks that the D1 row
counts and R2 objects are unchanged in workerd.

What the reader shows lives in the ChatGPT conversation and the widget:

- The extracted pages, translations and analysis are tool results in the conversation and data
  the widget holds in memory while it is open. They are not stored by the Site. ChatGPT's own
  conversation and file retention is outside Sundark.
- The widget saves only a small `widgetState` in the host: the current page, the selected
  segment id (at most 80 characters) and the attachment's file id and PDF sha256, so the view
  reopens at the same place. No source text, translation or analysis goes into it.
- **Export and restore** are explicit and local: "export" hands a Markdown or JSON file of the
  current results to the host's file download, and "restore" reads such a JSON file back into
  the widget. An export is a file the user keeps; it is not server persistence and writes
  nothing to D1 or R2.
- **Save** is the legacy library path, only on an explicit request: the widget's save button
  asks for confirmation, then asks ChatGPT to save the PDF to the Sundark library, and
  `import_paper_pdf` stores the PDF bytes in R2 and its metadata and extracted text in D1
  (owner-scoped, with per-user caps). The library tools (`search_library`, `read_paper_page`,
  `save_paper_analysis` and the rest) keep working on what is saved there.

These properties are tested locally and in CI with synthetic data. They still need these live
gates, which no local test covers:

- ChatGPT file attachment reaches the Site (the attachment download host,
  `files.oaiusercontent.com` by default, `SUNDARK_FILE_HOSTS` otherwise, is a candidate, not a
  confirmed one).
- The MCP Apps reader widget renders in the ChatGPT host.
- An authenticated end-to-end run in the published Site.

## Licenses

- `build/sites-vite-plugin.*`: MIT, OpenAI (`build/sites-vite-plugin.LICENSE`).
- `vendor/shadcn-tailwind-4.13.0.css`: MIT, shadcn (`vendor/shadcn-tailwind-4.13.0.LICENSE.md`).
- npm dependencies come from the public registry as pinned in `package-lock.json`. The build
  vendors browser bundles into `public/vendor/` and copies the marked, KaTeX and DOMPurify
  license files with them. `pdf.mjs` keeps its Apache-2.0 header; Tesseract's Apache-2.0
  notice is not shipped with `public/vendor/ocr/` yet, which the Site should fix.
- `public/sundark-original/` adapts this repository's own `web/` files.
