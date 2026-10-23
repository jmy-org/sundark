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
  const seg = page.locator("#trlist .trseg").last();
  const preview = page.locator("#trnav-preview");
  await expect(seg).toContainText(/\S/);
  await expect(page.locator("#prep-overlay")).toBeHidden();
  const before = await seg.boundingBox();
  const previewBefore = await preview.boundingBox();
  await seg.click();
  await expect(page.locator("#aipanel")).toBeVisible();
  await expect(seg).toHaveClass(/pinned/);
  // Selecting fills the preview; the list must not move, or the pointer leaves the sentence
  // and its mouseleave clears the highlight.
  await expect(preview).toContainText(/\S/);
  const after = await seg.boundingBox();
  for (const key of ["x", "y", "width", "height"]) {
    expect(Math.abs(after[key] - before[key])).toBeLessThanOrEqual(0.5);
  }
  // The empty preview already holds its two lines.
  expect(previewBefore).not.toBeNull();
  const previewAfter = await preview.boundingBox();
  expect(Math.abs(previewAfter.height - previewBefore.height)).toBeLessThanOrEqual(0.5);
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

// Auto-translate off and on again after a keyboard pin: the list is rebuilt from the saved
// translations (no new provider call), the old sentence's pin and PDF highlight go with it, and
// the repainted sentences are navigable.
test("desktop 1440px auto-translate off and on resets the navigator", async ({ page, request }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openSample(page, request);
  const autotr = page.getByRole("checkbox", { name: "Auto-translate" });
  const nav = page.getByRole("group", { name: "Sentence" });
  const next = nav.getByRole("button", { name: "Next sentence" });
  const pin = nav.getByRole("button", { name: "Pin source" });
  const translateCalls = async () => {
    const calls = await (await request.get("/__e2e/calls")).json();
    return Object.entries(calls)
      .filter(([key]) => key.startsWith("translate:"))
      .reduce((sum, [, n]) => sum + n, 0);
  };
  await expect(page.locator("#trlist .trseg").last()).toContainText(TRANSLATED);
  await expect(next).toBeEnabled();
  await next.focus();
  await page.keyboard.press("Enter");
  await page.keyboard.press("Enter");
  await pin.focus();
  await page.keyboard.press("Space");
  await expect(pin).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator("#pdfview .hlrect").first()).toBeVisible();
  const pinnedText = await page.locator("#trnav-preview").textContent();
  const callsBefore = await translateCalls();

  // Off leaves the list, the selection and the pin as they are.
  await autotr.uncheck();
  await expect(pin).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator("#trnav-preview")).toHaveText(pinnedText);

  await autotr.check();
  await expect(page.locator("#trlist .trseg")).toHaveCount(9);
  await expect(page.locator("#trlist .trseg").last()).toContainText(TRANSLATED);
  await expect(page.locator("#trlist .trseg.pinned")).toHaveCount(0);
  await expect(page.locator("#trlist .trseg.selected")).toHaveCount(0);
  await expect(page.locator("#pdfview .hlrect")).toHaveCount(0);
  await navCleared(page);
  expect(await translateCalls()).toBe(callsBefore);

  // The repainted sentences take the keyboard path again.
  await expect(next).toBeEnabled();
  await next.focus();
  await page.keyboard.press("Enter");
  await expect(page.locator("#trnav-status")).toHaveText("Page 1, sentence 1");
  await expect(page.locator("#trnav-preview")).toContainText(TRANSLATED);
  await pin.focus();
  await page.keyboard.press("Space");
  await expect(pin).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator("#pdfview .hlrect").first()).toBeVisible();
});

// A sentence's hover or pin lives in the PDF highlight layer, and a rebuilt translation list takes
// its spans away without a mouseleave. The rebuilt list's translations are held at the response,
// so the empty shells are observed before any new sentence can be painted under the pointer.
async function holdTranslations(page) {
  let release;
  const gate = new Promise((resolve) => (release = resolve));
  let held = 0;
  await page.route("**/api/translate_stream", async (route) => {
    held++;
    await gate;
    await route.continue();
  });
  return { held: () => held, release };
}

