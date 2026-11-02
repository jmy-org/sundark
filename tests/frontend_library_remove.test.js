"use strict";
// Folder Library: each paper has a remove button. It asks first, posts the paper's path, reloads
// the list, and never opens the paper it sits on. A failure is shown in a dialog, not in the
// title bar (which names the open paper), and the list still reloads.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const src = fs.readFileSync("web/app.js", "utf8");
const a = src.indexOf("async function loadLibrary()");
const b = src.indexOf("async function openFromLibrary(");
assert.ok(a >= 0 && b > a);

function el() {
  return {
    children: [], textContent: "", title: "", className: "", type: "", attrs: {}, listeners: {},
    classList: { add() {}, remove() {} },
    set innerHTML(v) { this.children = []; this._html = v; }, get innerHTML() { return this._html || ""; },
    appendChild(c) { this.children.push(c); c.parent = this; return c; },
    setAttribute(k, v) { this.attrs[k] = v; },
    addEventListener(t, f) { this.listeners[t] = f; },
  };
}
const els = {};
const calls = { fetch: 0, post: [], open: [], title: [], alert: [] };
let answer = false;
const ctx = {
  $: (id) => (els[id] = els[id] || el()),
  esc: (s) => s, fmtSize: (n) => n + " B", console,
  document: { createElement: () => el() },
  confirm: () => answer,
  alert: (m) => calls.alert.push(m),
  fetch: async () => {
    calls.fetch += 1;
    return { json: async () => ({ dir: "/lib", papers: [{ rel: "sub/a.pdf", name: "A paper", file: "a.pdf", size: 1 }] }) };
  },
  postJSON: async (url, body) => { calls.post.push([url, body]); return { moved_to: "/trash/sub/a.pdf" }; },
  openFromLibrary: (rel) => calls.open.push(rel),
  setTitle: (t) => calls.title.push(t),
  loadZotero() {},
};
vm.createContext(ctx);
vm.runInContext("var libSource = 'folder', folderGen = 0, zotCollectionsLoaded = false;\n" + src.slice(a, b), ctx);

// the handler does not return the removal's promise: let it settle after each click
const settle = () => new Promise((r) => setTimeout(r, 0));

(async () => {
  await ctx.loadLibrary();
  const li = els.paperlist.children[0];
  const rm = li.children.find((c) => c.className === "lib-remove");
  assert.ok(rm, "each folder paper has a remove button");
  assert.equal(rm.type, "button");
  assert.match(rm.attrs["aria-label"], /Remove A paper/);
  // a click bubbles from the button to its row unless the button stops it
  const click = async () => {
    let stopped = false;
    rm.listeners.click({ stopPropagation: () => { stopped = true; } });
    if (!stopped) li.listeners.click();
    await settle();
  };

  answer = false; // cancelled: nothing is sent
  await click();
  assert.deepEqual(calls.post, []);
  assert.equal(calls.fetch, 1);

  answer = true;
  await click();
  // the body is built inside the vm context, so compare by value
  assert.equal(JSON.stringify(calls.post), JSON.stringify([["/api/papers/remove", { rel: "sub/a.pdf" }]]));
  assert.equal(calls.fetch, 2, "the list reloads after a removal");
  assert.deepEqual(calls.open, [], "removing never opens the paper");

  ctx.postJSON = async () => { throw new Error("Paper not found"); };
  await click();
  assert.deepEqual(calls.alert, ["Remove failed: Paper not found"]);
  assert.deepEqual(calls.title, [], "the title bar keeps naming the open paper");
  assert.equal(calls.fetch, 3, "the list reloads after a failure too, dropping a stale row");
  assert.deepEqual(calls.open, []);
  console.log("ok");
})().catch((err) => { console.error(err); process.exit(1); });
