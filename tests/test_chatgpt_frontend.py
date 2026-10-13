import shutil
import subprocess
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


@unittest.skipUnless(shutil.which("node"), "node is only needed for JS checks")
class ChatGPTFrontendTests(unittest.TestCase):
    def test_refresh_preserves_custom_and_edited_models(self):
        script = r"""
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const src = fs.readFileSync("web/app.js", "utf8");
const start = src.indexOf("async function refreshChatGPT()");
const end = src.indexOf("\n}\n", start) + 3;
const code = src.slice(start, end);

async function run(values, edited, modelResponses) {
  const inputs = values.map(([task, value]) => ({
    value,
    dataset: { task, ...(edited.includes(task) ? { edited: "true" } : {}) },
  }));
  const elements = {
    "set-backend": { value: "chatgpt" },
    settings: { open: true },
    "set-models": { querySelectorAll: () => inputs },
    "suggest-chatgpt": { innerHTML: "", appendChild() {} },
  };
  let modelCall = 0;
  const context = {
    S: { aiConfig: { default_models: { chatgpt: { translate: "old-default" } } } },
    chatGPT: { busy: false, generation: 0, initialModels: true },
    $: (id) => elements[id],
    setChatGPTBusy() {}, hide() {}, renderChatGPTStatus() {}, chatGPTError(err) { throw err; },
    getChatGPTJSON: async (path) => path.endsWith("/status")
      ? { ready: true }
      : { models: modelResponses[modelCall++] },
    document: { createElement: () => ({}) },
  };
  vm.createContext(context);
  vm.runInContext(code, context);
  await context.refreshChatGPT();
  const afterFirst = inputs.map((input) => input.value);
  if (modelResponses.length > 1) await context.refreshChatGPT();
  return { afterFirst, afterSecond: inputs.map((input) => input.value) };
}

(async () => {
  const models = [[{ slug: "available-model" }]];
  const custom = await run([["translate", "my-custom-model"]], [], models);
  assert.deepEqual(custom.afterFirst, ["my-custom-model"], "saved custom models must remain selected");

  const fallback = await run([["translate", "old-default"]], [], models);
  assert.deepEqual(fallback.afterFirst, ["available-model"], "an unavailable backend default should fall back");

  const edited = await run([["translate", "old-default"]], ["translate"], models);
  assert.deepEqual(edited.afterFirst, ["old-default"], "an edited value must remain selected");

  const repeated = await run([["translate", "old-default"]], [], [
    [{ slug: "first-model" }], [{ slug: "second-model" }],
  ]);
  assert.deepEqual(repeated.afterFirst, ["first-model"]);
  assert.deepEqual(repeated.afterSecond, ["first-model"], "later refreshes must not replace the fallback");
})().catch((err) => { console.error(err); process.exitCode = 1; });
"""
        result = subprocess.run(
            ["node", "-e", script], cwd=ROOT, capture_output=True, text=True, timeout=30
        )
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)

    def test_busy_state_restores_focus_without_stealing_it(self):
        script = r"""
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const src = fs.readFileSync("web/app.js", "utf8");
const start = src.indexOf("function setChatGPTBusy(");
const end = src.indexOf("\n}\n", start) + 3;
const context = {
  chatGPT: { busy: false, focusReturn: null },
  document: { body: {}, activeElement: null, hasFocus: () => true },
};
const controls = {};
for (const id of ["chatgpt-account", "chatgpt-login", "chatgpt-reconnect", "chatgpt-refresh", "chatgpt-logout"]) {
  let disabled = false;
  controls[id] = {
    isConnected: true,
    classList: { contains: () => false },
    get disabled() { return disabled; },
    set disabled(value) {
      disabled = value;
      if (value && context.document.activeElement === this) context.document.activeElement = context.document.body;
    },
    focusCalls: 0,
    focus() { this.focusCalls++; context.document.activeElement = this; },
  };
}
controls["chatgpt-settings"] = { setAttribute() {} };
context.$ = (id) => controls[id];
vm.createContext(context);
vm.runInContext(src.slice(start, end), context);

const initiating = controls["chatgpt-refresh"];
context.document.activeElement = initiating;
context.setChatGPTBusy(true);
assert.equal(controls["chatgpt-account"].disabled, true, "the account selector remains disabled while busy");
assert.equal(context.document.activeElement, context.document.body, "disabling the focused control moves focus to body");
context.setChatGPTBusy(false);
assert.equal(context.document.activeElement, initiating, "focus returns to the initiating control");
assert.equal(initiating.focusCalls, 1);

context.document.activeElement = initiating;
context.setChatGPTBusy(true);
const movedTo = {};
context.document.activeElement = movedTo;
context.setChatGPTBusy(false);
assert.equal(context.document.activeElement, movedTo, "a later user focus choice is preserved");
assert.equal(initiating.focusCalls, 1, "the previous control is not focused again");
"""
        result = subprocess.run(
            ["node", "-e", script], cwd=ROOT, capture_output=True, text=True, timeout=30
        )
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
