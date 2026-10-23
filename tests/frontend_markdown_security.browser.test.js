"use strict";
// Run only in the delegated browser executor; all assets are local and no server is needed.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { chromium } = require("@playwright/test");
(async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent('<!doctype html><div id="out"></div>');
    assert.equal(await page.evaluate(() => document.compatMode), "CSS1Compat");
    for (const file of [
      require.resolve("dompurify/dist/purify.min.js"),
      path.join(path.dirname(require.resolve("marked/package.json")), "marked.min.js"),
      require.resolve("katex/dist/katex.min.js"),
      require.resolve("katex/dist/contrib/auto-render.min.js"),
    ])
      await page.addScriptTag({ path: file });
    const src = fs.readFileSync("web/app.js", "utf8");
    for (const name of ["mdMath", "renderMath"]) {
      const start = src.indexOf(`function ${name}(`);
      await page.addScriptTag({ content: src.slice(start, src.indexOf("\n}\n", start) + 3) });
    }
    const result = await page.evaluate(async () => {
      const out = document.getElementById("out");
      window.executed = 0;
      out.innerHTML = mdMath(
        '<script>window.executed++</script><img src="bad:" onerror="window.executed++"><svg onload="window.executed++"></svg><a href="javascript:window.executed++">bad</a>\n\n**bold** and [safe](https://example.org)\n\n> grounded quote\n\n\\(x_i < y\\)',
      );
      renderMath(out);
      await new Promise((r) => setTimeout(r, 30));
      const result = {
        executed: window.executed,
        dangerous: out.querySelectorAll('script,svg,[onerror],[onload],[href^="javascript:"]')
          .length,
        bold: !!out.querySelector("strong"),
        quote: out.querySelector("blockquote").textContent.trim(),
        safe: out.querySelector('a[href="https://example.org"]').textContent,
        math: !!out.querySelector(".katex"),
      };
      delete window.DOMPurify;
      try {
        out.innerHTML = mdMath('<img onerror="window.executed++">');
        result.failedClosed = false;
      } catch {
        result.failedClosed = true;
      }
      return result;
    });
    assert.deepEqual(result, {
      executed: 0,
      dangerous: 0,
      bold: true,
      quote: "grounded quote",
      safe: "safe",
      math: true,
      failedClosed: true,
    });
    console.log("DOMPurify behavior, grounded Markdown and KaTeX PASS");
  } finally {
    await browser.close();
  }
})().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