// The drawn bar, per page and in layer coordinates, so a scroll does not change it.
function layerRects(page) {
  return page.locator("#pdfview .hllayer .hlrect:not(.hlring)").evaluateAll((els) =>
    els.map((e) => {
      const pages = [...document.querySelectorAll("#pdfview .pdfpage")];
      return [
        pages.indexOf(e.closest(".pdfpage")),
        e.offsetLeft,
        e.offsetTop,
        e.offsetWidth,
        e.offsetHeight,
      ];
    }),
  );
}

// Whether a drawn bar covers the middle of a PDF word.
function barUnder(word) {
  return word.evaluate((el) => {
    const w = el.getBoundingClientRect();
    const x = w.left + w.width / 2;
    const y = w.top + w.height / 2;
    return [...document.querySelectorAll("#pdfview .hllayer .hlrect:not(.hlring)")].some((e) => {
      const r = e.getBoundingClientRect();
      return x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
    });
  });
}

async function rebuiltAndHeld(page, hold) {
  await expect.poll(hold.held).toBeGreaterThan(0);
  await expect(page.locator("#trlist .trseg")).toHaveCount(9);
  await expect(page.locator("#trlist .trseg").filter({ hasText: /\S/ })).toHaveCount(0);
  await expect(page.locator("#trlist .trseg.hl, #trlist .trseg.pinned")).toHaveCount(0);
  await expect(page.locator("#trnav-pin")).toHaveAttribute("aria-pressed", "false");
}

