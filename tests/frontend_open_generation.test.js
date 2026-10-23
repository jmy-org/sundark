"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const src = fs.readFileSync("web/app.js", "utf8");
function fn(name) {
  const start = src.indexOf(`async function ${name}(`);
  return src.slice(start, src.indexOf("\n}\n", start) + 3);
}
function deferred() {
  let resolve, reject;
  const promise = new Promise((r, j) => {
    resolve = r;
    reject = j;
  });
  return { promise, resolve, reject };
}
async function scenario(stage, rejected = false) {
  const gate = deferred(),
    elements = new Map(),
    transfers = [],
    loaded = [],
    shells = [];
  let aCalls = 0,
    cancelled = 0;
  const element = () => ({
    innerHTML: "",
    style: {},
    dataset: {},
    classList: { add() {}, remove() {} },
    appendChild(el) {
      shells.push(el);
    },
  });
  const S = { openGeneration: 0, trToken: 0, pages: [], aiConfig: null };
  const pdf = (id) => ({
    id,
    async getPage() {
      if (
        id === "A" &&
        ((stage === "first" && ++aCalls === 1) || (stage === "shell" && ++aCalls === 2))
      )
        await gate.promise;
      return { getViewport: () => ({ width: id === "A" ? 111 : 222, height: 333 }) };
    },
  });
  const ctx = {
    S,
    AbortController,
    Promise,
    fetch: async (url) => {
      assert.equal(url, "/api/layout/B/0");
      assert.equal(S.pdf.id, "B");
      return { json: async () => ({ paper: "B", words: [], sentences: [] }) };
    },
    $: (id) => {
      if (!elements.has(id)) elements.set(id, element());
      return elements.get(id);
    },
    readerTransport: {
      async pdfSource(id, options) {
        transfers.push(options.signal);
        if (id === "A" && stage === "transfer") await gate.promise;
        return id;
      },
    },
    pdfjsLib: {
      getDocument(id) {
        loaded.push(id);
        return {
          promise:
            id === "A" && stage === "loading"
              ? gate.promise.then(() => pdf(id))
              : Promise.resolve(pdf(id)),
          destroy() {
            cancelled++;
            return Promise.resolve();
          },
        };
      },
    },
    document: { createElement: element },
    setTitle() {},
    showPane() {},
    updateReviewBtn() {},
    zoomScale: () => 1,
    showZoom() {},
    showPageNum() {},
    resetObserver() {
      S.pageObs = S.dropObs = { observe() {}, disconnect() {} };
    },
    stopRender(P) {
      P.gen++;
    },
    buildTrShells() {
      assert.equal(S.docId, S.pdf.id);
      assert.equal(S.pages[0].w1, 222);
    },
    waitLayout() {
      assert.equal(S.docId, S.pdf.id);
      return Promise.resolve();
    },
    sleep: () => Promise.resolve(),
  };
  vm.createContext(ctx);
  const layoutStart = src.indexOf("function ensureLayout(");
  vm.runInContext(
    fn("openDoc") +
      fn("buildPageShells") +
      src.slice(layoutStart, src.indexOf("\n}\n", layoutStart) + 3),
    ctx,
  );
  const a = ctx.openDoc({ doc_id: "A", num_pages: 1 });
  for (let i = 0; i < 12; i++) await Promise.resolve();
  const b = ctx.openDoc({ doc_id: "B", num_pages: 1 });
  await b;
  if (rejected) gate.reject(new Error("obsolete operation cancelled"));
  else gate.resolve();
  await a;
  await ctx.ensureLayout(0);
  assert.equal(S.pages[0].layout.paper, "B");
  assert.equal(S.docId, "B");
  assert.equal(S.pdf.id, "B");
  assert.equal(S.pages.length, 1);
  assert.equal(S.pages[0].w1, 222);
  assert.equal(transfers[0].aborted, true);
  if (stage === "transfer") assert.deepEqual(loaded, ["B"]);
  else assert.equal(cancelled, 1);
}
(async () => {
  for (const stage of ["transfer", "loading", "first", "shell"]) {
    await scenario(stage);
    await scenario(stage, true);
  }
  console.log("Deferred document transfer/loading/page/shell fences PASS");
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});

