"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const src = fs.readFileSync("web/app.js", "utf8");
function fn(name) {
  const start = src.indexOf(`async function ${name}(`);
  return src.slice(start, src.indexOf("\n}\n", start) + 3);
}
const escStart = src.indexOf("function esc(");
const esc = src.slice(escStart, src.indexOf("\n", escStart));
(async () => {
  for (const name of ["loadLibrary", "genSummary", "loadAnatomy"]) {
    const box = { innerHTML: "" },
      message = '<img src=x onerror="attack()">';
    const fail = async () => {
      throw new Error(message);
    };
    const ctx = {
      S: { docId: "A", openGeneration: 1 },
      $: () => box,
      folderGen: 0,
      libSource: "folder",
      fetch: fail,
      postJSON: fail,
      lang: () => "ko",
      updateReviewBtn() {},
      show() {},
      hide() {},
    };
    vm.createContext(ctx);
    vm.runInContext(esc + "\n" + fn(name), ctx);
    await ctx[name]();
    assert.ok(
      box.innerHTML.includes("&lt;img src=x onerror=&quot;attack()&quot;&gt;"),
      `${name}: ${box.innerHTML}`,
    );
    assert.ok(!box.innerHTML.includes(message));
  }
  console.log("Library, summary and anatomy error paths escape untrusted HTML PASS");
  let exportReview;
  const button = {
    textContent: "Review",
    disabled: false,
    addEventListener(_event, callback) {
      exportReview = callback;
    },
  };
  const error = { textContent: "old failure", hidden: false };
  const message = '<img src=x onerror="attack()">';
  const context = {
    S: { docId: "A" },
    $: (id) => (id === "export-review" ? button : error),
    hide: (element) => {
      element.hidden = true;
    },
    show: (element) => {
      element.hidden = false;
    },
    readerTransport: {
      assertDownloadSupported: async () => {
        throw new Error(message);
      },
    },
    fetch: async () => {
      throw new Error("Unsupported hosts must not generate a review");
    },
    alert: () => {
      throw new Error("Sandbox modals are not available");
    },
  };
  vm.createContext(context);
  const start = src.indexOf('$("export-review").addEventListener("click"');
  vm.runInContext(src.slice(start, src.indexOf("\n});", start) + 4), context);
  await exportReview();
  assert.equal(error.hidden, false);
  assert.equal(error.textContent, "리뷰 생성 실패: " + message);
  assert.equal(button.disabled, false);
  assert.equal(button.textContent, "Review");
  assert.match(fs.readFileSync("web/index.html", "utf8"), /id="review-error"[^>]*role="alert"/);
  console.log("Review errors remain visible without sandbox modal permissions PASS");
})().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
