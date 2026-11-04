# AGENTS.md — rules for anyone (human or AI) changing this repo

Read this before editing. It captures the non-obvious decisions that keep this
project working. Keep changes surgical and in the existing style.

## What this is

A personal, local web app that reads conference/journal PDFs and provides
whole-document translation, a grounded "Research Anatomy", an auto summary, and
paper-aware Q&A chat. It runs through the user's own subscription in the chosen AI
Backend (Claude Code, Hermes, or ChatGPT) — never a billable API key.

## Architecture and boundaries

- **Only `app/backends/` starts AI processes**; `app/ai.py` owns every prompt. See
  *AI Backends* below.
- **Paper ID vs File Fingerprint (ADR 0001).** `doc_id` is the File Fingerprint and keys every
  cache derived from the file (layout, translation, summary, anatomy, equations). The Paper ID
  (`app/paper_id.py`: `doi:`, `arxiv:`, `zotero:`, or `file:<doc_id>`) keys Chat History and
  the translation glossary. `app/biblio.py` fetches the Bibliographic Record and rejects a
  DOI whose record title is not on the first page (a cited work's DOI). Zotero integration
  calls `main._ingest(data, {"key": ..., "doi": ...})`; Zotero's DOI wins. A record title is
  shown through `biblio.plain_title` (arXiv titles carry TeX, "$\alpha_1$-Net", CrossRef
  titles HTML tags). Before a paper is opened, the library title is `pdf_utils.title_of`:
  page 0's largest lines, a line sized by the size most of its characters use (a larger
  math symbol in the first line once left out the second).
- **Zotero is read-only, through Zotero's local API** (`app/zotero.py`, port 23119, personal
  library only). `/api/zotero/open` reads the PDF in place and calls
  `_ingest(data, {"key": item, "doi": zotero_doi})`. Never copy Zotero PDFs into `papers/` and
  never write to Zotero from here; writing (e.g. chat to a Zotero note) needs the web API.
- **Removing a paper from the folder Library moves its PDF to `data/trash/`**
  (`/api/papers/remove`, same relative path, a number added on a name clash). Nothing else
  is deleted: caches are keyed by the File Fingerprint and chat by the Paper ID, so they
  come back if the same PDF is added again. Only paths inside `PAPERS_DIR` are accepted; a
  symlink is moved itself, never its target (another entry, or a file outside the library).
  Zotero items have no remove action.
- **`app/pdf_utils.py`** turns a PDF page into word geometry + sentences:
  `get_text("rawdict")` for per-word position/size, margin filtering, region drop/
  heading/equation typing from the layout model's boxes (no font/stroke heuristics —
  see `layout_model.py`), paragraph reconstruction, and sentence splitting via
  **spaCy** (pysbd then regex as fallbacks). Keep it **format-agnostic** — it must
  work across many paper layouts, so do not add rules that fit one paper. Validate
  changes against several papers, not one (the `eval/` harness scores section-title
  recall against arXiv `.tex` ground truth).
- **`app/layout_model.py`** is the REQUIRED region detector (DocLayout-YOLO), a base
  dependency. It types each page's regions (title/body/figure/table/formula/
  furniture) from a rendered image, and `pdf_utils` trusts those boxes alone: a line
  is a heading only inside a `title` box, a display-equation line only inside a
  `formula` box, and a line is dropped only when its first word is inside a
  `figure`/`table` box (a `body`/`title`/`caption` box overrides an
  overlapping drop box, so a table that bleeds into the next column does not eat
  it). A `furniture` box drops only running heads, page numbers and sideways stamps
  (see *Running headers*). There is NO heuristic fallback:
  region typing came in two flavours before and the font/stroke heuristics overfit a
  single paper's layout (a full-width false-positive band once swallowed a whole
  column of body text and a section heading), so they were removed. The model is
  loaded at startup; if it can't load, startup FAILS with a clear message (see
  `app/main.py`) instead of serving a degraded parser. The text and word coordinates
  still come from PyMuPDF, so **highlighting is unchanged** — the model only says
  WHAT each area is, never replaces the text layer. Install gotcha: torch and
  torchvision must come from the SAME index (mixing a CPU torch with a default
  torchvision fails at import with `torchvision::nms does not exist`).
- **`app/main.py`** is FastAPI: upload/library, `/api/layout`, streaming
  translation, summarize, anatomy, chat. **`web/`** is plain JS + pdf.js + KaTeX,
  no build step. Highlighting maps server word coordinates (PDF points) to the
  viewport, so highlights are sentence-accurate.
- **`web/reader-ui.css`** is the ONE source of the reader presentation (tokens, buttons, bars,
  tabs, PDF frame, highlight, translation, cards, composer) shared by this reader, the hosted
  `/original` page, the ChatGPT attachment reader and its saved-paper view. `web/styles.css` keeps
  only this reader's layout and local-only components. The Site holds a generated, hash-headed copy
  (`client/shared/reader-ui.css`, written by `scripts/sync_reader_ui.py --site <checkout>`) and
  refuses one that was edited; `tests/test_reader_ui_parity.py` fails when the exported copy in
  `hosted-reader/` differs from the source by a byte. No URL, font or `@import` in it: the widget
  inlines it under an empty CSP. This reader is dark only; the light values in it are derived for
  the widget (opt-in by `data-theme`/`data-theme-auto`), not extracted from here.
