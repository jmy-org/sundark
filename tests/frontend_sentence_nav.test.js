"use strict";
// The Translation sentence navigator: native Previous/Next/Pin source buttons that reach the same
// pin and source-scroll path as a mouse click, over a minimal fake DOM (no browser).
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const src = fs.readFileSync("web/app.js", "utf8");

// Pull top-level functions out of app.js by name, plus the navigator's own section.
function fn(name) {
  const start = src.indexOf(`\nfunction ${name}(`);
  assert.ok(start >= 0, `${name} exists`);
  return src.slice(start, src.indexOf("\n}\n", start) + 3);
}
function block(head) {
  const start = src.indexOf(head);
  assert.ok(start >= 0, `${head.trim()} exists`);
  return src.slice(start, src.indexOf("\n}\n", start) + 3);
}
function line(head) {
  const start = src.indexOf(head);
  assert.ok(start >= 0, `${head} exists`);
  return src.slice(start).split("\n")[0];
}
const navStart = src.indexOf("// ================= Sentence navigator");
assert.ok(navStart >= 0, "sentence navigator section exists");
const navSrc = src.slice(navStart, src.indexOf("\n// ================= ", navStart + 10));
const asyncStart = src.indexOf("\nasync function openDoc(");
assert.ok(asyncStart >= 0, "openDoc exists");
const code = [
  src.slice(asyncStart, src.indexOf("\n}\n", asyncStart) + 3),
  fn("buildTrShells"),
  fn("paintFrontier"),
  fn("makeTrSeg"),
  fn("toggleTrPin"),
  fn("unpinTr"),
  src
    .slice(src.indexOf('document.addEventListener("keydown", (e) => { if (e.key === "Escape")'))
    .split("\n")[0],
  navSrc,
  // The Auto-translate checkbox and the translation run it starts.
  line('$("autotr").addEventListener("change"'),
  line("const trPool = "),
  line("const BULLET_RE = "),
  block("\nasync function translateAll("),
  fn("paragraphBatches"),
  fn("preparePage"),
  fn("retranslateAll"),
].join("\n");

class El {
  constructor(tag, doc) {
    this.tagName = tag;
    this.doc = doc;
    this.children = [];
    this.parent = null;
    this.cls = new Set();
    this.dataset = {};
    this.attrs = {};
    this.listeners = {};
    this._text = "";
    this.style = {};
    this.disabled = false;
    this.hovered = false;
    this.scrolled = 0;
  }
  get classList() {
    const c = this.cls;
    return {
      add: (x) => c.add(x),
      remove: (x) => c.delete(x),
      contains: (x) => c.has(x),
      toggle: (x, on) => (on ? c.add(x) : c.delete(x)),
    };
  }
  set className(v) {
    this.cls = new Set(v.split(/\s+/).filter(Boolean));
  }
  get textContent() {
    return this.children.length ? this.children.map((c) => c.textContent).join("") : this._text;
  }
  set textContent(v) {
    this.children = [];
    this._text = String(v);
  }
  set innerHTML(_) {
    for (const c of this.children) c.parent = null;
    this.children = [];
    this._text = "";
  }
  get childNodes() {
    if (this.children.length) return this.children;
    const t = new El("#text", this.doc);
    t._text = this._text;
    return this._text ? [t] : [];
  }
  appendChild(c) {
    c.parent = this;
    this.children.push(c);
    return c;
  }
  replaceChildren() {
    this.children = [];
    this._text = "";
  }
  remove() {
    if (this.parent) this.parent.children = this.parent.children.filter((c) => c !== this);
    this.parent = null;
  }
  contains(x) {
    for (let n = x; n; n = n.parent) if (n === this) return true;
    return false;
  }
  get isConnected() {
    return this.doc.body.contains(this);
  }
  all() {
    return this.children.flatMap((c) => [c, ...c.all()]);
  }
  querySelectorAll(sel) {
    const want = sel.split(".").filter(Boolean);
    return this.all().filter((e) => want.every((w) => e.cls.has(w)));
  }
  querySelector(sel) {
    return this.querySelectorAll(sel)[0] || null;
  }
  addEventListener(type, f) {
    (this.listeners[type] = this.listeners[type] || []).push(f);
  }
  fire(type, ev = {}) {
    for (const f of this.listeners[type] || []) f({ currentTarget: this, target: this, ...ev });
  }
  setAttribute(k, v) {
    this.attrs[k] = String(v);
  }
  getAttribute(k) {
    return this.attrs[k];
  }
  focus() {
    this.doc.activeElement = this;
  }
  matches(sel) {
    return sel === ":hover" && this.hovered;
  }
  scrollIntoView() {
    this.scrolled += 1;
  }
  cloneNode() {
    const c = new El(this.tagName, this.doc);
    c._text = this.textContent;
    c.cls = new Set(this.cls);
    return c;
  }
}

