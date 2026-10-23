const { test, expect } = require("@playwright/test");
const offlineAssets = require("./offline-assets");

test.beforeEach(async ({ page }) => offlineAssets(page));

const TRANSLATED = /연구 결과를 설명한다|研究の結果を説明する/;

async function measure(page) {
  return page.evaluate(() => ({
    innerWidth: window.innerWidth,
    scrollWidth: document.documentElement.scrollWidth,
    scrollX: window.scrollX,
  }));
}

async function noHorizontalOverflow(page, width) {
  const m = await measure(page);
  expect(m.innerWidth).toBe(width);
  expect(m.scrollWidth).toBeLessThanOrEqual(m.innerWidth);
  expect(m.scrollX).toBe(0);
}

async function openSample(page, request) {
  await page.goto("/");
  const pdf = await request.get("/__e2e/sample.pdf");
  await page.locator("#file").setInputFiles({
    name: "responsive-study.pdf",
    mimeType: "application/pdf",
    buffer: await pdf.body(),
  });
  await expect(page.locator("#trlist .trseg")).toHaveCount(9);
  await expect(page.locator("#trlist .trseg").first()).toContainText(TRANSLATED);
}

async function withinViewport(page, selector) {
  const box = await page.locator(selector).boundingBox();
  const width = await page.evaluate(() => window.innerWidth);
  expect(box.width).toBeGreaterThan(0);
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(width + 0.5);
}

for (const size of [
  { width: 390, height: 844 },
  { width: 564, height: 603 },
]) {
  test(`narrow ${size.width}px reader switches panes without overflow`, async ({
    page,
    request,
  }) => {
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.setViewportSize(size);
    await page.goto("/");
    const switcher = page.getByRole("navigation", { name: "Workspace panes" });
    await expect(switcher).toBeVisible();
    await expect(switcher.getByRole("button", { name: "Library" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await expect(page.locator("#paperlist")).toBeVisible();
    await noHorizontalOverflow(page, size.width);

    await openSample(page, request);
    // Opening a paper shows the translation; the source pane stays laid out behind it.
    await expect(switcher.getByRole("button", { name: "AI" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await expect(page.locator("#trlist")).toBeVisible();
    await expect(page.locator("#pdfcol")).not.toBeVisible();
    await expect(page.locator(".library")).not.toBeVisible();
    await withinViewport(page, "#aipanel");
    await noHorizontalOverflow(page, size.width);
    const before = await page.evaluate(() => {
      window.__firstSeg = document.querySelector("#trlist .trseg");
      window.__firstPage = window.S.pages[0];
      return window.S.pages.length;
    });

    await switcher.getByRole("button", { name: "PDF" }).click();
    await expect(switcher.getByRole("button", { name: "PDF" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await expect(page.locator("#pdfcol")).toBeVisible();
    await expect(page.locator("#aipanel")).not.toBeVisible();
    await withinViewport(page, "#pdfcol");
    await expect(page.locator("#pdfview canvas").first()).toBeVisible();
    await withinViewport(page, "#pdfview .pdfpage");
    await noHorizontalOverflow(page, size.width);

    // Keyboard reaches the switcher and brings the AI panel back.
    await switcher.getByRole("button", { name: "AI" }).focus();
    await page.keyboard.press("Enter");
    await expect(page.locator("#aipanel")).toBeVisible();
    const kept = await page.evaluate(
      () =>
        window.__firstSeg.isConnected &&
        window.S.pages[0] === window.__firstPage &&
        window.S.pages.length,
    );
    expect(kept).toBe(before);
    await expect(page.locator("#trlist .trseg").first()).toContainText(TRANSLATED);

    await page.locator('[data-tab="chat"]').click();
    await page.locator("#chatinput").focus();
    await noHorizontalOverflow(page, size.width);
    await withinViewport(page, "#chatform");
    const bots = page.locator("#chatlog .bot");
    const previous = await bots.count();
    await page.locator("#chatinput").fill("What does this study compare?");
    await page.locator("#chatinput").press("Control+Enter");
    await expect(bots).toHaveCount(previous + 1);
    await noHorizontalOverflow(page, size.width);

    for (const tab of ["summary", "anatomy"]) {
      await page.locator(`[data-tab="${tab}"]`).click();
      await expect(page.locator(`#tab-${tab}`)).toBeVisible();
      await noHorizontalOverflow(page, size.width);
    }

    await switcher.getByRole("button", { name: "Library" }).click();
    await expect(page.locator("#paperlist")).toBeVisible();
    await withinViewport(page, ".library");
    for (const id of ["#ai-badge", ".upload-btn", "#autotr"]) await withinViewport(page, id);
    await noHorizontalOverflow(page, size.width);
    expect(errors).toEqual([]);
  });
}

test("desktop 1440px keeps all three panes side by side", async ({ page, request }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openSample(page, request);
  await expect(page.getByRole("navigation", { name: "Workspace panes" })).not.toBeVisible();
  const boxes = await Promise.all(
    [".library", "#pdfcol", "#aipanel"].map((s) => page.locator(s).boundingBox()),
  );
  for (const box of boxes) expect(box.width).toBeGreaterThan(200);
  expect(boxes[0].x + boxes[0].width).toBeLessThanOrEqual(boxes[1].x + 1);
  expect(boxes[1].x + boxes[1].width).toBeLessThanOrEqual(boxes[2].x + 1);
  await expect(page.locator("#rz1")).toBeVisible();
  await noHorizontalOverflow(page, 1440);
});
