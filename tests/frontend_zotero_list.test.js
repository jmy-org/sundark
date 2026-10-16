"use strict";
// Zotero list: a slower, superseded response must not overwrite the list, nothing may land in
// the Folder view, and paging follows the server's "next" offset.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const src = fs.readFileSync("web/app.js", "utf8");
const a = src.indexOf("let libSource = ");
const b = src.indexOf("async function openFromZotero(");
assert.ok(a >= 0 && b > a);

function el() {
  const e = {
    children: [], value: "", textContent: "", title: "", className: "", listeners: {},
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    set innerHTML(v) { this.children = []; this._html = v; }, get innerHTML() { return this._html || ""; },
    appendChild(c) { this.children.push(c); c.parent = this; return c; },
    querySelector(sel) { return sel === "li.more" ? this.children.find((c) => c.className === "more") || null : null; },
    addEventListener(t, f) { this.listeners[t] = f; },
    remove() { if (this.parent) this.parent.children = this.parent.children.filter((c) => c !== this); },
  };
  return e;
}
const els = {};
const $ = (id) => (els[id] = els[id] || el());
let pending = [];
const ctx = {
  $, localStorage: { getItem: () => null, setItem() {} }, esc: (s) => s, setTimeout, clearTimeout,
  URLSearchParams, document: { createElement: () => el() }, openFromZotero() {}, postJSON() {},
  loadLibrary() {}, console,
  fetch: (url) => new Promise((resolve) => pending.push({ url, resolve })),
};
vm.createContext(ctx);
vm.runInContext(src.slice(a, b) + "\nthis.__set = (k, v) => { eval(k + ' = v'); }; this.__get = (k) => eval(k);", ctx);
const reply = (p, body) => p.resolve({ ok: true, json: async () => body });
const item = (k) => ({ key: k, title: k, authors: [], year: "", doi: null, pdfs: [{ key: k + "-pdf", name: "x.pdf" }] });
const tick = () => new Promise((r) => setTimeout(r, 0));

(async () => {
  ctx.__set("libSource", "zotero");
  ctx.__set("zotCollectionsLoaded", true);
  // 1) query "a" is slow, query "b" answers first; the late "a" reply must be ignored
  $("zot-q").value = "a"; ctx.loadZotero();
  $("zot-q").value = "b"; ctx.loadZotero();
  await tick();
  const [first, second] = pending; pending = [];
  reply(second, { total: 1, next: 1, items: [item("B")] }); await tick(); await tick();
  reply(first, { total: 1, next: 1, items: [item("A")] }); await tick(); await tick();
  assert.deepEqual($("paperlist").children.map((c) => c.innerHTML.slice(0, 1)), ["B"], "late reply ignored");

  // 2) switching to Folder while a Zotero request is in flight leaves the list alone
  ctx.loadZotero(); await tick();
  const inflight = pending.pop();
  ctx.__set("libSource", "folder");
  $("paperlist").innerHTML = "folder view";
  reply(inflight, { total: 1, next: 1, items: [item("Z")] }); await tick(); await tick();
  assert.equal($("paperlist").children.length, 0, "no Zotero rows in the Folder view");

  // 3) paging uses "next": 50 raw entries consumed though only 1 item was kept
  ctx.__set("libSource", "zotero");
  ctx.loadZotero(); await tick();
  reply(pending.pop(), { total: 120, next: 50, items: [item("C")] }); await tick(); await tick();
  const more = $("paperlist").children.find((c) => c.className === "more");
  assert.ok(more, "load-more row shown");
  more.listeners.click(); await tick();
  assert.match(pending.pop().url, /start=50/, "next page starts at the server's offset");
  // 4) a page of skipped notes/attachments must not hide later papers.
  ctx.loadZotero(); await tick();
  reply(pending.pop(), { total: 120, next: 50, items: [] }); await tick(); await tick();
  let emptyMore = $("paperlist").children.find((c) => c.className === "more");
  assert.ok(emptyMore, "empty first page still offers the next page");
  assert.doesNotMatch($("paperlist").innerHTML, /No matching/, "not empty until all pages are exhausted");
  emptyMore.listeners.click(); await tick();
  const later = pending.pop();
  assert.match(later.url, /start=50/);
  reply(later, { total: 120, next: 100, items: [] }); await tick(); await tick();
  emptyMore = $("paperlist").children.find((c) => c.className === "more");
  assert.ok(emptyMore, "consecutive empty pages remain reachable");
  emptyMore.listeners.click(); await tick();
  const last = pending.pop();
  assert.match(last.url, /start=100/);
  reply(last, { total: 120, next: 120, items: [item("D")] }); await tick(); await tick();
  assert.equal($("paperlist").children.length, 1);
  assert.match($("paperlist").children[0].innerHTML, /^D/);

  // 5) exhausting only skipped entries shows the empty state, including later pages.
  ctx.loadZotero(); await tick();
  reply(pending.pop(), { total: 60, next: 50, items: [] }); await tick(); await tick();
  $("paperlist").children[0].listeners.click(); await tick();
  reply(pending.pop(), { total: 60, next: 60, items: [] }); await tick(); await tick();
  assert.match($("paperlist").innerHTML, /No matching Zotero items/);
  assert.equal($("paperlist").children.length, 0);

  ctx.loadZotero(); await tick();
  reply(pending.pop(), { total: 0, next: 0, items: [] }); await tick(); await tick();
  assert.match($("paperlist").innerHTML, /No matching Zotero items/);

  // 6) a final skipped-only page keeps already displayed papers.
  ctx.loadZotero(); await tick();
  reply(pending.pop(), { total: 60, next: 50, items: [item("E")] }); await tick(); await tick();
  $("paperlist").children[1].listeners.click(); await tick();
  reply(pending.pop(), { total: 60, next: 60, items: [] }); await tick(); await tick();
  assert.equal($("paperlist").children.length, 1);
  assert.match($("paperlist").children[0].innerHTML, /^E/);
  assert.doesNotMatch($("paperlist").innerHTML, /No matching/);
  console.log("zotero list PASS");
})().catch((e) => { console.error(e); process.exitCode = 1; });
