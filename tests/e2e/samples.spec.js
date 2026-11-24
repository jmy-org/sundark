const { test, expect } = require("@playwright/test");
const path = require("node:path");
const fs = require("node:fs");

// Same isolation as language.spec.js: no external request, pinned CDN assets served locally.
test.beforeEach(async ({ page }) => {
  await page.route("**/*", (route) => {
    const url = new URL(route.request().url());
    if (url.hostname !== "127.0.0.1")
      throw new Error(`Unexpected external request: ${url.hostname}`);
    return route.continue();
  });
  await page.route("https://cdnjs.cloudflare.com/**", async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    let file;
    if (pathname.includes("/pdf.js/3.11.174/"))
      file = path.join(
        path.dirname(require.resolve("pdfjs-dist/package.json")),
        "build",
        path.basename(pathname),
      );
    if (pathname.includes("/marked/12.0.2/"))
      file = path.join(path.dirname(require.resolve("marked/package.json")), path.basename(pathname));
    if (pathname.includes("/KaTeX/0.16.11/"))
      file = path.join(
        path.dirname(require.resolve("katex/package.json")),
        "dist",
        pathname.split("/KaTeX/0.16.11/")[1],
      );
    if (!file || !fs.existsSync(file)) throw new Error(`Unmapped CDN asset: ${pathname}`);
    await route.fulfill({ path: file });
  });
});

test("the start screen offers Mamba first and opens it only when asked", async ({ page }) => {
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("response", (response) => {
    if (response.status() >= 400) errors.push(`${response.status()} ${response.url()}`);
  });
  const opened = [];
  page.on("request", (req) => {
    if (req.url().endsWith("/api/samples/open")) opened.push(req.postData());
  });
  await page.goto("/");

  const samples = page.locator("#sample-list button");
  await expect(samples).toHaveCount(3);
  await expect(samples.first()).toContainText("Mamba");
  await expect(samples.first()).toHaveClass(/btn-primary/);
  await expect(samples.nth(1)).toContainText("Chain-of-Thought");
  await expect(samples.nth(2)).toContainText("LLaMA");
  await expect(page.locator("#sample-list a").first()).toHaveAttribute(
    "href",
    "https://arxiv.org/abs/2312.00752v2",
  );
  await expect(page.locator("#samples")).toContainText("CC BY 4.0");
  // Opening starts translation, so nothing opens by itself.
  await expect(page.locator("#pdfcol")).toBeHidden();
  expect(opened).toEqual([]);

  await samples.first().click();
  await expect(page.locator("#pdfview canvas").first()).toBeVisible();
  await expect(page.locator("#title")).toContainText("Mamba");
  await expect(page.locator("#empty")).toBeHidden();
  await page.locator('[data-tab="translation"]').click();
  // The deterministic backend's prose, in whichever output language an earlier test left set.
  await expect(page.locator("#trlist .trseg").first()).toContainText(
    /연구 결과를 설명한다|研究の結果を説明する/,
  );
  expect(opened).toEqual([JSON.stringify({ id: "mamba" })]);
  // A sample is not added to the user's Library folder (the server is shared with other tests).
  await page.locator("#refresh").click();
  await expect(page.locator("#paperlist")).not.toContainText("Loading");
  await expect(page.locator("#paperlist")).not.toContainText("Mamba");
  expect(errors).toEqual([]);
});
