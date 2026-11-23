"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const src = fs.readFileSync("web/app.js", "utf8");
const pick = (name, end) => src.slice(src.indexOf(name), src.indexOf(end, src.indexOf(name)));
const line = (name) => src.slice(src.indexOf(name), src.indexOf("\n", src.indexOf(name)));
const code = [
  line("class RateLimited"), line("class AuthRequired"), line("const aiError"),
  pick("async function streamTranslate(", "\n}\n") + "\n}\n",
  pick("function fillSource(", "\n}\n") + "\n}\n",
  pick("async function translateBatch(", "\n}\n") + "\n}\n",
].join("\n");

(async () => {
  let calls = 0;
  const page = { segs: [{ text: "S0" }, { text: "S1" }], trBuf: [], spanByK: [] };
  const context = {
    S: { docId: "d", trToken: 1, pages: [page], rateLimited: null },
    lang: () => "Korean", sleep: async () => {}, paintFrontier: () => {}, showRateLimit: () => {},
    TextDecoder, JSON, Error,
    fetch: async () => {
      calls++;
      return new Response('{"i":0,"tr":"가"}\n{"error":"limit","rate_limited":true}\n');
    },
  };
  vm.createContext(context);
  vm.runInContext(code, context);
  await context.translateBatch(0, { start: 0, texts: ["S0", "S1"] }, false, 1);
  assert.equal(calls, 1, "a rate-limited batch must not be retried");
  assert.deepEqual(page.trBuf, ["가", "S1"]);
  assert.equal(context.S.rateLimited, 1);

  // A signed-out AI Backend stops the run the same way and asks the user to sign in.
  let asked = 0;
  calls = 0;
  const next = { segs: [{ text: "T0" }], trBuf: [], spanByK: [] };
  Object.assign(context.S, { trToken: 2, pages: [next], rateLimited: null });
  context.showAuthRequired = () => { asked++; };
  context.fetch = async () => {
    calls++;
    return new Response('{"error":"sign in","rate_limited":false,"auth_required":true}\n');
  };
  await context.translateBatch(0, { start: 0, texts: ["T0"] }, false, 2);
  assert.equal(calls, 1, "a signed-out batch must not be retried");
  assert.equal(asked, 1);
  assert.deepEqual(next.trBuf, ["T0"]);
  assert.equal(context.S.rateLimited, 2);
  console.log("rate-limit frontend check PASS");
})().catch((e) => { console.error(e); process.exitCode = 1; });
