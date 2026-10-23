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
