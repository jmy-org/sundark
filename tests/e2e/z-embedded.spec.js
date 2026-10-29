const { test, expect } = require("@playwright/test");
const { execFileSync } = require("node:child_process");
const offlineAssets = require("./offline-assets");

test.beforeEach(async ({ page }) => offlineAssets(page));

for (const progress of ["on", "off"]) {
  test(`native MCP embedded reader with progress ${progress}`, async ({
    page,
    request,
  }, testInfo) => {
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(`/__e2e/host?progress=${progress}`);
    const frame = page.frameLocator("iframe");
    await expect(frame.locator("#paperlist")).toBeVisible();
    await expect(frame.locator("#ai-badge")).toContainText("Deterministic test backend");
    await frame.locator("#ai-badge").focus();
    await frame.locator("#ai-badge").press("Enter");
    await expect(frame.locator("#settings-reason")).toContainText("local Sundark app");
    await expect(frame.locator("#set-backend")).toBeDisabled();
    await expect(frame.locator("#settings-cancel")).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(frame.locator("#settings")).not.toBeVisible();
    await expect(frame.locator("#ai-badge")).toBeFocused();
    await frame.locator("#trlist").evaluate((element) => {
      window.translationPaints = [];
      new MutationObserver(() => {
        const translated = [...element.querySelectorAll(".trseg")].map((n) =>
          n.textContent.includes("연구 결과를 설명한다"),
        );
        if (translated.length) window.translationPaints.push(translated);
      }).observe(element, { subtree: true, childList: true, characterData: true });
    });
    const pdf = await request.get(`/__e2e/sample.pdf?variant=${progress}`);
    await frame.locator("#file").setInputFiles({
      name: `embedded-${progress}.pdf`,
      mimeType: "application/pdf",
      buffer: await pdf.body(),
    });
    await expect(frame.locator("#pdfview canvas").first()).toBeVisible();
    await expect
      .poll(() =>
        frame
          .locator("#pdfview canvas")
          .first()
          .evaluate((canvas) => {
            const pixels = canvas
              .getContext("2d")
              .getImageData(0, 0, canvas.width, canvas.height).data;
            let ink = 0;
            for (let i = 0; i < pixels.length; i += 4) if (pixels[i] < 100 && pixels[i + 3]) ink++;
            return ink;
          }),
      )
      .toBeGreaterThan(100);
    await expect(frame.locator("#trlist .trseg")).toHaveCount(9);
    await expect
      .poll(() =>
        frame
          .locator("#trlist .trseg")
          .evaluateAll((nodes) =>
            nodes.every((n) => n.textContent.includes("연구 결과를 설명한다")),
          ),
      )
      .toBe(true);
    const paints = await frame.locator("#trlist").evaluate(() => window.translationPaints);
    for (const paint of paints) {
      const gap = paint.indexOf(false);
      if (gap >= 0) expect(paint.slice(gap).some(Boolean)).toBe(false);
    }
    if (progress === "on")
      expect(paints.some((p) => p.some(Boolean) && p.includes(false))).toBe(true);
    await frame.locator("#trlist .trseg").first().hover();
    await expect(frame.locator("#pdfview .hlrect").first()).toBeVisible();
    await page.screenshot({
      path: testInfo.outputPath(`translation-${progress}.png`),
      fullPage: true,
    });
    await frame.locator('[data-tab="summary"]').focus();
    await expect(frame.locator('[data-tab="summary"]')).toBeFocused();
    await frame.locator('[data-tab="summary"]').press("Tab");
    await expect(frame.locator('[data-tab="chat"]')).toBeFocused();
    await page.keyboard.press("Shift+Tab");
    await expect(frame.locator('[data-tab="summary"]')).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(frame.locator("#summary")).toContainText("연구 결과를 설명한다");
    await frame.locator('[data-tab="chat"]').click();
    await frame.locator("#chatinput").fill("What does this study compare?");
    await frame.locator("#chatinput").press("Control+Enter");
    await expect(frame.locator("#chatlog .bot").last()).toContainText("연구 결과를 설명한다");
    await frame.locator('[data-tab="summary"]').click();
    await page.screenshot({
      path: testInfo.outputPath(`embedded-${progress}.png`),
      fullPage: true,
    });
    const downloadPromise = page.waitForEvent("download");
    await frame.locator("#export-review").focus();
    await expect(frame.locator("#export-review")).toBeFocused();
    await frame.locator("#export-review").press("Enter");
    const download = await downloadPromise;
    expect(await download.failure()).toBeNull();
    expect(download.suggestedFilename()).toMatch(/\.zip$/);
    const markdown = execFileSync(
      "uv",
      [
        "run",
        "--no-sync",
        "python",
        "-c",
        'import sys,zipfile; z=zipfile.ZipFile(sys.argv[1]); print(z.read(next(n for n in z.namelist() if n.endswith("/index.md"))).decode())',
        await download.path(),
      ],
      { encoding: "utf8" },
    );
    expect(markdown).toContain("연구 결과를 설명한다");
    await expect
      .poll(() =>
        page.evaluate(() =>
          bridgeLog.some((e) => e.method === "tools/call" && e.params.name === "release_review"),
        ),
      )
      .toBe(true);
    let log = await page.evaluate(() => bridgeLog);
    const meta = log.find((e) => e.tool === "finish_upload" && e.result).result.structuredContent;
    const streamEvents = await frame.locator("#trlist").evaluate(async (_, docId) => {
      const response = await window.SundarkTransport.fetch("/api/translate_stream", {
        method: "POST",
        body: JSON.stringify({
          doc_id: docId,
          page: 0,
          target_lang: "Korean",
          segments: ["A first sentence.", "A second sentence.", "A third sentence."],
          force: true,
        }),
      });
      return (await response.text()).trim().split("\n").map(JSON.parse);
    }, meta.doc_id);
    expect(streamEvents.map((e) => e.i)).toEqual([0, 1, 2]);
    const sharedChat = await (await request.get(`/api/chat/${meta.doc_id}`)).json();
    expect(JSON.stringify(sharedChat)).toContain("What does this study compare?");
    const sharedSummary = await (
      await request.post("/api/summarize", {
        data: { doc_id: meta.doc_id, output_language: "Korean" },
      })
    ).json();
    expect(sharedSummary.summary).toContain("연구 결과를 설명한다");
    await frame
      .locator("#paperlist li")
      .filter({ hasText: `embedded-${progress}.pdf` })
      .click();
    await expect(frame.locator("#pdfview canvas").first()).toBeVisible();
    await expect
      .poll(() =>
        page.evaluate(() =>
          bridgeLog.some((e) => e.method === "tools/call" && e.params.name === "open_paper"),
        ),
      )
      .toBe(true);
    log = await page.evaluate(() => bridgeLog);
    expect(log[0].method).toBe("ui/initialize");
    expect(log.some((e) => e.method === "ui/notifications/initialized")).toBe(true);
    const names = log.filter((e) => e.method === "tools/call").map((e) => e.params.name);
    for (const name of [
      "list_papers",
      "open_paper",
      "begin_upload",
      "upload_chunk",
      "finish_upload",
      "pdf_chunk",
      "page_layout",
      "translate_stream",
      "summarize",
      "chat",
      "review",
      "review_chunk",
      "release_review",
    ])
      expect(names).toContain(name);
    // One stream's authoritative final log has unique aligned indices.
    for (const entry of log.filter((e) => e.tool === "translate_stream" && e.result)) {
      const events = entry.result.structuredContent.events;
      expect(events.map((e) => e.i)).toEqual(events.map((_, i) => i));
    }
    await testInfo.attach("bridge-log", {
      body: JSON.stringify(log, null, 2),
      contentType: "application/json",
    });
    expect(errors).toEqual([]);
  });
}

