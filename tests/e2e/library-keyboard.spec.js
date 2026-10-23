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

// Below 900px the AI pane hides the library, and the focused row with it.
const NARROW = { width: 700, height: 800 };
const switcher = (page) => page.getByRole("navigation", { name: "Workspace panes" });
const rowFocused = (page) =>
  page.evaluate(
    (file) => !!document.activeElement?.closest("#paperlist li")?.textContent.includes(file),
    FILE,
  );

test("a narrow open moves focus to the AI pane button, one step from the library", async ({
  page,
}) => {
  await page.setViewportSize(NARROW);
  await tabToRow(page);
  const opened = openRequest(page);
  await page.keyboard.press("Enter");
  await expectOpened(page, opened);
  await expect(page.locator("#prep-overlay")).toBeHidden();
  const ai = switcher(page).getByRole("button", { name: "AI" });
  await expect(ai).toBeFocused();
  await expect(ai).toBeVisible();
  expect(await ai.evaluate((el) => el.matches(":focus-visible"))).toBe(true);

  await page.keyboard.press("Shift+Tab");
  await page.keyboard.press("Shift+Tab");
  await expect(switcher(page).getByRole("button", { name: "Library" })).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.locator("#paperlist")).toBeVisible();
  for (let i = 0; i < 10 && !(await rowFocused(page)); i++) await page.keyboard.press("Tab");
  expect(await rowFocused(page)).toBe(true);
});

test("a failed narrow open gives focus back to the row", async ({ page }) => {
  await page.setViewportSize(NARROW);
  await page.route("**/api/pdf/**", (route) => route.fulfill({ status: 500, body: "broken" }));
  await tabToRow(page);
  await page.keyboard.press("Enter");
  await expect(page.locator("#title")).toContainText("Open failed");
  await expect(page.locator("#paperlist")).toBeVisible();
  expect(await rowFocused(page)).toBe(true);
});

test("a wide open leaves focus on the row", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await tabToRow(page);
  const opened = openRequest(page);
  await page.keyboard.press("Enter");
  await expectOpened(page, opened);
  await expect(page.locator("#prep-overlay")).toBeHidden();
  expect(await rowFocused(page)).toBe(true);
});

test("a narrow open keeps focus where the user moved it while loading", async ({ page }) => {
  await page.setViewportSize(NARROW);
  // Hold the layout status so the loading screen stays up until the user has moved focus.
  let release;
  const held = new Promise((resolve) => (release = resolve));
  await page.route("**/api/status/**", async (route) => {
    await held;
    await route.continue();
  });
  await tabToRow(page);
  await page.keyboard.press("Enter");
  await expect(page.locator(".workspace")).toHaveAttribute("data-pane", "ai");
  await expect(page.locator("#prep-overlay")).toBeVisible();
  await page.keyboard.press("Tab");
  const chosen = await page.evaluate(() => {
    window.__chosen = document.activeElement;
    return document.activeElement.tagName;
  });
  expect(chosen).not.toBe("BODY");
  release();
  await expect(page.locator("#prep-overlay")).toBeHidden();
  expect(await page.evaluate(() => document.activeElement === window.__chosen)).toBe(true);
});