// Background panels launched by an open must not paint into the next paper.
(async () => {
  for (const name of ["genSummary", "loadAnatomy", "loadChat"]) {
    const gate = deferred(),
      box = { innerHTML: "" },
      S = { openGeneration: 1, docId: "A" };
    const ctx = {
      S,
      $: () => box,
      lang: () => "ko",
      postJSON: () => gate.promise,
      fetch: async () => ({ json: () => gate.promise }),
      updateReviewBtn() {},
      mdMath() {
        throw new Error("stale summary rendered");
      },
      renderMath() {},
      renderAnatomy() {
        throw new Error("stale anatomy rendered");
      },
      addMsg() {
        throw new Error("stale chat rendered");
      },
    };
    vm.createContext(ctx);
    vm.runInContext(fn(name), ctx);
    const pending = ctx[name]();
    S.openGeneration++;
    S.docId = "B";
    S.anatomyLoading = true;
    box.innerHTML = "B";
    gate.resolve({ summary: "A", turns: [{ text: "A" }] });
    await pending;
    assert.equal(box.innerHTML, "B");
    assert.equal(S.anatomyLoading, true);
  }
  console.log("Stale summary/anatomy/chat paints fenced PASS");
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});

// A failed open must not leave the full-screen loading overlay over the library, and a stale
// failure must not clear the overlay of the paper opened after it.
(async () => {
  const classes = (hidden) => {
    const set = new Set(hidden ? ["hidden"] : []);
    return { add: (c) => set.add(c), remove: (c) => set.delete(c), contains: (c) => set.has(c) };
  };
  async function run(stage, { stale = false } = {}) {
    const elements = new Map(),
      gateB = deferred(),
      fail = { A: true };
    const element = (id) => ({
      innerHTML: "",
      style: {},
      dataset: {},
      classList: classes(["prep-overlay", "pdfcol", "aipanel"].includes(id)),
      appendChild() {},
    });
    const S = { openGeneration: 0, trToken: 0, pages: [], aiConfig: null };
    let pane = "library";
    const broken = (id, at) => fail[id] && stage === at;
    const pdf = (id) => ({
      id,
      async getPage(n) {
        if (id === "B") await gateB.promise;
        if (broken(id, "first") || (n === 1 && broken(id, "shell") && this.firstDone))
          throw new Error("page failed");
        this.firstDone = true;
        return { getViewport: () => ({ width: 100, height: 100 }) };
      },
    });
    const ctx = {
      S,
      AbortController,
      Promise,
      $: (id) => {
        if (!elements.has(id)) elements.set(id, element(id));
        return elements.get(id);
      },
      readerTransport: {
        async pdfSource(id) {
          if (broken(id, "transfer")) throw new Error("bridge lost");
          return id;
        },
      },
      pdfjsLib: {
        getDocument(id) {
          return {
            promise: broken(id, "loading")
              ? Promise.reject(new Error("bad chunk"))
              : Promise.resolve(pdf(id)),
            destroy: () => Promise.resolve(),
          };
        },
      },
      document: { createElement: () => element() },
      setTitle() {},
      showPane(name) {
        pane = name;
      },
      updateReviewBtn() {},
      zoomScale: () => 1,
      showZoom() {},
      showPageNum() {},
      resetObserver() {
        S.pageObs = S.dropObs = { observe() {}, disconnect() {} };
      },
      stopRender() {},
      buildTrShells() {},
      waitLayout: () => Promise.resolve(),
      sleep: () => Promise.resolve(),
    };
    vm.createContext(ctx);
    vm.runInContext(fn("openDoc") + fn("buildPageShells"), ctx);
    const hidden = (id) => ctx.$(id).classList.contains("hidden");
    const a = ctx.openDoc({ doc_id: "A", num_pages: 1 });
    if (stale) {
      // B opens while A is still in flight, then A fails: B's overlay must stay up.
      const b = ctx.openDoc({ doc_id: "B", num_pages: 1 });
      const settled = await a.then(
        () => null,
        (e) => e,
      );
      assert.equal(hidden("prep-overlay"), false, stage + ": stale failure cleared the overlay");
      assert.equal(settled, null, stage + ": stale failure surfaced");
      assert.equal(S.docId, "B");
      gateB.resolve();
      await b;
      assert.equal(hidden("prep-overlay"), true);
      return;
    }
    await assert.rejects(a, /bridge lost|bad chunk|page failed/);
    assert.equal(hidden("prep-overlay"), true, stage + ": overlay left over the screen");
    assert.equal(hidden("empty"), false);
    assert.equal(hidden("pdfcol"), true);
    assert.equal(hidden("aipanel"), true);
    assert.equal(pane, "library");
    assert.equal(S.docId, null);
    assert.equal(S.pdf, null);
    assert.equal(S.pages.length, 0);
    // Retrying the same paper (from the library or the host) opens it.
    fail.A = false;
    await ctx.openDoc({ doc_id: "A", num_pages: 1 });
    assert.equal(hidden("prep-overlay"), true);
    assert.equal(hidden("pdfcol"), false);
    assert.equal(S.docId, "A");
    assert.equal(S.pages.length, 1);
  }
  for (const stage of ["transfer", "loading", "first", "shell"]) {
    await run(stage);
    await run(stage, { stale: true });
  }
  console.log("Failed open clears the overlay; stale failures leave it PASS");
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});