test("a rejected PDF chunk gives the library back and the paper reopens", async ({
  page,
  request,
}) => {
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  // The host answers the reader's first PDF read with a chunk at the wrong offset.
  let rejected = 0;
  await page.route("**/__e2e/tool", async (route) => {
    if (route.request().postDataJSON().name !== "pdf_chunk" || rejected++) return route.continue();
    const result = { content: [], structuredContent: { total: 10, offset: 5, data_base64: "" } };
    await route.fulfill({
      contentType: "application/x-ndjson",
      body: JSON.stringify({ result }) + "\n",
    });
  });
  await page.goto("/__e2e/host");
  const frame = page.frameLocator("iframe");
  await expect(frame.locator("#paperlist")).toBeVisible();
  const pdf = await request.get("/__e2e/sample.pdf?variant=rejected");
  await frame.locator("#file").setInputFiles({
    name: "embedded-rejected.pdf",
    mimeType: "application/pdf",
    buffer: await pdf.body(),
  });
  await expect(frame.locator("#title")).toContainText("Upload failed");
  await expect(frame.locator("#prep-overlay")).toBeHidden();
  await expect(frame.locator("#empty")).toBeVisible();
  await expect(frame.locator("#pdfcol")).toBeHidden();
  expect(rejected).toBe(1);
  // The library is usable again: refresh it and open the same paper.
  await frame.locator("#refresh").click();
  await frame.locator("#paperlist li").filter({ hasText: "embedded-rejected.pdf" }).click();
  await expect(frame.locator("#pdfview canvas").first()).toBeVisible();
  await expect(frame.locator("#prep-overlay")).toBeHidden();
  await expect(frame.locator("#trlist .trseg").first()).toBeVisible();
  expect(errors).toEqual([]);
});

