const { test, expect } = require("@playwright/test");
const offlineAssets = require("./offline-assets");

// Folder library rows must open with the keyboard alone, like any other control.
const FILE = "keyboard-study.pdf";

test.beforeEach(async ({ page }) => offlineAssets(page));

test.beforeAll(async ({ request }) => {
  const pdf = await request.get("/__e2e/sample.pdf");
  const r = await request.post("/api/upload", {
    multipart: { file: { name: FILE, mimeType: "application/pdf", buffer: await pdf.body() } },
  });
  expect(r.ok()).toBe(true);
});

const row = (page) => page.locator("#paperlist li").filter({ hasText: FILE });

// Tab from the top of the page until focus reaches the fixture row.
async function tabToRow(page) {
  await page.goto("/");
  await expect(row(page)).toHaveCount(1);
  for (let i = 0; i < 60; i++) {
    await page.keyboard.press("Tab");
    const reached = await page.evaluate(
      (file) => !!document.activeElement?.closest("#paperlist li")?.textContent.includes(file),
      FILE,
    );
    if (reached) break;
  }
  const focused = page.locator(":focus");
  await expect(focused, "a Folder row takes keyboard focus").toHaveCount(1);
  expect(
    await focused.evaluate(
      (el, file) => !!el.closest("#paperlist li")?.textContent.includes(file),
      FILE,
    ),
  ).toBe(true);
  return focused;
}

async function expectOpened(page, opened) {
  expect((await opened).postDataJSON().rel).toBe(FILE);
  await expect(page.locator("#title")).toContainText("Browser Study");
  await expect(page.locator("#pdfview .pdfpage canvas").first()).toBeAttached();
  await expect(row(page)).toHaveClass(/\bactive\b/);
}

const openRequest = (page) =>
  page.waitForRequest((req) => req.url().endsWith("/api/open") && req.method() === "POST");

test("a Folder row is a named control with visible keyboard focus", async ({ page }) => {
  const focused = await tabToRow(page);
  // The accessible name is the full visible row: title, file and size.
  await expect(focused).toHaveRole("button");
  await expect(focused).toHaveAccessibleName(
    new RegExp(`Browser Study.*${FILE.replace(".", "\\.")} · `),
  );
  expect(await focused.evaluate((el) => el.matches(":focus-visible"))).toBe(true);
  expect(await focused.evaluate((el) => getComputedStyle(el).outlineStyle)).not.toBe("none");
});

test("Enter opens a focused Folder row", async ({ page }) => {
  await tabToRow(page);
  const opened = openRequest(page);
  await page.keyboard.press("Enter");
  await expectOpened(page, opened);
});

test("Space opens a focused Folder row without scrolling the list", async ({ page }) => {
  await tabToRow(page);
  const top = await page.locator("#paperlist").evaluate((el) => el.scrollTop);
  const opened = openRequest(page);
  await page.keyboard.press("Space");
  await expectOpened(page, opened);
  expect(await page.locator("#paperlist").evaluate((el) => el.scrollTop)).toBe(top);
});

test("a pointer click still opens the row and keeps its look", async ({ page }) => {
  await page.goto("/");
  const li = row(page);
  // The row's text sits 10px/11px inside the row, as before rows held a button.
  const inset = () =>
    li.evaluate((el) => {
      const box = el.getBoundingClientRect();
      const range = document.createRange();
      const text = document.createTreeWalker(el, NodeFilter.SHOW_TEXT).nextNode();
      range.selectNodeContents(text);
      const t = range.getClientRects()[0];
      return { left: Math.round(t.left - box.left), top: Math.round(t.top - box.top) };
    });
  const before = await inset();
  expect(before.left).toBe(11);
  const opened = openRequest(page);
  await li.click();
  await expectOpened(page, opened);
  expect(await inset()).toEqual(before);
  const colors = await li.evaluate((el) => {
    const probe = document.createElement("span");
    probe.style.color = "var(--accent)";
    document.body.appendChild(probe);
    const accent = getComputedStyle(probe).color;
    probe.remove();
    return { li: getComputedStyle(el).backgroundColor, accent };
  });
  expect(colors.li).toBe(colors.accent);
  await page.mouse.move(0, 0);
  const inner = li.locator("*").first();
  expect(await inner.evaluate((el) => getComputedStyle(el).backgroundColor)).toBe(
    "rgba(0, 0, 0, 0)",
  );
});
