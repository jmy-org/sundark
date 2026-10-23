"use strict";
// The upload input is emptied once an upload settles, so picking the same file again is a
// new selection and fires `change` (WHATWG: setting a file input's value to "" empties its
// selected files; reopening the chooser on an unchanged selection fires `cancel` instead).
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const src = fs.readFileSync("web/app.js", "utf8");
const start = src.indexOf('$("file").addEventListener("change"');
assert.ok(start >= 0, "upload change handler exists");
const handlerSrc = src.slice(start, src.indexOf("\n});\n", start) + 5);

function deferred() {
  let resolve, reject;
  const promise = new Promise((r, j) => {
    resolve = r;
    reject = j;
  });
  return { promise, resolve, reject };
}

function setup() {
  const input = { value: "", files: [], handler: null };
  const calls = { posts: [], opened: [], library: 0, titles: [] };
  let gate = null;
  const ctx = {
    $: (id) => {
      assert.equal(id, "file");
      return { addEventListener: (type, fn) => ((input.type = type), (input.handler = fn)) };
    },
    document: { querySelectorAll: () => [] },
    FormData: class {
      constructor() {
        this.entries = [];
      }
      append(k, v) {
        this.entries.push([k, v]);
      }
    },
    setTitle: (t) => calls.titles.push(t),
    postForm: (url, fd) => {
      calls.posts.push([url, fd.entries]);
      return gate.promise;
    },
    openDoc: async (meta) => calls.opened.push(meta),
    loadLibrary: () => calls.library++,
  };
  vm.createContext(ctx);
  vm.runInContext(handlerSrc, ctx);
  assert.equal(input.type, "change");
  const pick = (file) => {
    gate = deferred();
    input.files = file ? [file] : [];
    input.value = file ? "C:\\fakepath\\" + file.name : "";
    const run = input.handler({ target: input });
    return { run, gate };
  };
  return { input, calls, pick };
}

async function main() {
  const file = { name: "paper.pdf" };

  // Success: the value is kept while the upload runs, then emptied; the same file uploads again.
  {
    const { input, calls, pick } = setup();
    const first = pick(file);
    await Promise.resolve();
    assert.equal(input.value, "C:\\fakepath\\paper.pdf", "value kept while uploading");
    first.gate.resolve({ doc_id: "d1" });
    await first.run;
    assert.equal(input.value, "", "value emptied after a successful upload");
    assert.deepEqual(calls.opened, [{ doc_id: "d1" }]);
    assert.equal(calls.library, 1);
    const second = pick(file);
    second.gate.resolve({ doc_id: "d1" });
    await second.run;
    assert.equal(calls.posts.length, 2, "one request per pick");
    assert.deepEqual(calls.posts[1], ["/api/upload", [["file", file]]]);
    assert.equal(input.value, "");
  }

  // Failure, including an oversize rejection (the transport throws a 413 into postForm).
  for (const err of [
    new Error("Server error"),
    Object.assign(new Error("Plugin PDF uploads are limited to 20 MiB."), { status: 413 }),
  ]) {
    const { input, calls, pick } = setup();
    const attempt = pick(file);
    attempt.gate.reject(err);
    await attempt.run;
    assert.equal(input.value, "", "value emptied after a failed upload");
    assert.deepEqual(calls.titles, ["Uploading…", "Upload failed: " + err.message]);
    assert.equal(calls.opened.length, 0);
    assert.equal(calls.library, 0);
    assert.equal(calls.posts.length, 1);
  }

  // No file (an empty selection): no request, no title change.
  {
    const { calls, pick } = setup();
    await pick(null).run;
    assert.equal(calls.posts.length, 0);
    assert.deepEqual(calls.titles, []);
  }
  console.log("upload repick PASS");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
