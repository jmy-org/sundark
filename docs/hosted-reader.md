# Hosted reader (ChatGPT Site)

`hosted-reader/` holds the source of the hosted Sundark reader: a public ChatGPT Site with private per-account libraries
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
| Exported Site commit | `aa0d2770912b94d76b17a8718a63eb0844ffae2a` ("Support regional attachment hosts with per-account authentication"; in-band delivery in `1be30a6`) |
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

### Live validation checkpoint (2026-10-26)

All four CI checks passed for the implementation at `95d254d`: 86 unit/contract tests,
30 state/Chromium mock-host tests, and local production/development workerd checks
(26/62 respectively). The exact exported source was deployed to the existing owner-private
Site. These checks do not prove that the ChatGPT host renders the reader.

Native Site logs confirm that ChatGPT negotiates MCP `2026-07-28` with the MCP Apps UI
capability, calls the empty-reader tool successfully, and retrieves both the attachment
reader HTML (2,034,560 bytes) and the small saved-reader HTML (7,302 bytes). Attachment
policy errors also identified two exact regional ChatGPT download hosts; those hosts were
allowed individually, without a wildcard. Other regional hosts remain unverified.

**The real ChatGPT reader remains blocked.** In fresh chats after refreshing metadata,
both readers showed "App failed to open". A temporary, tiny static MCP Apps resource
with no JavaScript, resource metadata, file handling or storage failed the same way.
A DOM observer installed before that call recorded no widget-frame insertion or removal
in the document or reachable shadow roots. Closed shadow roots, other windows and
out-of-document surfaces were not observable, so this does not prove that no frame was
attempted anywhere. The evidence points toward the host or connection stage; it does
not establish a specific platform defect.

The temporary probe was removed and the previous product tree restored exactly. Opt-in
MCP tracing was disabled again. No user papers were saved during these probes. The
remaining live gates are visible original-PDF rendering, ordered translation, page
navigation, grounded Q&A, export/restore and reopen behavior in actual ChatGPT.
Do not describe the workflow as ready until these gates pass; a model response claiming
that it opened the reader is insufficient evidence.

### Widget lookup checkpoint (2026-10-27)

The installed connection's App ID and MCP URL matched the Sites-provisioned Sundark
plugin. A controlled CSP-enforcement-on probe still failed at
`GET https://chatgpt.com/backend-api/ecosystem/widget` with HTTP 404 for the exact
advertised action and template pointer. The native browser tools did not expose the
response body, so there is no underlying error code or explanation to report.

A second probe correlated browser and server evidence in UTC:

| Observation | Time | Result |
| --- | --- | --- |
| Server `tools/call` for the empty reader | 03:06:08.620 | Success |
| Server `resources/read` for the attachment template | 03:06:10.209 | Success, 2,034,560 bytes |
| Browser widget lookup | Approximately 03:06:08–03:06:11 | HTTP 404; no observed widget iframe |

Thus the template was fetched during rendering, not only during metadata refresh.
Adding the documented `ui.domain` and `openai/widgetDomain` fields on a fresh v3 URI
did not resolve the 404; that experimental override was removed. The v3 URI remains
an unadvertised read alias of the restored v2 resource for existing conversations.

The five UI tools now declare a permissive object `outputSchema`, following the
documented structured-output guidance without changing returned data. A 2,243-byte
modern MCP Apps control then used the launcher's authentication, annotations, input,
output, normalized template metadata and CSP, with a tested initialization handshake.
Both the product reader and this control returned the same widget-lookup 404 in
separate fresh chats. This argues against a problem confined to the large PDF bundle;
it does not identify a unique platform cause. The temporary control was removed.

The cleanup source passed the complete local Node contract suite, 30 reader
state/Chromium tests, TypeScript/build checks, and production/development workerd
checks (26/62). These checks still do not establish real ChatGPT usability. Further
diagnosis needs the widget lookup's backend reason or a confirmed provisioning
requirement; changing more template fields without such evidence is not a verified fix.

## Licenses

- `build/sites-vite-plugin.*`: MIT, OpenAI (`build/sites-vite-plugin.LICENSE`).
- `vendor/shadcn-tailwind-4.13.0.css`: MIT, shadcn (`vendor/shadcn-tailwind-4.13.0.LICENSE.md`).
- npm dependencies come from the public registry as pinned in `package-lock.json`. The build
  vendors browser bundles into `public/vendor/` and copies the marked, KaTeX and DOMPurify
  license files with them. `pdf.mjs` keeps its Apache-2.0 header; Tesseract's Apache-2.0
  notice is not shipped with `public/vendor/ocr/` yet, which the Site should fix.