test("a later page failure stops the shells it built and the paper reopens", async ({
  page,
  request,
}) => {
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  // The host claims a second page the PDF does not have, so page 1's shell is built and observed
  // before page 2 fails.
  let widened = 0;
  await page.route("**/__e2e/tool", async (route) => {
    if (route.request().postDataJSON().name !== "finish_upload" || widened++)
      return route.continue();
    const response = await route.fetch();
    const body = (await response.text())
      .split("\n")
      .map((line) => {
        if (!line) return line;
        const message = JSON.parse(line);
        if (message.result?.structuredContent) message.result.structuredContent.num_pages = 2;
        return JSON.stringify(message);
      })
      .join("\n");
    await route.fulfill({ response, body });
  });
  await page.goto("/__e2e/host");
  const frame = page.frameLocator("iframe");
  await expect(frame.locator("#paperlist")).toBeVisible();
  const pdf = await request.get("/__e2e/sample.pdf?variant=pagefail");
  await frame.locator("#file").setInputFiles({
    name: "embedded-pagefail.pdf",
    mimeType: "application/pdf",
    buffer: await pdf.body(),
  });
  await expect(frame.locator("#title")).toContainText("Upload failed: Invalid page request");
  await expect(frame.locator("#prep-overlay")).toBeHidden();
  await expect(frame.locator("#pdfview .pdfpage")).toHaveCount(0);
  expect(widened).toBe(1);
  // Let the page observers deliver what they had queued for the removed shell.
  await frame
    .locator("#pdfview")
    .evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
  expect(errors).toEqual([]);
  await frame.locator("#refresh").click();
  await frame.locator("#paperlist li").filter({ hasText: "embedded-pagefail.pdf" }).click();
  await expect(frame.locator("#pdfview canvas").first()).toBeVisible();
  await expect(frame.locator("#prep-overlay")).toBeHidden();
  await expect(frame.locator("#pdfview .pdfpage")).toHaveCount(1);
  expect(errors).toEqual([]);
});

const MiB = 1024 * 1024;
const ink = (root) =>
  root
    .locator("#pdfview canvas")
    .first()
    .evaluate((canvas) => {
      const pixels = canvas.getContext("2d").getImageData(0, 0, canvas.width, canvas.height).data;
      let count = 0;
      for (let i = 0; i < pixels.length; i += 4) if (pixels[i] < 100 && pixels[i + 3]) count++;
      return count;
    });