test("desktop 1440px retranslating under a hovered sentence clears its PDF highlight", async ({
  page,
  request,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openSample(page, request);
  const segs = page.locator("#trlist .trseg");
  await expect(segs.last()).toContainText(TRANSLATED);
  const seg = segs.nth(2);
  await seg.hover();
  await expect(seg).toHaveClass(/\bhl\b/);
  await expect(seg).not.toHaveClass(/pinned/);
  expect((await layerRects(page)).length).toBeGreaterThan(0);

  // The pointer stays on the sentence; the keyboard rebuilds the list from under it.
  const hold = await holdTranslations(page);
  await page.locator("#retranslate").focus();
  await page.keyboard.press("Enter");
  await rebuiltAndHeld(page, hold);
  await expect(page.locator("#pdfview .hlrect")).toHaveCount(0);

  hold.release();
  await expect(segs.last()).toContainText(TRANSLATED);
  await page.locator("#paperlist").hover();
  await expect(page.locator("#trlist .trseg.hl")).toHaveCount(0);
  await expect(page.locator("#pdfview .hlrect")).toHaveCount(0);
  // The rebuilt sentence takes the pointer again.
  await segs.nth(2).hover();
  await expect(segs.nth(2)).toHaveClass(/\bhl\b/);
  expect((await layerRects(page)).length).toBeGreaterThan(0);
});

test("desktop 1440px auto-translate off and on under a clicked sentence clears its highlight", async ({
  page,
  request,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openSample(page, request);
  const segs = page.locator("#trlist .trseg");
  await expect(segs.last()).toContainText(TRANSLATED);
  const seg = segs.nth(1);
  // Clicked: pinned and still under the pointer, which the pin release alone leaves drawn.
  await seg.click();
  await expect(seg).toHaveClass(/pinned/);
  await expect(seg).toHaveClass(/\bhl\b/);
  const drawn = await layerRects(page);
  expect(drawn.length).toBeGreaterThan(0);

  const autotr = page.getByRole("checkbox", { name: "Auto-translate" });
  await autotr.focus();
  await page.keyboard.press("Space");
  await expect(autotr).not.toBeChecked();
  await expect(seg).toHaveClass(/pinned/);
  expect(await layerRects(page)).toEqual(drawn);

  const hold = await holdTranslations(page);
  await page.keyboard.press("Space");
  await expect(autotr).toBeChecked();
  await rebuiltAndHeld(page, hold);
  await navCleared(page);
  await expect(page.locator("#pdfview .hlrect")).toHaveCount(0);

  hold.release();
  await expect(segs.last()).toContainText(TRANSLATED);
  await page.locator("#paperlist").hover();
  await expect(page.locator("#trlist .trseg.hl, #trlist .trseg.pinned")).toHaveCount(0);
  await expect(page.locator("#pdfview .hlrect")).toHaveCount(0);
});

// A keyboard pin on one sentence and the pointer on another sentence of the same PDF page: the
// rebuild releases the pin, whose clearing wipes that page's layer, and the PDF-owned bar stays.
test("desktop 1440px retranslating keeps the PDF-hovered bar when a pin on its page goes", async ({
  page,
  request,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openSample(page, request);
  const segs = page.locator("#trlist .trseg");
  const nav = page.getByRole("group", { name: "Sentence" });
  const next = nav.getByRole("button", { name: "Next sentence" });
  const pin = nav.getByRole("button", { name: "Pin source" });
  await expect(segs.last()).toContainText(TRANSLATED);
  await expect(next).toBeEnabled();
  await next.focus();
  await page.keyboard.press("Enter");
  await page.keyboard.press("Enter");
  await pin.focus();
  await page.keyboard.press("Space");
  await expect(pin).toHaveAttribute("aria-pressed", "true");
  await expect(segs.nth(1)).toHaveClass(/pinned/);
  const pinned = await layerRects(page);
  expect(pinned.length).toBeGreaterThan(0);

  // The last sentence's word, on the same page as the pinned sentence.
  const word = page.locator("#pdfview .textlayer span", { hasText: /^\s*evidence\s*$/ }).last();
  await word.hover();
  await expect(page.locator("#trlist .trseg.hl")).toHaveCount(2);
  await expect(page.locator("#trlist .trseg.hl:not(.pinned)")).toHaveCount(1);
  await expect(segs.nth(1)).toHaveClass(/pinned/);
  const owned = await layerRects(page);
  expect(owned.length).toBeGreaterThan(0);
  expect(owned).not.toEqual(pinned);
  expect(new Set(owned.map((r) => r[0])).size).toBe(1);
  expect(pinned.every((r) => r[0] === owned[0][0])).toBe(true);
  expect(await barUnder(word)).toBe(true);

  const hold = await holdTranslations(page);
  await page.locator("#retranslate").focus();
  await page.keyboard.press("Enter");
  await rebuiltAndHeld(page, hold);
  await navCleared(page);
  expect(await layerRects(page)).toEqual(owned);
  expect(await barUnder(word)).toBe(true);

  hold.release();
  await expect(segs.last()).toContainText(TRANSLATED);
  expect(await layerRects(page)).toEqual(owned);
  // The PDF still owns the bar: leaving its text takes it down.
  await page.locator("#paperlist").hover();
  await expect(page.locator("#pdfview .hlrect")).toHaveCount(0);
});

// A PDF hover over another sentence takes the page's one layer from the pin; when the pointer
// leaves the PDF, the pinned sentence is drawn again. A pin released while hovering stays gone.
test("desktop 1440px leaving a PDF hover draws the pinned sentence again", async ({
  page,
  request,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openSample(page, request);
  const segs = page.locator("#trlist .trseg");
  const nav = page.getByRole("group", { name: "Sentence" });
  const next = nav.getByRole("button", { name: "Next sentence" });
  const pin = nav.getByRole("button", { name: "Pin source" });
  const header = page.locator(".topbar .brand");
  await expect(segs.last()).toContainText(TRANSLATED);
  await expect(next).toBeEnabled();
  await next.focus();
  await page.keyboard.press("Enter");
  await page.keyboard.press("Enter");
  await pin.focus();
  await page.keyboard.press("Space");
  await expect(pin).toHaveAttribute("aria-pressed", "true");
  await expect(segs.nth(1)).toHaveClass(/pinned/);
  const preview = await page.locator("#trnav-preview").textContent();
  const pinned = await layerRects(page);
  expect(pinned.length).toBeGreaterThan(0);
  const pinKept = async () => {
    await expect(page.locator("#trlist .trseg.hl")).toHaveCount(1);
    await expect(segs.nth(1)).toHaveClass(/\bhl\b/);
    await expect(page.locator("#trlist .trseg.pinned")).toHaveCount(1);
    await expect(segs.nth(1)).toHaveClass(/pinned/);
    await expect(page.locator("#trlist .trseg.selected")).toHaveCount(1);
    await expect(segs.nth(1)).toHaveClass(/selected/);
    await expect(pin).toHaveAttribute("aria-pressed", "true");
    await expect(page.locator("#trnav-preview")).toHaveText(preview);
  };

  // Another sentence on the same page: the hover is drawn in the pin's place.
  const word = page.locator("#pdfview .textlayer span", { hasText: /^\s*evidence\s*$/ }).last();
  await word.hover();
  await expect(segs.last()).toHaveClass(/\bhl\b/);
  const owned = await layerRects(page);
  expect(owned.length).toBeGreaterThan(0);
  expect(owned).not.toEqual(pinned);
  expect(owned.every((r) => r[0] === pinned[0][0])).toBe(true);
  expect(await barUnder(word)).toBe(true);
  await header.hover();
  await expect(segs.last()).not.toHaveClass(/\bhl\b/);
  await expect.poll(() => layerRects(page)).toEqual(pinned);
  expect(await barUnder(word)).toBe(false);
  await pinKept();

  // The pinned sentence itself: leaving it keeps it drawn.
  const own = await page.locator("#pdfview .textlayer span").evaluateAll((els) => {
    const bars = [...document.querySelectorAll("#pdfview .hllayer .hlrect:not(.hlring)")].map((e) =>
      e.getBoundingClientRect(),
    );
    return els.findIndex((el) => {
      const w = el.getBoundingClientRect();
      const x = w.left + w.width / 2;
      const y = w.top + w.height / 2;
      return bars.some((r) => x >= r.left && x <= r.right && y >= r.top && y <= r.bottom);
    });
  });
  expect(own).toBeGreaterThanOrEqual(0);
  await page.locator("#pdfview .textlayer span").nth(own).hover();
  await expect.poll(() => layerRects(page)).toEqual(pinned);
  await pinKept();
  await header.hover();
  await expect.poll(() => layerRects(page)).toEqual(pinned);
  await pinKept();

  // Released with Escape while the pointer is on another sentence: leaving draws nothing.
  await word.hover();
  await expect(segs.last()).toHaveClass(/\bhl\b/);
  await page.keyboard.press("Escape");
  await expect(pin).toHaveAttribute("aria-pressed", "false");
  await expect(page.locator("#trlist .trseg.pinned")).toHaveCount(0);
  await header.hover();
  await expect(page.locator("#trlist .trseg.hl, #trlist .trseg.pinned")).toHaveCount(0);
  await expect(page.locator("#pdfview .hlrect")).toHaveCount(0);
});

// The pointer owns a PDF sentence when another paper opens without a pointer move: the old text
// layer goes with no mouseleave, and the pointer leaves while the new PDF is held. The new
// paper reuses the old one's page and sentence numbers, so a keyboard pin on the same or another
// sentence must not keep or redraw the old paper's owner when the list is rebuilt.
for (const pinned of ["another", "the same"]) {
  test(`desktop 1440px a new paper forgets the old PDF hover when a pin on ${pinned} sentence goes`, async ({
    page,
    request,
  }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await openSample(page, request);
    const segs = page.locator("#trlist .trseg");
    const nav = page.getByRole("group", { name: "Sentence" });
    const next = nav.getByRole("button", { name: "Next sentence" });
    const pin = nav.getByRole("button", { name: "Pin source" });
    const word = page.locator("#pdfview .textlayer span", { hasText: /^\s*evidence\s*$/ }).last();
    await expect(segs.last()).toContainText(TRANSLATED);
    await word.hover();
    await expect(segs.last()).toHaveClass(/\bhl\b/);
    expect((await layerRects(page)).length).toBeGreaterThan(0);

    let release;
    const held = new Promise((resolve) => (release = resolve));
    await page.route("**/api/pdf/**", async (route) => {
      await held;
      await route.continue();
    });
    const other = await request.get("/__e2e/sample.pdf?variant=Replaced");
    await page.locator("#file").setInputFiles({
      name: "replaced-study.pdf",
      mimeType: "application/pdf",
      buffer: await other.body(),
    });
    await expect(page.locator("#prep-overlay")).toBeVisible();
    await expect(page.locator("#pdfview .textlayer")).toHaveCount(0);
    await page.mouse.move(5, 5);
    release();
    await expect(page.locator("#prep-overlay")).toBeHidden();
    await expect(segs).toHaveCount(9);
    await expect(segs.last()).toContainText(TRANSLATED);
    await expect(page.locator("#pdfview .hlrect")).toHaveCount(0);

    await expect(next).toBeEnabled();
    await next.focus();
    const presses = pinned === "the same" ? 12 : 2;
    for (let i = 0; i < presses && !(await next.isDisabled()); i++)
      await page.keyboard.press("Enter");
    const target = pinned === "the same" ? segs.last() : segs.nth(1);
    await expect(target).toHaveClass(/selected/);
    await pin.focus();
    await page.keyboard.press("Space");
    await expect(target).toHaveClass(/pinned/);
    expect((await layerRects(page)).length).toBeGreaterThan(0);

    const hold = await holdTranslations(page);
    await page.locator("#retranslate").focus();
    await page.keyboard.press("Enter");
    await rebuiltAndHeld(page, hold);
    await navCleared(page);
    await expect(page.locator("#pdfview .hlrect")).toHaveCount(0);

    hold.release();
    await expect(segs.last()).toContainText(TRANSLATED);
    await expect(page.locator("#pdfview .hlrect")).toHaveCount(0);
    // The new paper's text takes the pointer: its sentence is drawn, and leaving takes it down.
    await word.hover();
    await expect(segs.last()).toHaveClass(/\bhl\b/);
    await expect.poll(() => barUnder(word)).toBe(true);
    await page.locator("#paperlist").hover();
    await expect(page.locator("#pdfview .hlrect")).toHaveCount(0);
  });
}

// The four AI views are plain toggle buttons (like the narrow-screen pane switcher): the pressed
// one names the visible region, and the selection's Ask-in-chat switch goes through the same click.
test("desktop 1440px AI view buttons expose the current view", async ({ page, request }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openSample(page, request);
  const views = page.getByRole("group", { name: "AI views" });
  const names = {
    translation: "Translation",
    anatomy: "Anatomy",
    summary: "Summary",
    chat: "Chat",
  };
  const expectView = async (tab) => {
    await expect(views.locator('[aria-pressed="true"]')).toHaveCount(1);
    for (const [key, name] of Object.entries(names)) {
      const btn = views.getByRole("button", { name, exact: true });
      await expect(btn).toHaveAttribute("aria-pressed", String(key === tab));
      if (key === tab) await expect(btn).toHaveClass(/\bactive\b/);
      else await expect(btn).not.toHaveClass(/\bactive\b/);
      const pane = page.locator("#" + (await btn.getAttribute("aria-controls")));
      await expect(pane).toHaveCount(1);
      await expect(pane).toBeVisible({ visible: key === tab });
    }
    await expect(page.getByRole("region", { name: names[tab], exact: true })).toBeVisible();
  };
  const aiCalls = async () => {
    const calls = await (await request.get("/__e2e/calls")).json();
    return Object.entries(calls)
      .filter(([key]) => /^(summary|anatomy):/.test(key))
      .reduce((sum, [, n]) => sum + n, 0);
  };
  await expectView("translation");
  // Opening generated both in the background; viewing them must not generate again.
  await expect(page.locator("#summary")).toContainText(TRANSLATED);
  await expect(page.locator("#tab-anatomy .anat-quote").first()).toBeAttached();
  const callsBefore = await aiCalls();

  // Four Tab stops in order, each activated by the native Enter or Space.
  const translation = views.getByRole("button", { name: "Translation", exact: true });
  await translation.focus();
  for (const [name, key] of [
    ["Anatomy", "Enter"],
    ["Summary", "Space"],
    ["Chat", "Enter"],
  ]) {
    await page.keyboard.press("Tab");
    await expect(views.getByRole("button", { name, exact: true })).toBeFocused();
    await page.keyboard.press(key);
    await expectView(name.toLowerCase());
  }
  await translation.click();
  await expectView("translation");
  await page.locator('[data-tab="summary"]').click();
  await expectView("summary");
  expect(await aiCalls()).toBe(callsBefore);

  // Ask-in-chat on a PDF selection switches to Chat through the same handler.
  await page.evaluate(() => {
    const span = [...document.querySelectorAll("#pdfview .textlayer span")].find(
      (s) => s.textContent.trim().length >= 3,
    );
    const range = document.createRange();
    range.selectNodeContents(span);
    getSelection().removeAllRanges();
    getSelection().addRange(range);
    document.getElementById("pdfview").dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
  });
  await page.locator("#btn-ask").click();
  await expectView("chat");
  await expect(page.locator("#chatinput")).toBeFocused();
  expect(await aiCalls()).toBe(callsBefore);
});