function setup({ narrow = false } = {}) {
  const calls = { highlight: [], hover: [], panes: [], math: 0, batches: [] };
  const doc = { listeners: {}, activeElement: null };
  doc.body = new El("body", doc);
  doc.createElement = (tag) => new El(tag, doc);
  doc.createTextNode = (text) => Object.assign(new El("#text", doc), { _text: text });
  doc.addEventListener = (type, f) => (doc.listeners[type] = doc.listeners[type] || []).push(f);
  doc.querySelectorAll = (sel) => doc.body.querySelectorAll(sel);
  const ids = {};
  const mk = (id, parent) => {
    const e = new El("div", doc);
    e.id = id;
    ids[id] = e;
    parent.appendChild(e);
    return e;
  };
  const aipanel = mk("aipanel", doc.body);
  const panes = mk("panes", doc.body);
  const sourceBtn = mk("pane-source", panes);
  mk("trlist", aipanel);
  for (const id of ["trnav-prev", "trnav-next", "trnav-pin", "trnav-pos", "trnav-preview"]) {
    mk(id, aipanel);
  }
  mk("trnav-status", aipanel);
  for (const id of ["pdfview", "prep-overlay", "prep-fill", "prep-text", "empty", "pdfcol"]) {
    mk(id, doc.body);
  }
  for (const id of ["library", "summary", "chatlog", "anatomy", "autotr"]) mk(id, doc.body);
  doc.hasFocus = () => false;
  doc.querySelector = (sel) => {
    assert.equal(sel, '#panes [data-pane="source"]');
    return sourceBtn;
  };
  const state = { pane: "ai" };
  const S = {
    pages: [],
    numPages: 0,
    frontier: 0,
    onFirstPaint: null,
    openGeneration: 0,
    trToken: 0,
    aiConfig: null,
  };
  // openDoc's PDF side: each paper's source and first page are whatever the test hands back.
  const sources = {};
  const ctx = {
    S,
    document: doc,
    $: (id) => ids[id],
    getComputedStyle: (el) => ({
      visibility: narrow && state.pane !== "ai" && aipanel.contains(el) ? "hidden" : "visible",
    }),
    showPane: (name) => {
      state.pane = name;
      calls.panes.push(name);
    },
    setHover: (page, k, on) => {
      calls.hover.push([page, k, on]);
      const t = ids.trlist
        .querySelectorAll("trseg")
        .find((d) => d.dataset.page == page && d.dataset.i == k);
      if (t) t.classList.toggle("hl", on);
    },
    highlightSource: (page, k, on, scroll) => {
      calls.highlight.push([page, k, scroll]);
      ctx.setHover(page, k, on);
    },
    renderMath: () => calls.math++,
    AbortController,
    Promise,
    readerTransport: { pdfSource: (id) => sources[id]() },
    pdfjsLib: {
      getDocument: (source) => ({
        promise: Promise.resolve({ getPage: async () => source.page }),
        destroy: () => Promise.resolve(),
      }),
    },
    setTitle: (title) => (calls.title = title),
    updateReviewBtn() {},
    zoomScale: () => 1,
    showZoom() {},
    showPageNum() {},
    stopRender() {},
    buildPageShells: async () => {
      S.pages = Array.from({ length: S.numPages }, () => ({}));
    },
    waitLayout: () => Promise.resolve(),
    sleep: () => Promise.resolve(),
    // A translation run over saved results: every batch answers at once, nothing is forced.
    lang: () => "ko",
    hide() {},
    ensureLayout: async () => {},
    fetchMath: async () => {},
    translateBatch: async (page, b, force, token) => {
      calls.batches.push([page, b.start, force]);
      const P = S.pages[page];
      if (token !== S.trToken || !P.trBuf) return;
      b.texts.forEach((text, j) => (P.trBuf[b.start + j] = "번역 " + text));
      ctx.paintFrontier();
    },
  };
  vm.createContext(ctx);
  vm.runInContext(code, ctx);

  // Lay out pages the way preparePage does: one wrap per page, empty spans, painted in order.
  const shells = (texts) => {
    S.pages = texts.map((page, i) => {
      const wrap = ids.trlist.children[i];
      const spanByK = page.map((_, k) => wrap.appendChild(ctx.makeTrSeg(i, k, "")));
      return { segs: page.map((t) => ({ text: t })), spanByK, trBuf: [], frontK: 0 };
    });
  };
  const open = (texts) => {
    S.numPages = texts.length;
    ctx.buildTrShells();
    shells(texts);
  };
  const paint = (page, k, tr) => {
    S.pages[page].trBuf[k] = tr;
    ctx.paintFrontier();
  };
  const spans = () => ids.trlist.querySelectorAll("trseg");
  const where = () => S.trSel && [Number(S.trSel.dataset.page), Number(S.trSel.dataset.i)];
  const escape = () => doc.listeners.keydown.forEach((f) => f({ key: "Escape" }));
  // A source that is a valid one-page PDF whose range read can fail later.
  const pdfSource = () => {
    let fail;
    const failed = new Promise((_, reject) => (fail = reject));
    failed.catch(() => {});
    const page = { getViewport: () => ({ width: 100, height: 100 }) };
    return { source: { range: { failed }, page }, fail };
  };
  const navState = () => ({
    sel: S.trSel,
    spans: spans().length,
    prev: ids["trnav-prev"].disabled,
    next: ids["trnav-next"].disabled,
    pin: ids["trnav-pin"].disabled,
    pressed: ids["trnav-pin"].getAttribute("aria-pressed"),
    pos: ids["trnav-pos"].textContent,
    preview: ids["trnav-preview"].textContent,
    status: ids["trnav-status"].textContent,
  });
  const cleared = {
    sel: null,
    spans: 0,
    prev: true,
    next: true,
    pin: true,
    pressed: "false",
    pos: "None selected",
    preview: "",
    status: "",
  };
  return {
    ctx,
    S,
    ids,
    doc,
    calls,
    state,
    open,
    shells,
    paint,
    spans,
    where,
    escape,
    sourceBtn,
    sources,
    pdfSource,
    navState,
    cleared,
  };
}