test("the native reader opens a folder PDF over 100 MiB by bounded ranges", async ({
  page,
  request,
}) => {
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const { size } = await (await request.post("/__e2e/large-pdf")).json();
  expect(size).toBeGreaterThan(100 * MiB);
  await page.goto("/__e2e/host");
  const frame = page.frameLocator("iframe");
  await frame.locator("#refresh").click();
  await frame.locator("#paperlist li").filter({ hasText: "Large native fixture" }).click();
  await expect(frame.locator("#pdfview canvas").first()).toBeVisible();
  await expect.poll(() => ink(frame)).toBeGreaterThan(100);
  await expect(frame.locator("#pdfview .textlayer").first()).toBeAttached();
  await expect(frame.locator("#prep-overlay")).toBeHidden();
  const calls = (await page.evaluate(() => bridgeLog))
    .filter((e) => e.method === "tools/call" && e.params.name === "pdf_chunk")
    .map((e) => e.params.arguments);
  // Only the head and tail cross the bridge, never the whole file, in calls of at most 1 MiB.
  expect(calls.length).toBeGreaterThan(1);
  expect(calls.length).toBeLessThanOrEqual(6);
  expect(calls.every((c) => c.length >= 1 && c.length <= MiB)).toBe(true);
  expect(calls.some((c) => c.offset + c.length >= size)).toBe(true);
  const sent = calls.reduce((sum, c) => sum + Math.min(c.length, size - c.offset), 0);
  expect(sent).toBeLessThan(4 * MiB);
  await expect(frame.locator("#title")).not.toContainText("Could not read");
  expect(errors).toEqual([]);
});

test("switching papers cancels a pending PDF range and drops its late result", async ({
  page,
  request,
}) => {
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const { size } = await (await request.post("/__e2e/large-pdf")).json();
  // The host keeps the large paper's range reads unanswered until after the switch.
  const held = [];
  await page.route("**/__e2e/tool", async (route) => {
    const call = route.request().postDataJSON();
    if (call.name === "pdf_chunk" && call.arguments.offset > 0) held.push(route);
    else await route.continue();
  });
  const sample = await (await request.get("/__e2e/sample.pdf?variant=switch")).body();
  const meta = await (
    await request.post("/api/upload", {
      multipart: {
        file: { name: "embedded-switch.pdf", mimeType: "application/pdf", buffer: sample },
      },
    })
  ).json();
  await page.goto("/__e2e/host");
  const frame = page.frameLocator("iframe");
  await frame.locator("#refresh").click();
  await frame.locator("#paperlist li").filter({ hasText: "Large native fixture" }).click();
  await expect.poll(() => held.length).toBeGreaterThan(0);
  await expect(frame.locator("#prep-overlay")).toBeVisible();
  const pending = await page.evaluate(() =>
    bridgeLog
      .filter(
        (e) =>
          e.method === "tools/call" &&
          e.params.name === "pdf_chunk" &&
          e.params.arguments.offset > 0,
      )
      .map((e) => e.id),
  );
  // The model opens another paper: the host pushes its tool result into the reader.
  await page.evaluate((result) => {
    document.querySelector("iframe").contentWindow.postMessage(
      {
        jsonrpc: "2.0",
        method: "ui/notifications/tool-result",
        params: { structuredContent: result },
      },
      "*",
    );
  }, meta);
  await expect
    .poll(() =>
      page.evaluate(
        (ids) =>
          ids.every((id) =>
            bridgeLog.some(
              (e) => e.method === "notifications/cancelled" && e.params.requestId === id,
            ),
          ),
        pending,
      ),
    )
    .toBe(true);
  await expect(frame.locator("#pdfview canvas").first()).toBeVisible();
  await expect(frame.locator("#prep-overlay")).toBeHidden();
  // The cancelled reads now answer late with valid data: the reader drops them.
  const answered = () =>
    page.evaluate(() => bridgeLog.filter((e) => e.tool === "pdf_chunk" && e.result).length);
  const before = await answered();
  for (const route of held.splice(0)) await route.continue();
  await expect.poll(answered).toBeGreaterThanOrEqual(before + pending.length);
  await frame
    .locator("#pdfview")
    .evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
  await expect(frame.locator("#title")).toContainText("Browser Study");
  await expect(frame.locator("#pdfview .pdfpage")).toHaveCount(1);
  expect(size).toBeGreaterThan(100 * MiB);
  expect(errors).toEqual([]);
});

