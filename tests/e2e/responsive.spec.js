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

async function sourceInView(page) {
  // The selected sentence's highlight is drawn and scrolled into the visible PDF pane.
  await expect(page.locator("#pdfview .hlrect").first()).toBeVisible();
  await expect
    .poll(() =>
      page.evaluate(() => {
        const view = document.querySelector("#pdfview").getBoundingClientRect();
        const r = document.querySelector("#pdfview .hlrect:not(.hlring)").getBoundingClientRect();
        return r.width > 0 && r.top >= view.top && r.bottom <= view.bottom;
      }),
    )
    .toBe(true);
}

for (const size of [
  { width: 390, height: 844 },
  { width: 564, height: 603 },
]) {
  test(`narrow ${size.width}px translation click shows its source sentence`, async ({
    page,
    request,
  }) => {
    await page.setViewportSize(size);
    await openSample(page, request);
    const switcher = page.getByRole("navigation", { name: "Workspace panes" });
    const seg = page.locator("#trlist .trseg").last();
    await seg.click();
    await expect(switcher.getByRole("button", { name: "PDF" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await expect(page.locator("#pdfcol")).toBeVisible();
    await expect(page.locator("#aipanel")).not.toBeVisible();
    await withinViewport(page, "#pdfcol");
    await sourceInView(page);
    await noHorizontalOverflow(page, size.width);

    // Back on the AI pane the sentence is still the pinned one.
    await switcher.getByRole("button", { name: "AI" }).click();
    await expect(seg).toHaveClass(/pinned/);
    await expect(seg).toBeInViewport();

    // An anatomy quote looks up its source the same way.
    await page.locator('[data-tab="anatomy"]').click();
    await page.locator("#tab-anatomy .anat-quote").first().click();
    await expect(switcher.getByRole("button", { name: "PDF" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await sourceInView(page);
  });
}

test("desktop 1440px translation click keeps the AI panel beside the source", async ({
  page,
  request,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openSample(page, request);
  await page.locator("#trlist .trseg").last().click();
  await expect(page.locator("#aipanel")).toBeVisible();
  await expect(page.locator("#trlist .trseg").last()).toHaveClass(/pinned/);
  await sourceInView(page);
});

// The sentence navigator is the keyboard route to a sentence's source: native buttons that share
// the click's pin, so Tab reaches three controls instead of every sentence.
for (const size of [
  { width: 1440, height: 900 },
  { width: 390, height: 844 },
]) {
  test(`${size.width}px keyboard sentence navigator pins the source`, async ({ page, request }) => {
    await page.setViewportSize(size);
    await openSample(page, request);
    const nav = page.getByRole("group", { name: "Sentence" });
    const prev = nav.getByRole("button", { name: "Previous sentence" });
    const next = nav.getByRole("button", { name: "Next sentence" });
    const pin = nav.getByRole("button", { name: "Pin source" });
    await expect(prev).toBeDisabled();
    await expect(pin).toBeDisabled();
    await expect(page.locator("#trlist .trseg[tabindex]")).toHaveCount(0);

    const second = page.locator("#trlist .trseg").nth(1);
    await expect(second).toContainText(/\S/);
    // The fixture translates every sentence and paints them in order: with the last one painted,
    // Next stays enabled on the second instead of handing focus to Pin source at the frontier.
    await expect(page.locator("#trlist .trseg").last()).toContainText(TRANSLATED);
    await next.focus();
    await page.keyboard.press("Enter");
    await page.keyboard.press("Enter");
    await expect(second).toHaveClass(/selected/);
    await expect(page.locator("#trlist .trseg.selected")).toHaveCount(1);
    await expect(page.locator("#trnav-status")).toHaveText(/^Page 1, sentence \d+$/);
    await expect(page.locator("#trnav-preview")).toHaveText((await second.textContent()).trim());
    await expect(prev).toBeEnabled();
    await expect(next).toBeFocused();

    await page.keyboard.press("Tab");
    await expect(pin).toBeFocused();
    await page.keyboard.press("Space");
    await expect(second).toHaveClass(/pinned/);
    await expect(page.locator("#trnav-pin")).toHaveAttribute("aria-pressed", "true");
    await sourceInView(page);

    const switcher = page.getByRole("navigation", { name: "Workspace panes" });
    if (size.width < 900) {
      // The AI pane is hidden now: focus lands on the visible PDF pane control, not the button.
      const pdfPane = switcher.getByRole("button", { name: "PDF" });
      await expect(pdfPane).toHaveAttribute("aria-pressed", "true");
      await expect(pdfPane).toBeFocused();
      await switcher.getByRole("button", { name: "AI" }).focus();
      await page.keyboard.press("Enter");
      await expect(second).toHaveClass(/selected/);
      await expect(pin).toHaveAttribute("aria-pressed", "true");
      await expect(second).toBeInViewport();
    } else {
      await expect(page.locator("#aipanel")).toBeVisible();
      await expect(pin).toBeFocused();
    }

    await page.keyboard.press("Escape");
    await expect(second).not.toHaveClass(/pinned/);
    await expect(pin).toHaveAttribute("aria-pressed", "false");
    await expect(second).toHaveClass(/selected/);
    await noHorizontalOverflow(page, size.width);
  });
}

// Far down a long list the navigator stays in view and clear of the selected sentence, and a
// button that reaches the end hands its focus to Pin source instead of dropping it.
for (const size of [
  { width: 1440, height: 520 },
  { width: 390, height: 520 },
]) {
  test(`${size.width}px sentence navigator stays in view and keeps focus at the ends`, async ({
    page,
    request,
  }) => {
    await page.setViewportSize(size);
    await openSample(page, request);
    // Large text makes the nine sentences overflow the list, so the last one is far away.
    for (let i = 0; i < 10; i++) await page.locator("#tr-bigger").click();
    await expect
      .poll(() => page.locator("#trlist").evaluate((el) => el.scrollHeight > el.clientHeight + 40))
      .toBe(true);
    const nav = page.getByRole("group", { name: "Sentence" });
    const prev = nav.getByRole("button", { name: "Previous sentence" });
    const next = nav.getByRole("button", { name: "Next sentence" });
    const pin = nav.getByRole("button", { name: "Pin source" });
    // The navigator is in the viewport and the selected sentence lies below it, inside the list.
    const visibleTogether = () =>
      page.evaluate(() => {
        const bar = document.querySelector(".trnav").getBoundingClientRect();
        const list = document.querySelector("#trlist").getBoundingClientRect();
        const sel = document.querySelector("#trlist .trseg.selected").getBoundingClientRect();
        return (
          bar.top >= 0 &&
          bar.bottom <= window.innerHeight &&
          bar.bottom <= list.top + 1 &&
          sel.top >= list.top - 1 &&
          sel.bottom <= list.bottom + 1
        );
      });

    await next.focus();
    for (let i = 0; i < 12 && !(await next.isDisabled()); i++) {
      await page.keyboard.press("Enter");
      await expect.poll(visibleTogether).toBe(true);
    }
    await expect(next).toBeDisabled();
    await expect(page.locator("#trlist .trseg").last()).toHaveClass(/selected/);
    await expect(pin).toBeFocused();
    await expect(page.locator("#trnav-status")).toHaveText(/^Page 1, sentence \d+$/);

    await prev.focus();
    for (let i = 0; i < 12 && !(await prev.isDisabled()); i++) {
      await page.keyboard.press("Enter");
      await expect.poll(visibleTogether).toBe(true);
    }
    await expect(prev).toBeDisabled();
    await expect(page.locator("#trlist .trseg").first()).toHaveClass(/selected/);
    await expect(pin).toBeFocused();
    await noHorizontalOverflow(page, size.width);
  });
}

// By id, not role: a failed open hides the AI panel, and a hidden button has no role to find.
async function navCleared(page) {
  for (const id of ["#trnav-prev", "#trnav-pin"]) {
    await expect(page.locator(id)).toBeDisabled();
  }
  await expect(page.locator("#trnav-pin")).toHaveAttribute("aria-pressed", "false");
  await expect(page.locator("#trnav-pos")).toHaveText("None selected");
  await expect(page.locator("#trnav-preview")).toBeEmpty();
  await expect(page.locator("#trnav-status")).toBeEmpty();
  await expect(page.locator("#trlist .trseg.selected, #trlist .trseg.pinned")).toHaveCount(0);
}

// A keyboard pin has no mouseleave to take its PDF highlight down: retranslating releases it, and
// opening another paper forgets the old sentence at once, also when that paper fails to load.
test("desktop 1440px navigator resets on retranslate and on a new or failing paper", async ({
  page,
  request,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openSample(page, request);
  const nav = page.getByRole("group", { name: "Sentence" });
  const next = nav.getByRole("button", { name: "Next sentence" });
  const pin = nav.getByRole("button", { name: "Pin source" });
  // A retranslation empties every span and disables Next until the fixture paints again: wait for
  // the last sentence, or focus() skips the disabled button and Enter lands elsewhere.
  const pinSecond = async () => {
    await expect(page.locator("#trlist .trseg").last()).toContainText(TRANSLATED);
    await expect(next).toBeEnabled();
    await next.focus();
    await expect(next).toBeFocused();
    await page.keyboard.press("Enter");
    await page.keyboard.press("Enter");
    await pin.focus();
    await page.keyboard.press("Space");
    await expect(pin).toHaveAttribute("aria-pressed", "true");
    await expect(page.locator("#pdfview .hlrect").first()).toBeVisible();
  };

  await pinSecond();
  await page.locator("#retranslate").focus();
  await page.keyboard.press("Enter");
  await expect(page.locator("#pdfview .hlrect")).toHaveCount(0);
  await expect(page.locator("#trlist .trseg")).toHaveCount(9);
  await navCleared(page);

  // The next paper's PDF is held, then fails: the navigator is cleared while it loads and after.
  await pinSecond();
  let release;
  const held = new Promise((resolve) => (release = resolve));
  await page.route("**/api/pdf/**", async (route) => {
    await held;
    await route.fulfill({ status: 500, body: "fixture failure" });
  });
  const other = await request.get("/__e2e/sample.pdf?variant=Failing");
  await page.locator("#file").setInputFiles({
    name: "failing-study.pdf",
    mimeType: "application/pdf",
    buffer: await other.body(),
  });
  await expect(page.locator("#prep-overlay")).toBeVisible();
  await navCleared(page);
  await expect(next).toBeDisabled();
  await expect(page.locator("#pdfview .hlrect")).toHaveCount(0);
  release();
  await expect(page.locator("#prep-overlay")).toBeHidden();
  await expect(page.locator("#paperlist")).toBeVisible();
  await navCleared(page);
  await expect(page.locator("#trnav-next")).toBeDisabled();
  await page.unroute("**/api/pdf/**");

  // The sample opens cleanly again and its sentences are navigable from the start.
  const pdf = await request.get("/__e2e/sample.pdf");
  await page.locator("#file").setInputFiles({
    name: "responsive-study.pdf",
    mimeType: "application/pdf",
    buffer: await pdf.body(),
  });
  await expect(page.locator("#trlist .trseg")).toHaveCount(9);
  await navCleared(page);
  await expect(next).toBeEnabled();
});