// Nothing to navigate before anything is painted.
{
  const t = setup();
  t.open([["a", "b"], ["c"]]);
  assert.equal(t.ids["trnav-prev"].disabled, true);
  assert.equal(t.ids["trnav-next"].disabled, true);
  assert.equal(t.ids["trnav-pin"].disabled, true);
  assert.equal(t.ids["trnav-pin"].getAttribute("aria-pressed"), "false");
}

// Previous/Next walk painted, nonempty sentences in document order across pages; an empty
// translation and the still-unpainted tail are skipped. Streaming only enables, never announces.
{
  const t = setup();
  t.open([
    ["a", "b", "c"],
    ["d", "e"],
  ]);
  t.doc.activeElement = null;
  t.paint(0, 0, "가");
  assert.equal(t.ids["trnav-next"].disabled, false, "a painted sentence enables Next");
  assert.equal(t.ids["trnav-status"].textContent, "", "streaming does not announce");
  assert.equal(t.doc.activeElement, null, "streaming does not take focus");
  t.paint(0, 1, ""); // the model returned nothing for this one
  t.paint(0, 2, "다");
  t.paint(1, 0, "라");
  t.ids["trnav-next"].fire("click");
  assert.deepEqual(t.where(), [0, 0]);
  assert.equal(t.ids["trnav-prev"].disabled, true, "nothing before the first sentence");
  t.ids["trnav-next"].fire("click");
  assert.deepEqual(t.where(), [0, 2], "the empty sentence is skipped");
  t.ids["trnav-next"].fire("click");
  assert.deepEqual(t.where(), [1, 0], "Next crosses the page break");
  assert.equal(t.ids["trnav-next"].disabled, true, "page 1 sentence 2 is not painted yet");
  assert.equal(t.ids["trnav-status"].textContent, "Page 2, sentence 1");
  assert.equal(t.ids["trnav-pos"].textContent, "Page 2, sentence 1");
  assert.equal(t.ids["trnav-preview"].textContent, "라");
  assert.ok(t.S.trSel.cls.has("selected"), "the original sentence is marked");
  assert.ok(t.S.trSel.scrolled > 0, "and scrolled into view");
  assert.equal(t.calls.highlight.length, 0, "moving does not pin");
  t.paint(1, 1, "마");
  assert.equal(t.ids["trnav-next"].disabled, false, "a new sentence after the selection");
  t.ids["trnav-prev"].fire("click");
  assert.deepEqual(t.where(), [0, 2]);
  const announced = t.ids["trnav-status"].textContent;
  t.paint(1, 1, "마"); // a repaint after the move
  assert.equal(t.ids["trnav-status"].textContent, announced);
}