// Opens the large paper with its range reads (offset > 0) held by the host, and records inside
// the reader what reaches it: every JSON-RPC response as it arrives at the reader's window (added
// after the bridge's listener, so not before the bridge settles it), every PDFDataRangeTransport
// delivery to pdf.js, and any error or unhandled rejection.
async function openLargeWithHeldRanges(page, request) {
  const { size } = await (await request.post("/__e2e/large-pdf")).json();
  const gate = { holding: true, held: [] };
  await page.route("**/__e2e/tool", async (route) => {
    const call = route.request().postDataJSON();
    if (gate.holding && call.name === "pdf_chunk" && call.arguments.offset > 0)
      gate.held.push(route);
    else await route.continue();
  });
  await page.goto("/__e2e/host");
  const frame = page.frameLocator("iframe");
  await expect(frame.locator("#paperlist")).toBeVisible();
  await frame.locator("body").evaluate(() => {
    const seen = (window.e2eSeen = { responses: [], deliveries: [], errors: [] });
    addEventListener("message", (event) => {
      const m = event.data;
      if (m?.jsonrpc !== "2.0" || m.id == null || m.method) return;
      const data = m.result?.structuredContent;
      seen.responses.push({
        id: m.id,
        error: !!m.error || !!m.result?.isError,
        offset: data?.offset,
        total: data?.total,
        base64: data?.data_base64?.length || 0,
      });
    });
    const proto = window.pdfjsLib.PDFDataRangeTransport.prototype;
    const onDataRange = proto.onDataRange;
    proto.onDataRange = function (begin, chunk) {
      seen.deliveries.push({ length: this.length, begin, bytes: chunk.length });
      return onDataRange.call(this, begin, chunk);
    };
    addEventListener("error", (e) => seen.errors.push(String(e.message)));
    addEventListener("unhandledrejection", (e) =>
      seen.errors.push(String(e.reason?.message || e.reason)),
    );
  });
  await frame.locator("#refresh").click();
  await frame.locator("#paperlist li").filter({ hasText: "Large native fixture" }).click();
  await expect.poll(() => gate.held.length).toBeGreaterThan(0);
  await expect(frame.locator("#prep-overlay")).toBeVisible();
  const pending = await page.evaluate(() =>
    bridgeLog
      .filter(
        (e) =>
          e.method === "tools/call" &&
          e.params.name === "pdf_chunk" &&
          e.params.arguments.offset > 0,
      )
      .map((e) => ({ id: e.id, offset: e.params.arguments.offset })),
  );
  const docId = gate.held[0].request().postDataJSON().arguments.doc_id;
  const seen = () => frame.locator("body").evaluate(() => window.e2eSeen);
  const release = async () => {
    gate.holding = false;
    for (const route of gate.held.splice(0)) await route.continue();
  };
  // The held ranges' valid answers reached the reader's window.
  const arrived = async () => {
    const { responses } = await seen();
    return pending.every(({ id, offset }) =>
      responses.some(
        (r) => r.id === id && !r.error && r.offset === offset && r.total === size && r.base64 > 0,
      ),
    );
  };
  return { size, frame, pending, docId, seen, release, arrived };
}

