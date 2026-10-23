"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const src = fs.readFileSync("web/app.js", "utf8");
const code = src.slice(
  src.indexOf("const uiStorage ="),
  src.indexOf("pdfjsLib.GlobalWorkerOptions"),
);
function fixture(descriptor) {
  const ctx = {};
  Object.defineProperty(ctx, "localStorage", descriptor);
  vm.createContext(ctx);
  vm.runInContext(code + "\nthis.preferences = uiStorage;", ctx);
  return ctx.preferences;
}
const denied = () => {
  throw new Error("SecurityError: sandbox storage denied");
};
for (const descriptor of [
  { get: denied },
  { value: { getItem: denied, setItem: denied } },
  { value: { getItem: () => "old persistent value", setItem: denied } },
]) {
  const prefs = fixture(descriptor);
  for (const key of ["libSource", "trScale", "pdfZoom", "c1", "c3"]) {
    assert.doesNotThrow(() => prefs.getItem(key));
    prefs.setItem(key, "session value");
    assert.equal(prefs.getItem(key), "session value");
  }
  assert.equal(fixture({ get: denied }).getItem("trScale"), null, "fallback is per reader session");
}
const persisted = new Map([["trScale", "1.3"]]);
const native = {
  getItem: (key) => persisted.get(key) ?? null,
  setItem: (key, value) => persisted.set(key, value),
};
const prefs = fixture({ value: native });
assert.equal(prefs.getItem("trScale"), "1.3");
prefs.setItem("trScale", 1.5);
assert.equal(persisted.get("trScale"), "1.5");
assert.equal(
  fixture({ value: native }).getItem("trScale"),
  "1.5",
  "HTTP preferences persist across reader loads",
);
// Every preference read/write outside the guarded helper must use it.
assert.equal((src.match(/localStorage/g) || []).length, 2);
assert.ok(!src.slice(src.indexOf("pdfjsLib.GlobalWorkerOptions")).includes("localStorage"));
console.log("Denied Storage getter/methods, per-preference memory and native persistence PASS");