// Mouse click, the Pin source button and Escape share one pin state.
{
  const t = setup();
  t.open([["a", "b"]]);
  t.paint(0, 0, "가");
  t.paint(0, 1, "나");
  const [s0, s1] = t.spans();
  s1.hovered = true;
  s1.fire("click");
  s1.hovered = false;
  assert.ok(s1.cls.has("pinned"));
  assert.deepEqual(t.where(), [0, 1], "a click selects the sentence");
  assert.deepEqual(t.calls.highlight, [[0, 1, "center"]]);
  assert.deepEqual(t.calls.panes, ["source"]);
  assert.equal(t.ids["trnav-pin"].getAttribute("aria-pressed"), "true");
  t.escape();
  assert.ok(!s1.cls.has("pinned"));
  assert.equal(t.ids["trnav-pin"].getAttribute("aria-pressed"), "false", "Escape syncs the toggle");
  assert.deepEqual(t.where(), [0, 1], "Escape keeps the selection");

  t.ids["trnav-pin"].fire("click");
  assert.ok(s1.cls.has("pinned"), "Pin source pins the selection");
  assert.ok(s1.cls.has("hl"), "and draws its highlight");
  assert.deepEqual(t.calls.highlight[1], [0, 1, "center"]);
  t.ids["trnav-pin"].fire("click");
  assert.ok(!s1.cls.has("pinned"), "a second press releases it");
  assert.ok(!s1.cls.has("hl"), "and clears the highlight a keyboard pin left");
  assert.equal(t.ids["trnav-pin"].getAttribute("aria-pressed"), "false");

  t.ids["trnav-pin"].fire("click");
  t.ids["trnav-prev"].fire("click");
  assert.deepEqual(t.where(), [0, 0]);
  assert.ok(!s1.cls.has("pinned") && !s0.cls.has("pinned"), "moving releases the pin");
  assert.equal(t.ids["trnav-pin"].getAttribute("aria-pressed"), "false");

  // A pointer pin on the hovered sentence keeps the hover the pointer owns.
  s0.hovered = true;
  s0.fire("click");
  s0.fire("click");
  assert.ok(s0.cls.has("hl"), "a second click under the pointer leaves the hover alone");
}