- **`app/store.py`** persists uploads + cached AI results under `data/`.
- **`hosted-reader/`** is the hosted ChatGPT Site's source, a byte-exact `git archive` export
  of a Site commit (`docs/hosted-reader.md`). Never edit it here: change the Site, then
  re-export. Root Ruff skips it; `.github/workflows/hosted-reader.yml` builds and tests it.

## Security (do not weaken)

- Never hardcode an API key, token, or password anywhere — including tests and
  comments. This app needs no API key; it uses subscription CLI or ChatGPT OAuth access.
- PDF text is **untrusted input**. It is framed as data in prompts and the CLI is
  run with tools disabled (`--allowed-tools ""`). Keep both. Pass text on stdin,
  never interpolated into a shell command.

## Conventions

- Python: **uv** + **ruff**, `line-length = 88` (team standard). CI runs
  `ruff format --check .` and `ruff check .`. Run `uvx ruff format .` before you
  commit; keep `uvx ruff check .` clean.
- Do **not** commit `data/` or `papers/` (gitignored: uploaded PDFs + cache).
- Commit messages: imperative, subject under 72 chars, no emoji. Co-author
  trailer: `Co-authored-by: Claude Code <noreply@anthropic.com>`.

## Run it

```bash
uv sync
uv run uvicorn app.main:app --host 127.0.0.1 --port 8743
```

Requires Claude Code (`claude`, signed in), Hermes (`hermes setup`), or ChatGPT login. Pick one in the
**AI** badge; `SUNDARK_BACKEND=claude|hermes|chatgpt` overrides it for one run.

## AI Backends

- `app/ai.py` builds every prompt and picks the Model for each Task from `app/settings.py`.
  Nothing outside `app/backends/` starts an AI process.
- Requests that carry PDF text or images run with every agent tool disabled (ADR 0002).
  Equation images go inline in the message; never enable a file-read tool for them.
- Never read or pass an API key. The Claude Code env drops `ANTHROPIC_API_KEY`; Hermes keeps the
  user's Provider untouched.
- Errors shown to users come from `app/errors.py`; never put stderr or provider bodies in them.

### Adding an AI Backend (OpenClaw is next)

1. Add `app/backends/<name>.py` exposing `NAME`, `LABEL`, `MODEL_SUGGESTIONS`, `installed()`,
   `describe()`, `async run(prompt, *, model, system=None, images=())`, and
   `stream(prompt, *, model, system=None)`.
2. Disable every tool in that transport and send images inline.
3. Map its errors with `app.errors.from_text` so rate limits become `RateLimitError`.
4. Register it in `app/backends/__init__.py` and add its name and default Models to
   `app/settings.py` (`BACKEND_NAMES`, `DEFAULT_MODELS`).
5. Add `tests/test_backend_<name>.py` mirroring `tests/test_backend_hermes.py`.

## Behavior notes (so you don't "fix" them by mistake)

