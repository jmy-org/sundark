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
  // The PDF side's hover owner, which a rebuilt list must leave alone.
  line("let pdfHoverCur = null;"),
  "function setPdfHover(v) { pdfHoverCur = v; }",
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
// The PDF side for real: highlight layers, the text layer's hover owner, and a page's teardown.
const pdfCode = [fn("drawHlRects"), fn("setHover"), fn("attachPdfHover"), fn("clearPdfHover"), fn("stopRender")];

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
    // Classes, and data attributes as setHover names a sentence: .trseg[data-page="0"][data-i="1"]
    const data = [...sel.matchAll(/\[data-(\w+)="([^"]*)"\]/g)];
    const want = sel.replace(/\[[^\]]*\]/g, "").split(".").filter(Boolean);
    return this.all().filter(
      (e) => want.every((w) => e.cls.has(w)) && data.every(([, k, v]) => String(e.dataset[k]) === v),
    );
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

function setup({ narrow = false, real = false } = {}) {
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
  mk("tab-translation", doc.body);
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
  if (real) {
    // The real setHover, stopRender and the PDF hover handlers replace the stubs.
    delete ctx.setHover;
    delete ctx.stopRender;
    S.scale = 1;
    Object.assign(ctx, { partAt: () => 0, scrollTrTo() {}, segParts: () => [], partY() {}, segMidY() {} });
  }
  vm.createContext(ctx);
  vm.runInContext(code + (real ? "\n" + pdfCode.join("\n") : ""), ctx);

  // Lay out pages the way preparePage does: one wrap per page, empty spans, painted in order.
  const shells = (texts) => {
    S.pages = texts.map((page, i) => {
      const wrap = ids.trlist.children[i];
      const spanByK = page.map((_, k) => wrap.appendChild(ctx.makeTrSeg(i, k, "")));
      const P = { segs: page.map((t) => ({ text: t })), spanByK, trBuf: [], frontK: 0 };
      // A rebuilt list keeps its pages' PDF side, as a retranslation does.
      return real && S.pages[i] && S.pages[i].textEl ? Object.assign(S.pages[i], P, { segs: S.pages[i].segs }) : P;
    });
  };
  // Draw each page's PDF side the way renderPage does: a highlight layer and a text layer with
  // the hover handlers. Sentence k sits at x = 10k; `next` gives page 0's last sentence a
  // continuation at x = 50 on page 1.
  const layers = ({ next = false } = {}) => {
    S.pages.forEach((P, i) => {
      P.el = ids.pdfview.appendChild(doc.createElement("div"));
      P.hllayer = P.el.appendChild(doc.createElement("div"));
      P.textEl = P.el.appendChild(doc.createElement("div"));
      P.segs.forEach((seg, k) => (seg.rects = [{ left: 10 * k, top: 0, w: 5, h: 5 }]));
      if (next && i === 0) Object.assign(P.segs.at(-1), { nextPage: 1, rectsNext: [{ left: 50, top: 0, w: 5, h: 5 }] });
      ctx.attachPdfHover(i, P.textEl);
    });
  };
  // The pointer over sentence k of page `pg`, on page `on`'s text layer.
  const pointAt = (on, pg, k) => {
    const word = { _seg: k, _segPage: pg === on ? undefined : pg };
    word.closest = () => word;
    S.pages[on].textEl.fire("mousemove", { target: word });
  };
  // What a page's highlight layer shows: the x of each rect drawn (rings and fills alike).
  const drawn = (page) => S.pages[page].hllayer.children.map((d) => d.style.left);
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
    layers,
    pointAt,
    drawn,
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

// A rebuilt list takes down every PDF highlight its detached spans hold (none of them will get a
// mouseleave), except the sentence the pointer owns on the PDF, which stays drawn.
{
  // Hovered, never pinned: the pointer was on it when the list went.
  const t = setup();
  t.open([["a", "b", "c"]]);
  ["가", "나", "다"].forEach((x, k) => t.paint(0, k, x));
  const s1 = t.spans()[1];
  s1.hovered = true;
  s1.fire("mouseenter");
  t.calls.hover = [];
  t.open([["a", "b", "c"]]);
  assert.ok(!s1.isConnected, "the hovered sentence's span was replaced");
  assert.deepEqual(t.calls.hover, [[0, 1, false]], "a hovered sentence's highlight outlived its span");
  assert.ok(!s1.cls.has("hl"));

  // Clicked under the pointer (pinned and hovered): released once, not left to the pointer.
  t.paint(0, 0, "가");
  t.paint(0, 1, "나");
  const c1 = t.spans()[1];
  c1.hovered = true;
  c1.fire("mouseenter");
  c1.fire("click");
  t.calls.hover = [];
  t.open([["a", "b", "c"]]);
  assert.deepEqual(t.calls.hover, [[0, 1, false]], "a clicked sentence's highlight outlived its span");
}
{
  // The pointer is on sentence 1 in the PDF: its bar is the PDF's, and the text layer stays.
  const t = setup();
  t.open([["a", "b", "c"]]);
  ["가", "나", "다"].forEach((x, k) => t.paint(0, k, x));
  t.ctx.setPdfHover({ page: 0, k: 1, part: 0 });
  t.ctx.setHover(0, 1, true);
  t.calls.hover = [];
  t.open([["a", "b", "c"]]);
  assert.deepEqual(t.calls.hover, [], "the PDF-owned highlight was cleared");

  // The same sentence also pinned from the keyboard: the pin goes, the PDF's bar stays.
  ["가", "나", "다"].forEach((x, k) => t.paint(0, k, x));
  t.ids["trnav-next"].fire("click");
  t.ids["trnav-next"].fire("click");
  t.ids["trnav-pin"].fire("click");
  t.calls.hover = [];
  t.open([["a", "b", "c"]]);
  assert.deepEqual(t.calls.hover, [], "releasing the pin cleared the PDF-owned highlight");
  assert.equal(t.ids["trnav-pin"].getAttribute("aria-pressed"), "false");

  // Another sentence on the same page pinned from the keyboard: clearing it wipes the page's
  // layer, so the PDF-owned bar is drawn again.
  ["가", "나", "다"].forEach((x, k) => t.paint(0, k, x));
  t.ctx.setHover(0, 1, true);
  t.ids["trnav-next"].fire("click");
  t.ids["trnav-next"].fire("click");
  t.ids["trnav-next"].fire("click");
  t.ids["trnav-pin"].fire("click");
  t.calls.hover = [];
  t.open([["a", "b", "c"]]);
  assert.deepEqual(
    t.calls.hover,
    [
      [0, 2, false],
      [0, 1, true],
    ],
    "the pin's page wipe took the PDF-owned highlight with it",
  );
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

// The real PDF highlight layers under a rebuilt list. The pointer owns a sentence only through a
// live text layer: a layer torn down without a mouseleave (another paper opening, a zoom, a page
// scrolled far away) takes its sentence with it, while a same-paper rebuild keeps it drawn.
async function hoverOwners() {
  const paintAll = (t, texts) => texts.forEach((page, i) => page.forEach((x, k) => t.paint(i, k, "번역 " + x)));
  const pinAt = (t, n) => {
    for (let j = 0; j < n; j++) t.ids["trnav-next"].fire("click");
    t.ids["trnav-pin"].fire("click");
  };
  const bar = (x) => [x, x];  // a rect's ring and its fill

  // Another paper reuses the old one's sentence numbers: the old pointer owns nothing in it.
  for (const pinK of [0, 1]) {
    const t = setup({ real: true });
    const a = t.pdfSource();
    t.sources.A = async () => a.source;
    await t.ctx.openDoc({ doc_id: "A", num_pages: 1, title: "A" });
    t.shells([["a", "b", "c"]]);
    t.layers();
    paintAll(t, [["a", "b", "c"]]);
    t.pointAt(0, 0, 0);
    assert.deepEqual(t.drawn(0), bar("0px"));
    const b = t.pdfSource();
    t.sources.B = async () => b.source;
    await t.ctx.openDoc({ doc_id: "B", num_pages: 1, title: "B" });
    t.shells([["x", "y", "z"]]);
    t.layers();
    paintAll(t, [["x", "y", "z"]]);
    pinAt(t, pinK + 1);
    assert.deepEqual(t.drawn(0), bar(pinK * 10 + "px"));
    t.open([["x", "y", "z"]]);
    assert.deepEqual(t.drawn(0), [], `the old paper's pointer kept B's sentence ${pinK} drawn`);
    paintAll(t, [["x", "y", "z"]]);
    assert.ok(!t.spans().some((x) => x.cls.has("hl")));
    // The pointer then reaching B's sentence 0 draws it, as on any first move.
    t.pointAt(0, 0, 0);
    assert.deepEqual(t.drawn(0), bar("0px"), "the old paper's pointer swallowed the first move over B");
  }

  // The pointer on sentence 1 of a live page: a keyboard pin on it or on a neighbour goes with
  // the list, and the pointer's bar is what the page shows afterwards.
  for (const pinK of [1, 2]) {
    const t = setup({ real: true });
    const texts = [["a", "b", "c"]];
    t.open(texts);
    t.layers();
    paintAll(t, texts);
    t.pointAt(0, 0, 1);
    pinAt(t, pinK + 1);
    assert.deepEqual(t.drawn(0), bar(pinK * 10 + "px"));
    t.open(texts);
    assert.deepEqual(t.drawn(0), bar("10px"), `a pin on sentence ${pinK} took the pointer's bar`);
    assert.equal(t.ids["trnav-pin"].getAttribute("aria-pressed"), "false");
  }

  // The pointer on page 1 over the continuation of page 0's last sentence; a keyboard pin on
  // page 1's own sentence shares only that continuation page. Both halves are drawn after.
  {
    const t = setup({ real: true });
    const texts = [
      ["a", "b"],
      ["c", "d"],
    ];
    t.open(texts);
    t.layers({ next: true });
    paintAll(t, texts);
    t.pointAt(1, 0, 1);
    assert.deepEqual([t.drawn(0), t.drawn(1)], [bar("10px"), bar("50px")]);
    pinAt(t, 3);
    assert.deepEqual([t.drawn(0), t.drawn(1)], [bar("10px"), bar("0px")]);
    t.open(texts);
    assert.deepEqual([t.drawn(0), t.drawn(1)], [bar("10px"), bar("50px")], "the continuation's half was lost");
    // Page 0's text layer going leaves the pointer on page 1 with its sentence; page 1's takes it.
    t.ctx.stopRender(t.S.pages[0], true);
    assert.deepEqual([t.drawn(0), t.drawn(1)], [bar("10px"), bar("50px")]);
    t.ctx.stopRender(t.S.pages[1], true);
    assert.deepEqual([t.drawn(0), t.drawn(1)], [[], []], "a removed layer's pointer kept its sentence");
  }

  // No pointer on the PDF: a keyboard pin clears with Escape, and with a rebuilt list.
  {
    const t = setup({ real: true });
    const texts = [["a", "b", "c"]];
    t.open(texts);
    t.layers();
    paintAll(t, texts);
    pinAt(t, 2);
    assert.deepEqual(t.drawn(0), bar("10px"));
    t.escape();
    assert.deepEqual(t.drawn(0), []);
    t.ids["trnav-pin"].fire("click");
    assert.deepEqual(t.drawn(0), bar("10px"));
    t.open(texts);
    assert.deepEqual(t.drawn(0), [], "a rebuilt list left the keyboard pin drawn");
  }

  // A PDF hover over another sentence takes the page's one layer from the pin; when the pointer
  // leaves, the pinned sentence is drawn again. Without a pin, or once it is released, nothing is.
  {
    const t = setup({ real: true });
    const texts = [["a", "b", "c"], ["d"]];
    t.open(texts);
    t.layers({ next: true });
    paintAll(t, texts);
    const leave = (p) => t.S.pages[p].textEl.fire("mouseleave");
    const hl = () => t.spans().filter((x) => x.cls.has("hl")).map((x) => [x.dataset.page, x.dataset.i]);
    t.pointAt(0, 0, 1);
    leave(0);
    assert.deepEqual([t.drawn(0), hl()], [[], []], "a hover with no pin left a bar behind");
    pinAt(t, 2);
    const pinned = t.S.trSel;
    assert.deepEqual(t.drawn(0), bar("10px"));
    t.pointAt(0, 0, 2);
    assert.deepEqual([t.drawn(0), t.drawn(1)], [bar("20px"), bar("50px")], "the hover is drawn as before");
    leave(0);
    assert.deepEqual([t.drawn(0), t.drawn(1)], [bar("10px"), []], "the pin was not drawn again");
    assert.deepEqual(hl(), [[0, 1]]);
    assert.equal(t.S.trSel, pinned);
    assert.ok(pinned.cls.has("pinned"));
    assert.equal(t.ids["trnav-pin"].getAttribute("aria-pressed"), "true");
    // The pointer leaving the pinned sentence itself.
    t.pointAt(0, 0, 1);
    leave(0);
    assert.deepEqual([t.drawn(0), hl()], [bar("10px"), [[0, 1]]], "leaving the pinned sentence cleared it");
    // A pin across the page break; the hover on the next page takes its second half there.
    pinAt(t, 1);
    assert.deepEqual([t.drawn(0), t.drawn(1)], [bar("20px"), bar("50px")]);
    t.pointAt(1, 1, 0);
    assert.deepEqual([t.drawn(0), t.drawn(1)], [bar("20px"), bar("0px")]);
    leave(1);
    assert.deepEqual([t.drawn(0), t.drawn(1)], [bar("20px"), bar("50px")], "the pin's second half was lost");
    // Released with Escape, or with a rebuilt list, while the pointer is on the PDF.
    t.pointAt(0, 0, 0);
    t.escape();
    leave(0);
    assert.deepEqual([t.drawn(0), t.drawn(1), hl()], [[], [], []], "a released pin came back");
    t.ids["trnav-pin"].fire("click");
    t.pointAt(0, 0, 0);
    t.open(texts);
    paintAll(t, texts);
    leave(0);
    assert.deepEqual([t.drawn(0), t.drawn(1), hl()], [[], [], []], "a rebuilt list's pin came back");
  }
}

lifecycle()
  .then(autotrToggle)
  .then(hoverOwners)
  .then(() => console.log("sentence navigator ok"))
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  });