// Narrow screen: Pin source moves focus to the visible PDF pane control, never the hidden button;
// back on the AI pane the selection is the same sentence. Desktop keeps focus on the button.
{
  const t = setup({ narrow: true });
  t.open([["a"]]);
  t.paint(0, 0, "가");
  t.ids["trnav-next"].fire("click");
  const sel = t.S.trSel;
  t.ids["trnav-pin"].focus();
  t.ids["trnav-pin"].fire("click");
  assert.equal(t.state.pane, "source");
  assert.equal(t.doc.activeElement, t.sourceBtn);
  t.state.pane = "ai";
  assert.equal(t.S.trSel, sel);
  assert.equal(t.ids["trnav-pin"].getAttribute("aria-pressed"), "true");

  const d = setup();
  d.open([["a"]]);
  d.paint(0, 0, "가");
  d.ids["trnav-next"].fire("click");
  d.ids["trnav-pin"].focus();
  d.ids["trnav-pin"].fire("click");
  assert.equal(d.doc.activeElement, d.ids["trnav-pin"]);
}

// Retranslation (or a new document) rebuilds the shells and forgets the selection.
{
  const t = setup();
  t.open([["a", "b"]]);
  t.paint(0, 0, "가");
  t.paint(0, 1, "나");
  t.ids["trnav-next"].fire("click");
  t.ids["trnav-pin"].fire("click");
  t.open([["a", "b"]]);
  assert.equal(t.S.trSel, null);
  assert.equal(t.ids["trnav-pin"].disabled, true);
  assert.equal(t.ids["trnav-pin"].getAttribute("aria-pressed"), "false");
  assert.equal(t.ids["trnav-next"].disabled, true);
  assert.equal(t.ids["trnav-pos"].textContent, "None selected");
  assert.equal(t.ids["trnav-preview"].textContent, "");
  assert.equal(t.ids["trnav-status"].textContent, "");
}

// Retranslating after a keyboard pin (no mouseleave to clear it) takes the PDF highlight down
// before the pinned sentence's span goes.
{
  const t = setup();
  t.open([["a", "b"]]);
  t.paint(0, 0, "가");
  t.paint(0, 1, "나");
  t.ids["trnav-next"].fire("click");
  t.ids["trnav-next"].fire("click");
  t.ids["trnav-pin"].fire("click");
  const pinned = t.S.trSel;
  assert.ok(pinned.cls.has("hl"), "the keyboard pin drew the highlight");
  t.calls.hover = [];
  t.open([["a", "b"]]);
  assert.deepEqual(t.calls.hover, [[0, 1, false]], "the old pin's highlight was cleared");
  assert.ok(!pinned.cls.has("pinned") && !pinned.cls.has("hl"));
}

// Previous/Next that reach an end disable themselves: the keyboard user who pressed one keeps
// focus in the group (on Pin source), but a move nobody pressed a button for takes no focus.
{
  const t = setup();
  t.open([["a", "b", "c"]]);
  t.paint(0, 0, "가");
  t.paint(0, 1, "나");
  const next = t.ids["trnav-next"],
    prev = t.ids["trnav-prev"],
    pin = t.ids["trnav-pin"];
  next.focus();
  next.fire("click");
  assert.equal(t.doc.activeElement, next, "Next stays focused while it can still move");
  next.fire("click");
  assert.deepEqual(t.where(), [0, 1]);
  assert.equal(next.disabled, true, "the painted frontier is reached");
  assert.equal(t.doc.activeElement, pin, "focus moved to Pin source, not dropped");
  prev.focus();
  prev.fire("click");
  assert.equal(prev.disabled, true, "the first sentence is reached");
  assert.equal(t.doc.activeElement, pin, "Previous at the start hands focus to Pin source");

  // A move made without pressing the button (focus elsewhere) leaves focus alone.
  t.paint(0, 2, "다");
  const other = t.ids.summary;
  other.focus();
  t.ctx.moveTr(1);
  t.ctx.moveTr(1);
  assert.equal(next.disabled, true);
  assert.equal(t.doc.activeElement, other, "focus was not taken from an unrelated control");
  t.doc.activeElement = t.doc.body;
  t.ctx.moveTr(-1);
  t.ctx.moveTr(-1);
  assert.equal(prev.disabled, true);
  assert.equal(t.doc.activeElement, t.doc.body, "a programmatic move takes no focus");
}