- **Translation is paragraph-parallel but displays STRICTLY in order.** The unit of work
  is a **paragraph batch**, not a page: `paragraphBatches()` groups a page's sentence-
  segments by paragraph (coalescing tiny ones to a minimum size so a lone heading does not
  cost its own call). `translateAll()` (in `web/app.js`) runs a producer that walks pages
  in order — laying each out, building its empty DOM (`preparePage`), and enqueuing its
  batches — while a pool of `trPool()` workers (the AI Backend's concurrency setting, default 8) translates batches concurrently,
  so even a single page keeps the pool busy. Display is gated by a sentence-level frontier:
  every result lands in a per-page buffer (`P.trBuf`), and `paintFrontier()` paints only the
  contiguous run of already-buffered sentences from `S.frontier`/`P.frontK`, stopping at the
  first gap — so a later paragraph that finishes first stays buffered and no sentence ever
  appears before an earlier one. Alignment is by ARRIVAL ORDER, not by the number the model
  prints: `ai.translate_stream` yields one translation per segment strictly in order and raises
  `AIError` if the model drifts (an out-of-order index, or too many/too few lines — a merged or
  renumbered line would otherwise shift every later segment), and the server numbers results by
  arrival (`{"i": len(collected)}`). A drifted stream therefore errors instead of being shown or
  cached. A list item's or an algorithm step's own marker ("3:", "2.", "(a)") is put back when
  the model drops it as if it were the prompt's numbering (`ai._keep_marker`). A failed
  batch falls back to the source text for its range so it cannot stall the frontier.
  Every AI call is bounded by a per-backend semaphore in `app/ai.py`
  sized by the same concurrency setting, which also covers summary/anatomy. A rate limit
  (`RateLimitError`, HTTP 429, or a stream line with `rate_limited`) stops the remaining
  batches and leaves source text; the user lowers concurrency in Settings if it repeats. The server stays generic (it
  translates whatever segment list it is given and caches by a signature of those segments,
  so each batch caches independently). On open, the loader reveals the UI as soon as the
  FIRST translated sentence is painted (`S.onFirstPaint`) and a few pages of layout are
  buffered (`waitLayout`) — it does not wait for the whole first page or the whole document;
  translation and layout prewarm keep running in the background after the reveal.
- **Each Task has its own model** (`DEFAULT_MODELS` in `app/settings.py`). Claude Code uses
  `sonnet` for every task (it follows the per-segment translation contract far more reliably
  than haiku). Hermes uses `gpt-6-luna` for translation, equations, and the glossary, and
  `gpt-6.1-sol` for the rest. ChatGPT uses the same task defaults, with account-specific
  choices fetched after login. NOTE: the bare `haiku` alias in the Claude CLI still resolves to
  Haiku 4.5, so if you ever set a Haiku model use the explicit `claude-haiku-5-5` id.
- **A per-paper translation glossary ("brief") is injected into every page.**
  `translate_brief()` reads just the front matter (`brief_source()`: title +
  abstract + intro) on the glossary Task's fast model and returns the paper's field,
  defined abbreviations, and key terms with a preferred target-language rendering.
  It is generated once on the first page's translation, cached as `brief_<lang>`,
  and prepended (as reference, not content) to each page so terminology stays
  consistent across pages. Translation itself stays on the user's chosen model.
  Keep the brief model cheap and the source short — it must not slow translation.
  A rendering is the term as the paper's field writes it in the target language, often
  the English term itself; a coined literal translation leaked into both the translation
  and the review note.
- **Translation keeps one register.** Each batch is its own request, so without a rule a
  paper came out half '~다', half '~습니다'. `ai._register()` fixes it per target language
  (Korean: academic '~다'; headings and caption labels stay noun phrases). A prompt change
  that alters what a cached result should look like bumps that task in `ai._PROMPT_REV`,
  which goes into `cache_tag()`, so results written under the old prompt are not reused.
- **The review note is a memo.** One register ('~함/~임', noun phrases), field terms as
  the field writes them (no example words in the prompt: papers come from any field), one
  value per table cell, every symbol in `\(...\)`, display math outside lists, and no
  "(채팅에서)"-style source tags. `ai._undouble_tex()` repairs LaTeX the model escaped twice
  inside its JSON ("\\(O_t\\)"). Its job is recall: from the note alone, months later, the
  reader recalls why the paper exists and how it solves the problem. So it keeps only that,
  the headline evidence and the limits that really matter, and leaves out what the field
  already knows, hyperparameters, side experiments and related-work lists (a note of 8.6k
  characters became about 5k). Six sections and no others (세 줄 요약, 배경과 문제, 핵심 기여,
  방법, 실험 결과, 한계와 의문); what came up in the chat is woven into the explanation it
  helps (often the method) instead of a section of its own. It makes good use of the paper's
  figures (the problem or idea at a glance, the overview, a key component, the main effect)
  and shows a table only when it is the clearest evidence. Counts are not capped (a paper
  has as many contributions as it has, and a cap made the model pack several points into
  one line), except 한계와 의문 at three; length is set by "a few minutes to read, a line
  only if the reader would miss it".
- **Display equations are re-read from the image.** The PDF text layer scrambles 2D
  math, so `/api/math` crops each equation region (`pdf_utils.crop_region_png`) and
  a vision call (`ai.equation_latex`) transcribes it to clean LaTeX; the translation
  panel then swaps the scrambled text for `\[ ... \]`. The PNG goes inline in the
  message with every tool disabled (ADR 0002) — never enable a file-read tool for it.
  Cached per page/backend/model; best-effort (keeps the original text on
  failure). A line is a display-equation line only when its center is inside a model
  `formula` box; consecutive such lines (one box spans the whole equation) group into
  one segment, which gives a whole-equation crop.
- Results are cached per paper/model under `data/`, so reopening is instant. The
  layout cache key carries `_LAYOUT_VERSION` (in `main.py`) — bump it when `layout()`
  changes what it emits, and old cached pages are bypassed instead of silently
  reused. Translation caches on a signature of the exact segments, so it follows a
  layout change automatically. Wipe `data/` only when you want a clean rebuild.
- **When in doubt, translate.** Text translated that need not be costs little; text left
  untranslated is lost to the reader. Every drop rule below is narrowed to what is surely
  not content, and was checked against the PDF text of 31 papers (every word that reaches
  no sentence, by reason).
- **Running headers/footers are dropped.** `running_headers()` finds lines that
  repeat at the top/bottom across pages (title, venue, 'A PREPRINT', author names)
  and `layout()` removes them, so they are not translated. The threshold is a
  third of the sampled pages, because headers often alternate between even/odd
  pages — do not raise it back to a half. Lines match by their letters only
  (`_norm_header`): the page number moves ("1:2 • Lee et al." vs "1:4" and "• Lee et al."
  as two lines). A repeated line goes in the top 12% / bottom 10% of the page (where
  it is also counted) or inside a model `furniture` box. Not by height alone: the
  model's furniture ("abandon") class also holds footnotes and now and then a heading it
  mistook ("D. Combining the Two Training Losses"), so a furniture box drops only
  repeated lines, bare page numbers ("12", "1:4", "xii", a lone symbol) and text set
  sideways (the arXiv stamp along the first page's edge). A line under both a furniture
  box and a text box: a title or caption box wins, and a body box wins only when it is at
  least as confident. The model may add a weak second guess for one region, and a footnote
  it also called body text (0.33 against 0.71) was read into the middle of the abstract.
- **Footnotes and figure/table captions come after the page's text.** Footnotes (the rest
  of a furniture box) and captions are *asides*: their paragraphs are built apart and
  placed at the end of the page, captions first, flagged `aside`. A caption is a model
  `figure_caption`/`table_caption` box, taken as its whole PDF block (a box over the first
  line only split one paper's captions), or a caption rescued from a table box (below); an
  equation number such as "(5.7)" is a model caption too (`formula_caption`) and stays in
  place, or lead-ins lose it and adjacent equations merge. In reading order an aside sits
  between the halves of a sentence that runs from the foot of one column to the top of the
  next: a footnote split it, and a caption label stuck to it ("... the
  galaxy auto- Fig. 20."); placing them after the text made 75 sentences whole over 31
  papers. Captions never join footnotes, and a line opening with a caption label starts a
  new caption. Asides also hid the page's real last sentence from cross-page stitching, so
  `_tail_idx` skips them.
- **Figure- and table-internal text is dropped.** A PDF line is dropped when the center
  of its first word is inside a model `figure`/`table` box. There are no
  stroke/font-size heuristics any more (they overfit one paper). A
  `body`/`title`/`caption` box overrides an overlapping drop box, so a table/figure
  that bleeds into the adjacent column does not eat its neighbour's prose; captions (a
  `caption` box) stay translatable. Deciding by the first word means a box that covers
  only PART of a line takes all of it or none of it, so a box edge over a caption or
  footnote never leaves half a sentence ("Here the [results are on the COCO ...]"). A
  caption the box swallowed without a `caption` box is kept: a PDF block whose first line,
  or a line, opens with a caption label ("Table 5.", "TABLE V:", "Fig. 2", `_CAPTION_LABEL`).
- **Sentences that wrap across a page break are stitched whole.** `layout()` keeps
  such a sentence on the page where it STARTS: that page absorbs the next page's
  continuation fragment and records its geometry under `words_next` for cross-page
  highlighting; the next page drops that fragment (the browser maps those words back
  to the owning sentence, so hovering them highlights it on both pages). Both pages
  decide with the same rule (`_stitch_idx`), so they agree. The continuation is the
  first lowercase-starting sentence that opens its paragraph; sentences inside a
  model `caption` box are skipped and do not count toward the scan limit. A tail
  ending in a hyphenated word ("fea-" | "tures") is rejoined, and a tail left open on
  ")" or an acronym is stitched when the next page's first prose sentence starts with
  an author-year citation ("...(FiGS)" | "Lee et al. (2018) as well as ...").
  Known limit: when the real continuation starts uppercase ("the 34-layer" | "Network
  reduces ..."), the rule can pick a later lowercase paragraph instead.
  `_page_layout()` is the per-page core; `layout()` is the stitching wrapper that also
  peeks at the neighbours.
- **Over-split sentences are rejoined; list items are split.** spaCy breaks sentences
  mid-way: at an inline math operator ("...z" | "= (z_1, ..., z_n)"), a citation
  ("...(CNNs)" | "Kim et al. (2015) ...", "earlier nets" | "[41] but"), a capital
  math symbol ("... σ 2" | "I is ..."), a parenthesis, closing punctuation
  (", Lee proved"), a line-broken compound ("BENCH-" | "Long"), a spaced
  abbreviation ("et al ."), or inside a PDF word ("( 2020 );", which then belonged to
  two sentences and was highlighted with both), or right after a standalone math operator
  ("w_i / ∑" | "Nc j =1 ..."). `_mend_word_splits` and
  `_merge_fragments` rejoin those; the punctuation- and symbol-led rules apply only
  while the running text is not a finished sentence (`_ends_sentence`, which also
  accepts curly quotes, footnote marks and a spaced ". )"), so two real sentences are
  not merged. A spaced ellipsis from TeX's \dots ("{ x 1 , . . . , x n }") ends with a
  period, so it needs its own rule (`_continues_ellipsis`): the text goes on when the next
  fragment opens with punctuation, a closing bracket or quote, or an operator, and starts
  anew after a page number (a table of contents' dot leader) or a capitalized word. Over 36
  papers this rejoined 89 cuts in 12 of them. A one-letter symbol after a range with no
  period of its own goes on ("k = 1 . . ." + "K do"; not "A" or "I", which open sentences):
  3 more cuts in 2 of 138 documents, nothing else. Enumeration runs ("a) ... b) ... c)",
  "(1) ..., (2) ...") are split into items by `_split_on_markers`; "Eqn.(1)" references and
  two-part subfigure phrases ("show (a) X and (b) Y") are left whole. A list item or an
  algorithm step that opens a line starts a sentence (`_item_starts`): "1.", "(1)", "a)", a
  bullet, or a line number "12:", when the line before ends with a colon or, for a number,
  another line of the page opens with the next or previous number of the same kind. Without
  that a lead-in absorbed the first item ("... as follows: 1. ..."), and steps with no
  period of their own ran together ("1: repeat 2: sample ..."). A letter is no evidence
  ("(b)" also opens a line as a panel reference), and neither is a marker after
  "Eq."/"Table"/"Figure" or after a word broken at the line's end ("top-" + "5."), a "3)"
  that closes an open parenthesis, an equation number the text goes on from ("(3) and (4)
  gives"), or a marker alone on its line ("(5)" is as often an equation number), except a
  line number, which PDFs set apart from its step. Such items are kept however short ("5:
  end for"), but not a bare marker, and so are the short pieces they cut a paragraph into (a
  lead-in "We consider:", a step "repeat"): read whole, the paragraph was one sentence long
  enough to keep, and cut, `_keep_sentence` dropped its lead-in as a label ("We consider:" +
  "1. Speed" + "2. Memory"). Over 89 papers this split 175 list items and 133 steps (8
  papers' algorithms) with no word lost, shared or stitched differently, and over 22 papers
  kept out of the tuning 21 items and 26 steps, all of them right. The neighbouring number
  may sit anywhere on the page: asking for it in the same paragraph, or in the same column,
  lost right splits (an algorithm's comment line starts a paragraph of its own) and fixed
  none, so a wrapped "3." on a page with a list of "2." and "4." would still split. A list
  counts up, though: a number no higher than an item before it in its paragraph is no item
  ("3. If not converged, go to step" + "2. Otherwise ..." refers back). Pseudo-code with no
  line numbers is split by row (`_pseudo_starts`) once the paragraph shows it is
  pseudo-code: a row that only closes a block ("end for"), a "repeat" with its "until", or a
  row that opens a loop ("for t = 1 to T do") with a second sign beside it, another such row
  or an assignment ("y ← r + γ"). A row that opens with "for" and ends in "do" is no sign
  alone: prose has them ("for every τ. Indeed, ... we do" + "recover ..."), and taking them
  cut 3 prose sentences. Nor is a bare "end" row, or ":=", which math prose defines with
  ("Let f := g, and" + "if x ∈ A then"). From the first keyword row ("Require:",
  "Initialize", "for", an assignment) to the last, so that prose before the algorithm stays
  whole, a step opens a row with a keyword, a capitalized word or an assignment, or follows
  a row that opens or closes a block; a lowercase row, or one after a row that ends on
  "with", a comma or the like, goes on (a wrapped step). Over 138 documents this split 15
  pages of pseudo-code in 12 papers (28 sentences into 166) and no prose. A step's own row,
  numbered or not, is one sentence (`whole` in `_merge_fragments`): the segmenter cut inside
  it ("Require: f(θ):" + "Stochastic objective ...", "9: //" + "For clarity, ...", a comment
  "▷ ..." or a fraction's lower half), 12 times in 9 papers; the caption's row and the text
  after the algorithm keep their sentences. A step that the PDF set on one line with the
  next stays joined, and one that wraps onto a row opening with a keyword ("Stop the
  episode" + "if the goal is reached") is cut there. Short prose that `_keep_sentence` would
  drop as a label (a lead-in before a display equation, "Then we have") is kept by paragraph
  context. These rules were measured on 25 papers with no word lost or duplicated. A
  sentence segmenter swap (Stanza, SaT) was measured and rejected: none reliably splits
  comma-joined lists, and both are much slower (Stanza ran 8x slower than spaCy on real
  per-paragraph calls).
- **Word boxes come from the glyphs.** `_words_with_style()` builds each word's box from its
  own glyphs (`rawdict`). Do not go back to splitting a span by character count: a justified
  line often comes as ONE span, the guess drifted up to ~20pt, and a sentence's first capital
  ("H" of "Here", "LSTM" of "LSTM-GMM") was highlighted with the previous sentence (791
  glyphs over 31 papers; 0 now). A word in the side margin is dropped only when its whole
  PDF line is there: on a narrow page a body line starts inside the 44pt margin. A line
  fragment that opens with a stacked subscript ("{ã^j}_{j=1}^{N}" + "are used") rejoins its
  line although it starts under the superscript (`_joins_line`). TeX's CMEX10 symbol font is
  decoded like MathPi (`_CMEX`): its text layer says "P" for "∑", "e" for a wide tilde, "("
  for a big "{". Only codes the font's own ToUnicode map leaves unmapped are remapped
  (`_cmex_tables`): pdfTeX's map covers just the tall-delimiter pieces, but a full map reads
  "(" as a real parenthesis, so a map's mere presence decides nothing.
- **Inline scripts are marked for the translator only.** A sentence with inline
  sub/superscripts also carries `tex` ("{ ˜ a ^{j} } ^{N neg} _{j = 1}"), and the browser
  sends `tex` for translation; `text` stays plain, because splitting, page stitching and the
  anatomy quote lookup match on it. A script is a smaller word whose baseline sits above or
  below its line's, ATTACHED to the glyph before it (`_script_roles`), so an inline fraction
  ("≜ β²₁/√β₂", after a gap) is not mistaken for scripts. Measured on 9 inline-math sentences,
  2 runs each: unmarked 31/34 expressions right ("ã_j" for "ã^j", "k^q_cmp"), marked 34/34.
- **Highlights follow lines, not glyph boxes.** `lineRects()` in `web/app.js` folds a
  script-size glyph into its line's rect instead of opening a second, overlapping
  rect, and attaches tall TeX math-font boxes (CMSY10/CMEX10, which PyMuPDF sizes from
  the font descender) by x-extent only, so a bar never grows over the next line;
  display equations keep the plain rule. The rects that still overlap (a script that
  sticks out, line boxes taller than the line spacing) paint ONCE: the rects are
  opaque and the highlight layer, which only ever holds one sentence, carries the
  translucency, so do not move the opacity back onto `.hlrect`. Text-layer spans are
  clipped to their word box: the fallback font draws wider than the PDF font, and a
  rotated side stamp ("arXiv ... 2026") would otherwise cover a whole column and
  steal its hover.
- **Zoom resizes the pages in place.** `setScale()` in `web/app.js` resizes each page
  shell and redraws it; it does NOT rebuild `S.pages`. A translation in progress paints
  through the page objects (`P.spanByK`, `P.trBuf`), and rebuilding them (as resizing the
  panel once did) left the rest of the translation blank. Canvases are drawn at
  `devicePixelRatio` (Retina) up to `MAX_CANVAS_PX`, and a page more than 3000px from the
  view gives its canvas and text layer back (`onPageFar`), so memory stays bounded at a
  high zoom. 100% is the paper's real size (96/72 CSS px per point).
- **The reference list is not translated; everything else is.** `end_matter_range()`
  returns the (start, end) range of the reference list, and `layout()` drops words
  inside it. Acknowledgements, funding and the like are translated.
  - It starts at a References heading (`_REF_RE`): the WHOLE line, capitalized, so a
    line of prose that starts with the word does not ("reference of 17,135 actions."
    cost one paper ten pages; a figure label "reference" cost another its Methods),
    and only if a reference list follows (`_BIB_RE`: a tenth of the lines or more carry
    a year, "[12]", arXiv/doi/a URL, "et al", "Proceedings", "pp. 12"; every reference
    page of 31 papers has a quarter or more).
  - It ends at the first appendix/supplementary heading after it, which must stand out
    from the list: its median size + 1pt (11pt always does; one paper sets "A" at 10pt over
    7pt references). It also ends at the top of the first page that is not a reference
    list, whatever that page's headings (one paper's figure appendix, titled
    with no letter), so a missed appendix heading costs at most the rest of one page.
  - The ends compare in READING order (`_before`): on a two-column page the whole left
    column is read before the right one, so a right-column heading does not drop the
    left column's foot (a paper lost its "Limitations and Future Work" that way),
    and a word takes its LINE's column, so a caption across both columns stays whole.
    Both ends allow 2pt: an appendix title split into lines ("A" + "Implementation
    Details") is kept whole.
- **Heading detection is the model's `title` boxes.** A line is a heading only when
  its center is inside a `title` box (no font-size/bold/numbered-pattern heuristics).
  One reading-order fix survives because it is not region typing: a lone section
  number typeset as its own element ("2.1" on its own line) is merged into the
  title-like line that follows and the pair is marked a heading, since a `title` box
  often omits the detached number. The lines of one `title` box are ONE heading, never
  cut into sentences: a wrapped title came out as two headings, and the splitter cut
  "A.1. Pre-training" after "A.1." (58 such headings over 31 papers). A section and its
  first subsection right below it have a box each, so they stay apart.
- **Page 0 drops its front matter, above the Abstract heading.** The heading is a word that
  opens its line and reads "Abstract"/"ABSTRACT", alone or followed by punctuation
  ("Abstract—We ...", `_ABSTRACT_RE`), or the pieces small or spaced capitals come in ("A
  BSTRACT", "A B S T R A C T"); "abstracting" in a paper's introduction (which has no
  Abstract heading) cut away its abstract and introduction. Without the heading the front
  matter ends where running text starts (`_front_cut`): the first of two lines close
  together that hold six words or more, most of them lowercase (`_prose`: a title, names and
  affiliations are mostly capitalized, an abstract is not), with the lines of its PDF block
  right above it in its size (a first line "The Simple Modular Framework for Safe Robot
  ..."). Lines are read as the page shows them (`_text_rows`): an old PDF gives every word,
  or a word's pieces, a line of its own, with boxes of no height. A page with no running
  text is a cover (title, authors, a teaser figure, the abstract on the next page), and all
  of it but its captions goes. A paper may start on page 1 (`_first_page`): when page 0 has
  no Abstract heading and page 1 has one, alone on its line or run in after punctuation (not
  "Abstract syntax trees are ...", nor a contents entry "Abstract . . . 1"), page 0 is a
  cover, a publisher's notice or a summary page, and the rules below for page 0's front
  matter and footnotes apply to page 1 too. The fixed cut 22% down the page this replaced
  kept the end of a long author list and cut off an abstract set higher. A figure caption
  above the Abstract (a teaser figure) is kept. Its footnote with an e-mail address
  (`_EMAIL`) goes too: that is the authors' contact block (affiliations, "Correspondence to:
  ..."), the same front matter set at the foot of the page. Over 32 papers all 10 such
  footnotes were one; content footnotes carry no address. So does a footnote whose mark an
  author carries ("Ann Lee∗" + "∗Equal contribution", "Bo Li†" + "†Work done at ..."): an
  author note, from its mark to the next footnote (a mark or a small number) in its PDF
  block, taken out after the e-mail rule has judged the whole block. Only mark symbols count
  (`_MARKS`, "∗" and "*" as one): an affiliation number ("Lee¹") and the text's first
  footnote ("¹Code is at ...") share "1", and counting numbers took three content footnotes
  with them. A mark in a caption kept above the Abstract is no author's. A note a mark ties
  to an author or the title goes whatever it says (funding, "A preliminary version appeared
  in ..."), as the contact block does; the Acknowledgements section is translated. A venue
  notice, or a note with no mark, is still translated. Over 89 papers this dropped author
  notes in 13 and nothing else. A footnote sentence on the authors with no mark or address
  goes too (`_AUTHOR_NOTE`: "Ann Lee and Bo Li are with the Department of ...",
  "(Corresponding author: Ann Lee.)", "... contributed equally", "Ann Lee is a PhD student
  ...", "Authors' Contact Information: ..."; not a data statement, "available from the
  corresponding author"), on page 0 or 1, by its sentence, as content footnotes and a
  funding note may share its PDF block; a PDF block the model typed as text that holds an
  address or such a note and is no running text goes whole, and so does a short one (25
  words or fewer) with an address that asks to be contacted ("Corresponding authors can be
  contacted at ...") ("E-mail: {a}@sjtu.edu.cn", "Authors' Contact Information: Ann Lee,
  a@b.edu, ...", "Primary contact for the report: ..."), by blocks because a paragraph may
  run from it into the next column's text.
- **Publisher notices, the paper's own citation and a report's list of authors are not
  translated.** On pages 0 and 1, a copyright or licence notice (`_NOTICE`: "© 2026 ...",
  "Copyright held by the owner/author(s).", "All rights reserved.", "licensed under a
  Creative Commons ...", "Copyright may be transferred without notice", "Permission to make
  digital or hard copies ...", "Personal use of this material is permitted"; a word broken
  at a line's end, "Copy-" + "right", read whole; not "the copyright of the data", nor
  "(developed by the MathWorks ©)") goes: the footnote lines of its PDF block (the PDF may
  put the other column's text in that block: an IEEE "©2019 IEEE" line took a column of text
  with it), a PDF block of 40 words or fewer or set smaller than the page's text (a block
  the model typed as a title too), a notice line set smaller than the rest of its block (a
  footer the PDF put in a column's block), or a paragraph that opens with one. So does the
  paper's own citation: a paragraph that holds the document's title (`_title_from_fonts`)
  and a year and is no running text ("ACM Reference Format:" + "Ann Lee and Bo Li. 2025.
  <title>. In Proceedings of ..."), with a heading right above it that ends in a colon; an
  abstract may hold the title and a year too ("This technical report revisits <title> ...
  (Lee et al., 2015)"), and taking it lost that abstract. On any page, a heading
  "Authors"/"Contributors"/"Core Contributors" (`_AUTHORS_HEADING`) goes with the lists
  below it that are no running text, up to the next heading or a paragraph of running text.
  Over 998 arXiv papers (300 technical reports, the rest across fields and years since 2007,
  scored against each paper's author list and abstract), these rules and the first-page cut
  above took the papers with authors' names left on pages 0 and 1 from 122 to 3 and the
  notices and contact lines from 270 to 13, read 47 abstracts more fully and lost none. Laid
  out whole, 156 of them (3,236 pages) changed on no later page but one, a report's list of
  authors. Known limits: a column of affiliations set beside the abstract keeps the lines
  that lie beside it, and a list of contributors that runs on past its page is translated
  there.
- **Footnotes are read one by one; a link alone is not translated.** A footnote paragraph
  may hold several footnotes, and the next one's number used to end the one before it ("...
  all tasks 3" | "After each batch ..."): each line that opens with a mark symbol or with a
  number or a letter set smaller than the rest of its line starts a sentence (a word at the
  line's size is none, a larger symbol beside it or not). A sign before a number ("§4.2") or
  of the text ("#tokens", "‖x‖") is no mark. A footnote sentence that is only a link
  (`_link_only`: two words or fewer once the links are out, "1 Code: https://...", "5.
  hf.co/...") is not translated, since its translation would be the same link; one with
  prose ("1 The code is available at https://...") is, and so is Chinese or Japanese prose,
  which has no spaces to count words by. Over 89 papers that dropped 433 words on 105 pages,
  all links, labels and footnote numbers. Footnotes as a whole stay: they are 1% of the
  words, most of them say something (a definition, a caveat), and the model's furniture
  boxes they come from also hold text that is no footnote (a dialogue example in mid-page).
- **A table of contents is not translated.** `_toc_lines()` finds it on each page by its
  entries: a row that ends in a page number after a dot leader or a wide gap, or a number on
  a line of its own beside a title (the nearest line to its left; a row of numbers, such as
  axis ticks, is no entry; on a two-column page a title with no dot leader is in its
  number's column, or a plot's ticks beside the other column's prose would take that prose).
  It needs five rows of entries that follow on without a wide gap, three different numbers,
  mostly going up in reading order. Not by a "Contents" heading: the contents run on to
  pages without one; the list's own heading right above the entries ("Contents", "List of
  Tables") goes with them, and so does a list of figures or tables. A "Contents" heading
  right above lowers the need to two rows, one with a dot leader, for contents that start at
  a page's foot (two rows that end in numbers under a section named "Contents" are no
  contents). Only the entries' own band goes, one column at a time: contents that fill one
  column and run on in the next stand beside text that is not theirs (a figure caption, the
  start of the introduction), and one band across the page took that text too. The band
  takes a first title that wraps above its number's row, back to the line that opens with
  its number ("2.1 Two simple ..."), and a last title that runs on below up to its number,
  but never grows past a heading: a thesis chapter may open with the short contents of its
  sections, and its title ("1 Introduction") opens with a number like an entry. Text below
  the last entry stays, and a table with dot leaders is gone before (a table box covers it).
  A running head is never an entry, by its words and its place in the page's top or bottom
  band: a monograph's heads repeat its chapter titles ("INTRODUCTION"), and by its words
  alone the entry "1 Introduction" was none. It runs before page numbers are dropped, since
  the model may call an entry's number furniture. Over 89 papers it dropped 25 pages of
  contents in 16 and nothing else, over 22 papers kept out of the tuning (a 180-page
  monograph, surveys, a two-column supplement, math, physics, ACM and IEEE layouts) 6 pages
  in 4 and the start of a seventh, and in a PhD thesis its contents and lists of figures and
  tables; the internal links of hyperref contents found no page it missed. A list of symbols
  is no contents, page numbers or not: its rows open with the symbol ("α", "x"), on the
  title's line or just left of it. A list of abbreviations with page numbers would go like a
  list of figures (none had them in the documents seen).
- **An appendix cover's copy of the front matter is dropped.** Page 0 drops everything
  above the Abstract (title, authors, affiliations; `_front_cut`). An appendix or
  supplement often opens on a cover that repeats those lines, and the model may type its
  author line as a title (one paper: four author "headings"). On a later page, a
  paragraph made only of lines that repeat page 0's front matter is dropped
  (`_front_matter`, compared by letters only, since the copies differ in spacing,
  affiliation digits and quotes). A cover title that adds words ("Appendix for ...")
  is not a pure copy and stays.
- **Line-break hyphens are rejoined.** `_join_words()` turns 'to-' + 'kens' (split
  across a line) into 'tokens' for the sentence text, while keeping both word
  boxes for highlighting. Suspended hyphens ('code- and reasoning-related') are
  left alone because the next word is on the same line.
- Known limits: scanned/image-only PDFs are unsupported (no OCR); the compiled PDF
  has no LaTeX source, so math is reconstructed by the model, not parsed. Cross-page
  sentence stitching only looks at the IMMEDIATE next page — a sentence whose
  continuation is pushed two or more pages away by a full page of figures/tables is
  not stitched (rare; a correct multi-page version would need both the forward and
  backward passes to agree on how many float-only pages to skip). A layout model
  whose `title` detection fails on an unusual typography (e.g. an old single-column
  monograph) yields few headings; a font/number heuristic supplement was measured
  against arXiv `.tex` and REVERTED because it cost ~10 points of precision for
  almost no recall — so such papers keep flowing their headings as body text.