// A later page can fail after earlier shells are observed and drawing: the failed open must stop
// those observers and renders, and a callback the old observers had already queued must not touch
// the cleared pages or the pages of the paper opened next.
(async () => {
  const plain = (name) => {
    const start = src.indexOf(`function ${name}(`);
    return src.slice(start, src.indexOf("\n}\n", start) + 3);
  };
  const gate = deferred(),
    renders = [],
    observers = [];
  let failing = true,
    drawn = 0;
  const element = () => ({
    innerHTML: "",
    style: {},
    dataset: {},
    classList: { add() {}, remove() {}, contains: () => false },
    appendChild() {},
    querySelector: () => null,
    insertBefore() {
      drawn++;
    },
    remove() {},
    getContext: () => ({}),
  });
  const elements = new Map();
  const S = { openGeneration: 0, trToken: 0, pages: [], aiConfig: null };
  class IntersectionObserver {
    constructor(callback) {
      this.callback = callback;
      this.targets = new Set();
      observers.push(this);
    }
    observe(el) {
      this.targets.add(el);
    }
    unobserve(el) {
      this.targets.delete(el);
    }
    disconnect() {
      this.targets.clear();
      this.disconnected = true;
    }
    // An entry the browser queued for this observer, delivered now.
    fire(target, isIntersecting) {
      this.callback([{ target, isIntersecting }], this);
    }
  }
  const page = {
    getViewport: () => ({ width: 100, height: 100 }),
    render() {
      const task = deferred();
      const r = {
        promise: task.promise,
        cancel() {
          r.cancelled = true;
          task.reject(new Error("cancelled"));
        },
        finish: task.resolve,
      };
      renders.push(r);
      return r;
    },
  };
  const ctx = {
    S,
    AbortController,
    Promise,
    IntersectionObserver,
    MAX_CANVAS_PX: 2 ** 24,
    window: { devicePixelRatio: 1 },
    $: (id) => {
      if (!elements.has(id)) elements.set(id, element());
      return elements.get(id);
    },
    readerTransport: { pdfSource: async (id) => id },
    pdfjsLib: {
      getDocument: () => ({
        promise: Promise.resolve({
          async getPage(n) {
            if (n === 2 && failing && ++this.calls === 1) {
              await gate.promise;
              throw new Error("page 2 failed");
            }
            return page;
          },
          calls: 0,
        }),
        destroy: () => Promise.resolve(),
      }),
    },
    document: { createElement: element },
    setTitle() {},
    showPane() {},
    updateReviewBtn() {},
    zoomScale: () => 1,
    showZoom() {},
    showPageNum() {},
    buildTrShells() {},
    ensureLayout: () => Promise.resolve(),
    attachPdfHover() {},
    waitLayout: () => Promise.resolve(),
    sleep: () => Promise.resolve(),
  };
  vm.createContext(ctx);
  vm.runInContext(
    fn("openDoc") +
      fn("buildPageShells") +
      fn("ensureRendered") +
      ["resetObserver", "shellOf", "onPageVisible", "onPageFar", "stopRender"].map(plain).join(""),
    ctx,
  );
  const tick = async () => {
    for (let i = 0; i < 12; i++) await Promise.resolve();
  };
  const a = ctx.openDoc({ doc_id: "A", num_pages: 2 });
  await tick();
  // Page 1's shell is built and observed, and its drawing starts, while page 2 is still loading.
  const [visible, far] = observers;
  const shell = S.pages[0].el;
  assert.equal(visible.targets.has(shell) && far.targets.has(shell), true);
  visible.fire(shell, true);
  await tick();
  assert.equal(renders.length, 1);
  gate.resolve();
  await assert.rejects(a, /page 2 failed/);
  assert.equal(visible.disconnected && far.disconnected, true, "page observers left attached");
  assert.equal(renders[0].cancelled, true, "page 1 render left running");
  // Entries the old observers queued before the failure arrive after it.
  far.fire(shell, false);
  visible.fire(shell, true);
  await tick();
  assert.equal(renders.length, 1, "a cleared page started drawing");
  assert.equal(drawn, 0, "a cleared page was drawn");

  // The same paper opens on retry, and the old observers' queued entries leave it alone.
  failing = false;
  await ctx.openDoc({ doc_id: "A", num_pages: 2 });
  assert.equal(S.pages.length, 2);
  const [nextVisible] = observers.slice(2);
  nextVisible.fire(S.pages[0].el, true);
  await tick();
  renders[1].finish();
  await tick();
  assert.equal(drawn, 1);
  const P = S.pages[0],
    gen = P.gen;
  far.fire(shell, false);
  visible.fire(shell, true);
  await tick();
  assert.equal(P.gen, gen, "a stale entry released the new paper's page");
  assert.equal(renders.length, 2);
  console.log("A later page failure stops the earlier pages' observers and renders PASS");
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
