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

// The focus ring is an inset accent outline, so on the selected row (accent fill) it needs
// its own color. Compare the focused row against the same row blurred, in one run.
const rgb = (page, value) =>
  page.evaluate((v) => {
    const probe = document.createElement("span");
    probe.style.color = v;
    document.body.appendChild(probe);
    const color = getComputedStyle(probe).color;
    probe.remove();
    return color;
  }, value);

// Read pixels from a row screenshot: the left edge at mid-height (inside the inset ring)
// and a fill point inside the padding, away from the ring and the text.
async function pixels(page, png) {
  const blank = await page.context().newPage();
  const out = await blank.evaluate(async (b64) => {
    const blob = await (await fetch(`data:image/png;base64,${b64}`)).blob();
    const img = await createImageBitmap(blob);
    const ctx = new OffscreenCanvas(img.width, img.height).getContext("2d");
    ctx.drawImage(img, 0, 0);
    const at = (x, y) =>
      `rgb(${Array.from(ctx.getImageData(x, y, 1, 1).data.slice(0, 3)).join(", ")})`;
    return { edge: at(1, img.height >> 1), fill: at(6, 5), size: [img.width, img.height] };
  }, png.toString("base64"));
  await blank.close();
  return out;
}

async function expectRing(page, { selected }, testInfo) {
  const button = page.locator(":focus");
  const li = row(page);
  await page.mouse.move(0, 0);
  const state = await button.evaluate((el) => {
    const s = getComputedStyle(el);
    const box = el.getBoundingClientRect();
    return {
      visible: el.matches(":focus-visible"),
      active: el.closest("li").classList.contains("active"),
      fill: getComputedStyle(el.closest("li")).backgroundColor,
      outline: [s.outlineStyle, s.outlineWidth, s.outlineOffset],
      color: s.outlineColor,
      box: [box.x, box.y, box.width, box.height],
    };
  });
  expect(state.visible).toBe(true);
  expect(state.active).toBe(selected);
  expect(state.outline).toEqual(["solid", "2px", "-2px"]);
  const accent = await rgb(page, "var(--accent)");
  const ring = selected ? await rgb(page, "var(--accent-ink)") : accent;
  // Soft, so a wrong color still reports what the screenshots show.
  expect.soft(state.color, "the focus ring differs from the row fill").not.toBe(state.fill);
  expect.soft(state.color).toBe(ring);

  const shot = (name) =>
    li.screenshot({ animations: "disabled", path: testInfo.outputPath(`${name}.png`) });
  const focused = await shot("focused");
  await button.evaluate((el) => el.blur());
  const blurred = await shot("blurred");
  // Focus is drawn as an outline only: blurring moves nothing.
  expect(
    await li.evaluate((el) => {
      const b = el.querySelector(".paper-action").getBoundingClientRect();
      return [b.x, b.y, b.width, b.height];
    }),
  ).toEqual(state.box);
  // Not enough alone: an accent ring on the accent fill still changes a few corner pixels.
  expect.soft(Buffer.compare(focused, blurred), "focus changes the rendered row").not.toBe(0);
  const a = await pixels(page, focused);
  const b = await pixels(page, blurred);
  expect(a.size).toEqual(b.size);
  expect.soft(a.edge, "the ring is drawn in its own color").toBe(ring);
  expect(b.edge, "without focus the edge is the row fill").toBe(b.fill);
  expect(a.fill).toBe(b.fill);
}

test("the selected row shows a distinct keyboard focus ring (wide)", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await tabToRow(page);
  const opened = openRequest(page);
  await page.keyboard.press("Enter");
  await expectOpened(page, opened);
  await expect(page.locator("#prep-overlay")).toBeHidden();
  expect(await rowFocused(page)).toBe(true);
  await expectRing(page, { selected: true }, testInfo);
});

test("the selected row shows a distinct keyboard focus ring after a narrow open", async ({
  page,
}, testInfo) => {
  await page.setViewportSize(NARROW);
  await tabToRow(page);
  const opened = openRequest(page);
  await page.keyboard.press("Enter");
  await expectOpened(page, opened);
  await expect(page.locator("#prep-overlay")).toBeHidden();
  await page.keyboard.press("Shift+Tab");
  await page.keyboard.press("Shift+Tab");
  await expect(switcher(page).getByRole("button", { name: "Library" })).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.locator("#paperlist")).toBeVisible();
  for (let i = 0; i < 10 && !(await rowFocused(page)); i++) await page.keyboard.press("Tab");
  expect(await rowFocused(page)).toBe(true);
  await expectRing(page, { selected: true }, testInfo);
});

test("an unselected row keeps its accent focus ring", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await tabToRow(page);
  await expectRing(page, { selected: false }, testInfo);
});

test("a pointer selection does not show the keyboard ring", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  const opened = openRequest(page);
  await row(page).locator(".paper-action").click();
  await expectOpened(page, opened);
  await expect(page.locator("#prep-overlay")).toBeHidden();
  expect(await rowFocused(page)).toBe(true);
  expect(await page.locator(":focus").evaluate((el) => el.matches(":focus-visible"))).toBe(false);
});
