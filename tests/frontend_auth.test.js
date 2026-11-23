"use strict";
// A signed-out Claude Code gets a sign-in button when its CLI can say whether it is signed in;
// an older CLI (signed_in null) and other AI Backends get the steps in text.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const src = fs.readFileSync("web/app.js", "utf8");
const fn = (name) => { const i = src.indexOf(name); assert.ok(i >= 0, name); return src.slice(i, src.indexOf("\n}\n", i) + 3); };
const line = (name) => { const i = src.indexOf(name); assert.ok(i >= 0, name); return src.slice(i, src.indexOf("\n", i)); };
const code = [line("const CLAUDE_TERMINAL_LOGIN"), fn("function showAuthRequired("), fn("function claudeLoginButton(")].join("\n");

const banner = {
  text: "", kids: [], shown: false,
  get textContent() { return this.text; },
  set textContent(t) { this.text = t; this.kids = []; },
  appendChild(el) { this.kids.push(el); },
};
const context = {
  S: { aiConfig: null },
  $: () => banner,
  show: (el) => { el.shown = true; },
  signInClaude: () => {},
  document: { createElement: (tag) => ({ tag, addEventListener(type, f) { this.on = [type, f]; } }) },
};
vm.createContext(context);
vm.runInContext(code, context);
const config = (backend, signedIn) => ({
  backend, backends: [{ id: "claude", label: "Claude Code", signed_in: signedIn }, { id: "hermes", label: "Hermes", signed_in: null }],
});

context.S.aiConfig = config("claude", false);
context.showAuthRequired();
assert.ok(banner.shown);
assert.equal(banner.kids.length, 1, "a sign-in button");
assert.equal(banner.kids[0].tag, "button");
assert.deepEqual(banner.kids[0].on, ["click", context.signInClaude]);

context.S.aiConfig = config("claude", null);
context.showAuthRequired();
assert.equal(banner.kids.length, 0, "an older CLI has no sign-in command");
assert.match(banner.textContent, /\/login/);

context.S.aiConfig = config("hermes", null);
context.showAuthRequired();
assert.equal(banner.kids.length, 0);
assert.match(banner.textContent, /^Hermes /);
console.log("auth frontend check PASS");