const tick = async () => {
  for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
};

// Opening a paper forgets the old paper's sentence the moment it starts, before any await, and
// a failed or later-failing open leaves nothing the old list can bring back.
async function lifecycle() {
  const t = setup();
  const a = t.pdfSource();
  t.sources.A = async () => a.source;
  await t.ctx.openDoc({ doc_id: "A", num_pages: 1, title: "A" });
  assert.equal(t.S.docId, "A");
  t.shells([["a", "b"]]);
  t.paint(0, 0, "가");
  t.paint(0, 1, "나");
  t.ids["trnav-next"].fire("click");
  t.ids["trnav-pin"].fire("click");
  assert.equal(t.ids["trnav-pin"].getAttribute("aria-pressed"), "true");

  // B's source never arrives: the reset is synchronous, before openDoc's first await.
  let failB;
  t.sources.B = () => new Promise((_, reject) => (failB = reject));
  const opening = t.ctx.openDoc({ doc_id: "B", num_pages: 1, title: "B" });
  assert.deepEqual(t.navState(), t.cleared, "the old navigator survived into the new open");
  t.ctx.syncTrNav();
  assert.deepEqual(t.navState(), t.cleared, "the old list re-enabled the navigator");
  failB(new Error("bridge lost"));
  await assert.rejects(opening, /bridge lost/);
  assert.equal(t.S.docId, null);
  assert.deepEqual(t.navState(), t.cleared, "a failed open left the navigator");

  // A range that fails after the open gives the library back and the navigator with it.
  const c = t.pdfSource();
  t.sources.C = async () => c.source;
  await t.ctx.openDoc({ doc_id: "C", num_pages: 1, title: "C" });
  t.shells([["a", "b"]]);
  t.paint(0, 0, "가");
  t.paint(0, 1, "나");
  t.ids["trnav-next"].fire("click");
  t.ids["trnav-next"].fire("click");
  t.ids["trnav-pin"].fire("click");
  assert.equal(t.ids["trnav-pin"].disabled, false);
  t.calls.hover = [];
  c.fail(new Error("Invalid reader binary chunk."));
  await tick();
  assert.equal(t.S.docId, null, "the post-open failure gave the library back");
  assert.deepEqual(t.navState(), t.cleared, "a post-open failure left the navigator");
  assert.deepEqual(t.calls.hover, [[0, 1, false]], "the keyboard pin was released");

  // A stale failure (A's range, long superseded) leaves the paper opened since then alone.
  const d = t.pdfSource();
  t.sources.D = async () => d.source;
  await t.ctx.openDoc({ doc_id: "D", num_pages: 1, title: "D" });
  t.shells([["a"]]);
  t.paint(0, 0, "가");
  t.ids["trnav-next"].fire("click");
  a.fail(new Error("late A failure"));
  await tick();
  assert.equal(t.S.docId, "D");
  assert.deepEqual(t.where(), [0, 0], "a stale failure reset the open paper's navigator");
}