- `public/sundark-original/` adapts this repository's own `web/` files.

### Regional attachment delivery repair (2026-10-27)

The server accepts one DNS label under `oaiusercontent.com`, plus explicitly configured
extra hosts. This namespace boundary is not proof that a URL belongs to an attached file
or the current user. HTTPS, no userinfo/custom ports, no redirects, bounded downloads
and untrusted-PDF handling remain enforced.

The widget obtains original PDF bytes through the authenticated, app-only
`read_attachment_original` tool. Each response carries a bounded chunk only in hidden
`_meta`, with full-file digest checks on the server and again after assembly in the
widget. There is no browser file fetch, new storage or new secret. The v4 resource and
all compatibility aliases declare empty connection and resource domain lists.

Original loading waits for host initialization, fences document switches, bounds each
call and the full load, and suppresses automatic retry after a failed load for the same
file and digest. Local verification passed 110 unit/contract tests, 44 reader
state/browser tests, TypeScript, production build, and 93 development/38 production
attachment checks. These checks do not prove ChatGPT widget mounting or hidden metadata
delivery; actual ChatGPT acceptance remains pending.

A native Chrome check of deployment `1be30a6` at 09:00:42 UTC still returned
widget lookup HTTP 404 for `open_attachment_reader` and the v4 template. No widget
iframe was observed, and no PDF was uploaded in that probe. Original, translation
and hidden-metadata live gates were not run. A standard PDF-tool comparison is
being checked separately; this failure does not establish a unique platform cause.
The subsequent output-schema declaration for the app-only original tool does not
change the launcher or claim to repair that 404.

The final page-read race correction preserves the current translation language and
translated prefix when a previous-language request settles, while retaining new
source pages and read progress. A document switch during fresh URL acquisition is
fenced before invoking the read tool. The two browser regressions pass; the final
reader state/browser suite passes 46/46. Standard `read_attached_pdf` also reproduced
the v4 widget lookup HTTP 404 in native Chrome at 09:08:46 UTC after a synthetic PDF
upload; thus the observed failure is not confined to the launcher. Actual original
canvas, translation, page navigation, export/restore and reopen remain unverified.

### Public audience and account authentication (2026-10-28)

The existing Site is public (native access revision 2). Hosting audience and account
authorization are separate: anonymous `/` and `/original` redirect to the official
Sites Sign in with ChatGPT route, while individual API routes and MCP tool calls
require a verified identity. Existing authenticated browser sessions open the library
without a new login prompt. No custom OAuth, session stack or new secret was added.

Hosted anonymous and forged synthetic identity-header probes returned 307 for the
protected pages and 401 for `/api/papers` and MCP tool calls. Local regressions cover
every exported API handler, every MCP tool and two synthetic accounts with separate
papers, PDF bytes, figures and analyses. They assert refusal before D1/R2 access and
unchanged cross-account state. The full local integration harness passes 115 checks;
its stale saved-reader URI/MIME assertion was corrected to the maintained resource.

A public native Chrome run opened the library through the existing session, but the
attachment reader still failed to open. A synthetic PDF read was refused by the server
for `oaisdmntprwestus2.blob.core.windows.net`, confirmed by a host-only policy log.
The server policy now also accepts the bounded standard Azure Blob account-name
family `oaisdmntpr` plus 1-14 lowercase alphanumeric characters at the exact
`.blob.core.windows.net` suffix. This is observed compatibility, not a reserved prefix,
OpenAI ownership or a file-authorization guarantee. Other Azure customers may own a
matching account; permitted destinations expand, while the content stays untrusted.
The validator does not inspect resolved IP addresses. Credentials are not forwarded,
redirects remain refused, downloads stay bounded, and the widget CSP stays empty.

Regional exact environment entries are redundant under the two reviewed families and
were removed (environment revision 8, applied on deployment). Local tests cover
read/render across the two families, future account labels, malformed/lookalike
endpoints and redirect refusal. Actual post-repair ChatGPT PDF/reader acceptance is
still a separate gate; public audience alone did not establish reader success.