test("a held PDF range answered while its paper is open is delivered", async ({
  page,
  request,
}) => {
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const { size, frame, pending, seen, release, arrived } = await openLargeWithHeldRanges(
    page,
    request,
  );
  expect((await seen()).deliveries).toEqual([]);
  await release();
  await expect.poll(arrived).toBe(true);
  // The control for the switch test below: the same observers see this delivery.
  await expect
    .poll(async () => {
      const { deliveries } = await seen();
      return pending.every(({ offset }) =>
        deliveries.some((d) => d.length === size && d.begin === offset && d.bytes > 0),
      );
    })
    .toBe(true);
  await expect.poll(() => ink(frame)).toBeGreaterThan(100);
  await expect(frame.locator("#prep-overlay")).toBeHidden();
  await expect(frame.locator("#title")).not.toContainText("Could not read");
  expect((await seen()).errors).toEqual([]);
  expect(errors).toEqual([]);
});

test("a cancelled PDF range answered after the reader opens another paper is not delivered", async ({
  page,
  request,
}) => {
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const sample = await (await request.get("/__e2e/sample.pdf?variant=late-range")).body();
  const meta = await (
    await request.post("/api/upload", {
      multipart: {
        file: { name: "embedded-late-range.pdf", mimeType: "application/pdf", buffer: sample },
      },
    })
  ).json();
  const { size, frame, pending, docId, seen, release, arrived } = await openLargeWithHeldRanges(
    page,
    request,
  );
  expect(docId).not.toBe(meta.doc_id);
  expect((await seen()).deliveries).toEqual([]);
  // The reader's own control opens the other paper while the large one waits on its range:
  // the overlay hides the library, so the test focuses the row programmatically (a test seam,
  // not proof that keyboard navigation reaches it).
  const row = frame
    .locator("#paperlist li")
    .filter({ hasText: "embedded-late-range.pdf" })
    .locator("button");
  await row.focus();
  await row.press("Enter");
  await expect
    .poll(() =>
      page.evaluate(
        (ids) =>
          ids.every((id) =>
            bridgeLog.some(
              (e) => e.method === "notifications/cancelled" && e.params.requestId === id,
            ),
          ),
        pending.map((p) => p.id),
      ),
    )
    .toBe(true);
  await expect(frame.locator("#pdfview canvas").first()).toBeVisible();
  await expect(frame.locator("#prep-overlay")).toBeHidden();
  const chunksOfA = () =>
    page.evaluate(
      (id) =>
        bridgeLog.filter(
          (e) =>
            e.method === "tools/call" &&
            e.params.name === "pdf_chunk" &&
            e.params.arguments.doc_id === id,
        ).length,
      docId,
    );
  const before = await chunksOfA();
  // The synthetic host ignores the cancellation, so the original valid answers reach the reader.
  await release();
  await expect.poll(arrived).toBe(true);
  // Let anything the late answer set off run: a bridge round trip, then two frames.
  await frame
    .locator("body")
    .evaluate(() => window.SundarkTransport.fetch("/api/config").then((r) => r.json()));
  await frame
    .locator("#pdfview")
    .evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
  const { deliveries, errors: readerErrors } = await seen();
  expect(deliveries.filter((d) => d.length === size)).toEqual([]);
  expect(await chunksOfA()).toBe(before);
  expect(await frame.locator("body").evaluate(() => window.S.docId)).toBe(meta.doc_id);
  await expect(frame.locator("#title")).toContainText("Browser Study");
  await expect(frame.locator("#pdfview .pdfpage")).toHaveCount(1);
  await expect.poll(() => ink(frame)).toBeGreaterThan(100);
  await expect(frame.locator("#title")).not.toContainText("Could not read");
  expect(readerErrors).toEqual([]);
  expect(errors).toEqual([]);
});

test("the HTTP reader opens the same PDF over 100 MiB", async ({ page, request }) => {
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await request.post("/__e2e/large-pdf");
  await page.goto("/");
  await page.locator("#refresh").click();
  await page.locator("#paperlist li").filter({ hasText: "Large native fixture" }).click();
  await expect(page.locator("#pdfview canvas").first()).toBeVisible();
  await expect.poll(() => ink(page)).toBeGreaterThan(100);
  await expect(page.locator("#prep-overlay")).toBeHidden();
  expect(errors).toEqual([]);
});