// Auto-translate off and on again over a finished, keyboard-pinned document: the list is rebuilt
// from saved results (nothing forced), the old sentence and its PDF highlight go with it, and the
// newly painted sentences are navigable.
async function autotrToggle() {
  const t = setup();
  const autotr = t.ids.autotr;
  autotr.checked = true;
  t.S.docId = "A";
  t.S.aiConfig = { backend: "claude", concurrency: { claude: 2 } };
  t.S.numPages = 2;
  t.ctx.buildTrShells();
  const seg = (text, para) => ({ text, para, size: 10 });
  t.S.pages = [{ segs: [seg("a", 0), seg("b", 0)] }, { segs: [seg("c", 0)] }];
  await t.ctx.translateAll();
  assert.equal(t.S.frontier, 2, "the first run painted the whole document");
  t.ids["trnav-next"].fire("click");
  t.ids["trnav-next"].fire("click");
  t.ids["trnav-pin"].fire("click");
  const old = t.S.trSel;
  assert.deepEqual(t.where(), [0, 1]);
  assert.ok(old.cls.has("pinned") && old.cls.has("hl"), "the keyboard pin drew the highlight");

  // Off changes nothing on screen.
  t.calls.batches = [];
  autotr.checked = false;
  autotr.fire("change");
  await tick();
  assert.equal(t.S.trSel, old, "turning it off keeps the selection");
  assert.ok(old.isConnected && old.cls.has("pinned"));
  assert.deepEqual(t.calls.batches, [], "turning it off starts nothing");

  t.calls.hover = [];
  autotr.checked = true;
  autotr.fire("change");
  await tick();
  assert.ok(!old.isConnected, "the old sentence's span was replaced");
  assert.ok(!old.cls.has("pinned") && !old.cls.has("hl"), "and released");
  assert.deepEqual(t.calls.hover, [[0, 1, false]], "the keyboard pin's PDF highlight was cleared");
  assert.ok(
    t.calls.batches.length > 0 && t.calls.batches.every(([, , force]) => !force),
    "saved translations are reused, not regenerated",
  );
  assert.equal(t.S.frontier, 2, "the frontier ran over the rebuilt list");
  assert.deepEqual(
    t.spans().map((d) => d.textContent),
    ["번역 a", "번역 b", "번역 c"],
    "the rebuilt list is painted",
  );
  assert.deepEqual(
    t.navState(),
    { ...t.cleared, spans: 3, next: false },
    "no stale source bar: nothing selected, Next ready",
  );

  // The detached sentence cannot be pinned, even if something still holds it.
  t.calls.highlight = [];
  t.S.trSel = old;
  t.ids["trnav-pin"].fire("click");
  assert.deepEqual(t.calls.highlight, [], "a removed sentence was pinned");
  assert.equal(t.S.trSel, null, "the removed sentence is forgotten");
  assert.equal(t.ids["trnav-pin"].disabled, true);
  assert.equal(t.ids["trnav-pos"].textContent, "None selected");

  // The new sentences take the keyboard path end to end.
  t.ids["trnav-next"].fire("click");
  t.ids["trnav-next"].fire("click");
  t.ids["trnav-next"].fire("click");
  assert.deepEqual(t.where(), [1, 0]);
  assert.ok(t.S.trSel.isConnected);
  t.ids["trnav-pin"].fire("click");
  assert.deepEqual(t.calls.highlight, [[1, 0, "center"]]);
  assert.equal(t.ids["trnav-pin"].getAttribute("aria-pressed"), "true");
  assert.equal(t.ids["trnav-preview"].textContent, "번역 c");

  // A run that rebuilds a page in place (no new shells) also lets the selection go with it.
  t.calls.hover = [];
  const pinned = t.S.trSel;
  await t.ctx.translateAll();
  assert.ok(!pinned.isConnected && !pinned.cls.has("pinned"));
  assert.deepEqual(t.calls.hover, [[1, 0, false]]);
  assert.equal(t.S.trSel, null);
  assert.equal(t.ids["trnav-pin"].disabled, true);
  assert.equal(t.ids["trnav-preview"].textContent, "");
}

// Source check only (geometry needs a browser): the position text never shares a row with the
// buttons, so a longer position cannot wrap beside them and grow the bar.
const css = fs.readFileSync("web/styles.css", "utf8");
assert.match(css, /\.trnav-bar \{[^}]*flex-wrap: wrap;/, "navigator wraps at narrow widths");
assert.match(css, /\.trnav-pos \{[^}]*flex: 1 1 calc\(100% - 8em\);/, "position fills the label's row");

lifecycle()
  .then(autotrToggle)
  .then(() => console.log("sentence navigator ok"))
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  });
