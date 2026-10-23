"use strict";
const assert = require("node:assert/strict");
const { test } = require("node:test");
const { createHTTP, createBridge, createMCP } = require("../web/transport.js");

function fakeHost(respond) {
  let listener;
  const sent = [];
  const parent = { postMessage(message) {
    sent.push(message);
    if (message.id && message.method) queueMicrotask(() => respond(message, (result, source = parent) => {
      listener({ source, data: { jsonrpc: "2.0", id: message.id, result } });
    }));
  } };
  return {
    parent, sent,
    emit(message, source = parent) { listener({ source, data: { jsonrpc: "2.0", ...message } }); },
    addEventListener(event, handler) { assert.equal(event, "message"); listener = handler; },
    removeEventListener(event, handler) { assert.equal(listener, handler); listener = null; },
  };
}

test("HTTP transport preserves native responses, upload bodies and abort signals", async () => {
  const requests = [];
  const transport = createHTTP(async (...args) => { requests.push(args); return new Response("ok"); });
  const controller = new AbortController();
  const body = new FormData(); body.append("file", new Blob(["%PDF-test"]), "test.pdf");
  const options = { method: "POST", body, signal: controller.signal };
  const response = await transport.fetch("/api/upload", options);
  assert.equal(await response.text(), "ok");
  assert.equal(requests[0][1], options);
  assert.equal(requests[0][1].body, body);
  assert.equal(requests[0][1].signal, controller.signal);
  assert.equal(await transport.pdfSource("abc"), "/api/pdf/abc");
});

test("MCP Apps bridge initializes before calling explicit tools and ignores other windows", async () => {
  const host = fakeHost((message, reply) => {
    reply({ forged: true }, {});
    reply(message.method === "ui/initialize" ? { protocolVersion: "2026-01-26" } : { structuredContent: { papers: [] } });
  });
  const bridge = createBridge(host);
  const result = await bridge.callTool("sundark_papers", {});
  assert.deepEqual(result, { structuredContent: { papers: [] } });
  assert.deepEqual(host.sent.map((message) => message.method), ["ui/initialize", "ui/notifications/initialized", "tools/call"]);
  assert.deepEqual(host.sent[2].params, { name: "sundark_papers", arguments: {} });
  bridge.close();
});

test("MCP Apps bridge times out instead of leaving reader loading indefinitely", async () => {
  const bridge = createBridge(fakeHost(() => {}), 5);
  await assert.rejects(bridge.callTool("sundark_papers", {}), /timed out/);
  bridge.close();
});

test("the shared reader frontier buffers later results and paints the contiguous prefix", async () => {
  const fs = require("node:fs");
  const vm = require("node:vm");
  const source = fs.readFileSync("web/app.js", "utf8");
  const fn = (name) => {
    const start = source.indexOf(name);
    return source.slice(start, source.indexOf("\n}\n", start) + 3);
  };
  const transport = createHTTP(async () => new Response('{"i":1,"tr":"둘"}\n{"i":0,"tr":"하나"}\n'));
  const spans = [{ textContent: "" }, { textContent: "" }];
  const snapshots = [];
  const context = {
    S: { docId: "d", frontier: 0, numPages: 1, pages: [{ spanByK: spans, frontK: 0, trBuf: [] }] },
    fetch: transport.fetch, TextDecoder, RateLimited: class extends Error {},
    $: () => ({ children: [] }), renderMath() {},
  };
  vm.createContext(context);
  vm.runInContext(fn("async function streamTranslate(") + fn("function paintFrontier("), context);
  await context.streamTranslate(0, 0, ["one", "two"], false, (index, text) => {
    context.S.pages[0].trBuf[index] = text;
    context.paintFrontier();
    snapshots.push(spans.map((span) => span.textContent));
  }, "Korean");
  assert.deepEqual(snapshots, [["", ""], ["하나", "둘"]]);
  assert.equal(context.S.frontier, 1);
});

function toolBridge(handler) {
  return {
    assertDownloadSupported: async () => {}, downloadFile: async () => {},
    callTool: async (name, args, options) => ({ structuredContent: await handler(name, args, options) }),
  };
}

test("MCP maps only explicit reader operations and blocks local account/settings mutations", async () => {
  const calls = [];
  const transport = createMCP(toolBridge((name, args) => { calls.push([name, args]); return { ok: true }; }));
  assert.equal((await transport.fetch("/api/papers")).ok, true);
  assert.equal((await transport.fetch("/api/layout/abc/2")).ok, true);
  await transport.fetch("/api/zotero/items?collection=COL&q=word&start=2");
  await transport.fetch("/api/anatomy", { method: "POST", body: JSON.stringify({ doc_id: "abc", force: true }) });
  assert.deepEqual(calls, [
    ["list_papers", {}], ["page_layout", { doc_id: "abc", page: 2 }],
    ["zotero_items", { collection: "COL", q: "word", start: 2 }],
    ["anatomy", { doc_id: "abc", force: true }],
  ]);
  for (const path of ["/api/settings", "/api/chatgpt/login", "/api/chatgpt/status", "https://attacker.invalid/api/papers", "/api/arbitrary"]) {
    const result = await transport.fetch(path, { method: "POST", body: "{}" });
    assert.equal(result.ok, false);
  }
  assert.equal(calls.length, 4, "blocked actions never call a server tool");
});

test("MCP preserves core error status and rate-limit fields", async () => {
  const transport = createMCP({ callTool: async () => ({ isError: true, structuredContent: { detail: "limit", status: 429, rate_limited: true } }) });
  const result = await transport.fetch("/api/summarize", { method: "POST", body: '{"doc_id":"abc"}' });
  assert.equal(result.status, 429);
  assert.deepEqual(await result.json(), { detail: "limit", rate_limited: true });
});

test("MCP loads the complete original PDF through bounded validated chunks", async () => {
  const pdf = Uint8Array.from({ length: 1024 * 1024 + 7 }, (_, i) => i % 251);
  const offsets = [];
  const transport = createMCP(toolBridge((name, args) => {
    assert.equal(name, "pdf_chunk"); offsets.push(args.offset);
    return { data_base64: Buffer.from(pdf.slice(args.offset, args.offset + args.length)).toString("base64"), offset: args.offset, total: pdf.length };
  }));
  const result = await transport.pdfSource("abc");
  assert.deepEqual(result.data, pdf);
  assert.deepEqual(offsets, [0, 1024 * 1024]);
  const corrupt = createMCP(toolBridge(() => ({ total: 1000000000, offset: 0, data_base64: "" })));
  await assert.rejects(corrupt.pdfSource("abc"), /Invalid reader binary/);
});

test("MCP progressively emits exact events once and reconciles the final log", async () => {
  let progress;
  let finish;
  const transport = createMCP(toolBridge((name, args, options) => {
    assert.equal(name, "translate_stream");
    progress = options.onprogress;
    return new Promise((resolve) => { finish = resolve; });
  }));
  const response = await transport.fetch("/api/translate_stream", { method: "POST", body: '{"doc_id":"abc","segments":["a","b"]}' });
  const reader = response.body.getReader();
  const first = { i: 1, tr: "둘" }, second = { i: 0, tr: "하나" };
  progress({ message: JSON.stringify(first) });
  assert.equal(new TextDecoder().decode((await reader.read()).value), JSON.stringify(first) + "\n");
  finish({ events: [first, second] });
  assert.equal(new TextDecoder().decode((await reader.read()).value), JSON.stringify(second) + "\n");
  assert.equal((await reader.read()).done, true);
});

test("MCP batch-result fallback preserves emitted order including held indices and rate limits", async () => {
  const events = [{ i: 1, tr: "second" }, { i: 0, tr: "first" }, { error: "limit", rate_limited: true }];
  const transport = createMCP(toolBridge(() => ({ events })));
  const response = await transport.fetch("/api/translate_stream", { method: "POST", body: "{}" });
  assert.equal(await response.text(), events.map((event) => JSON.stringify(event) + "\n").join(""));
});

test("MCP bridge cancellation notifies the host and drops a late tool response", async () => {
  let toolRequest;
  let lateReply;
  let sentTool;
  const toolStarted = new Promise((resolve) => { sentTool = resolve; });
  const host = fakeHost((message, reply) => {
    if (message.method === "ui/initialize") reply({});
    else { toolRequest = message; lateReply = reply; sentTool(); }
  });
  const bridge = createBridge(host);
  const controller = new AbortController();
  const result = bridge.callTool("translate_stream", {}, { signal: controller.signal, onprogress() {} });
  await toolStarted;
  controller.abort();
  await assert.rejects(result, { name: "AbortError" });
  assert.deepEqual(host.sent.at(-1).params, { requestId: toolRequest.id, reason: "Reader request cancelled" });
  assert.equal(host.sent.at(-1).method, "notifications/cancelled");
  lateReply({ structuredContent: { events: [] } });
  bridge.close();
});

test("MCP uploads the original File in ordered chunks through the shared core", async () => {
  const content = Buffer.alloc(1024 * 1024 + 3, 65);
  const file = new File([content], "paper.pdf", { type: "application/pdf" });
  const chunks = [];
  const calls = [];
  let received = 0;
  const transport = createMCP(toolBridge((name, args) => {
    calls.push(name);
    if (name === "begin_upload") {
      assert.deepEqual(args, { filename: "paper.pdf", size: content.length });
      return { upload_id: "upload" };
    }
    if (name === "upload_chunk") {
      assert.equal(args.offset, received);
      const bytes = Buffer.from(args.data_base64, "base64");
      assert.ok(bytes.length <= 1024 * 1024);
      chunks.push(bytes); received += bytes.length;
      return { offset: received, received };
    }
    assert.equal(name, "finish_upload");
    return { doc_id: "abc", num_pages: 1 };
  }));
  const form = new FormData(); form.append("file", file);
  const response = await transport.fetch("/api/upload", { method: "POST", body: form });
  assert.deepEqual(await response.json(), { doc_id: "abc", num_pages: 1 });
  assert.deepEqual(Buffer.concat(chunks), content);
  assert.deepEqual(calls, ["begin_upload", "upload_chunk", "upload_chunk", "finish_upload"]);
});

test("MCP upload cleans up failed sessions and rejects oversized files before allocation", async () => {
  const calls = [];
  const transport = createMCP(toolBridge((name) => {
    calls.push(name);
    if (name === "begin_upload") return { upload_id: "u" };
    if (name === "upload_chunk") throw new Error("Disconnected");
    assert.equal(name, "cancel_upload"); return { ok: true };
  }));
  const form = new FormData(); form.append("file", new File(["%PDF"], "paper.pdf"));
  assert.equal((await transport.fetch("/api/upload", { method: "POST", body: form })).ok, false);
  assert.deepEqual(calls, ["begin_upload", "upload_chunk", "cancel_upload"]);
  const oversized = { get() { return { size: 20 * 1024 * 1024 + 1, slice() {} }; } };
  assert.equal((await transport.fetch("/api/upload", { method: "POST", body: oversized })).status, 413);
  assert.equal(calls.length, 3);
});

test("MCP streaming abort cancels the native bridge request and stops reads", async () => {
  let started;
  let signal;
  const ready = new Promise((resolve) => { started = resolve; });
  const transport = createMCP(toolBridge((_name, _args, options) => new Promise((_resolve, reject) => {
    signal = options.signal;
    signal.addEventListener("abort", () => reject(new DOMException("Cancelled", "AbortError")), { once: true });
    started();
  })));
  const controller = new AbortController();
  const response = await transport.fetch("/api/translate_stream", { method: "POST", body: "{}", signal: controller.signal });
  await ready;
  const read = response.body.getReader().read();
  controller.abort();
  await assert.rejects(read, { name: "AbortError" });
  assert.equal(signal.aborted, true);
});

test("MCP settings explain local execution and disable edits without requesting authentication", () => {
  const fs = require("node:fs");
  const vm = require("node:vm");
  const source = fs.readFileSync("web/app.js", "utf8");
  const start = source.indexOf("function openSettings(");
  const code = source.slice(start, source.indexOf("\n}\n", start) + 3);
  const nodes = new Map();
  const controls = [{ disabled: false }, { disabled: false }];
  const node = (id) => {
    if (!nodes.has(id)) nodes.set(id, { value: "", textContent: "", innerHTML: "", hidden: false,
      appendChild() {}, replaceChildren() {}, querySelectorAll: () => controls, showModal() { this.open = true; } });
    return nodes.get(id);
  };
  const context = {
    readerTransport: { mode: "mcp" }, window: { SundarkTransports: require("../web/transport.js") },
    S: { aiConfig: { backend: "claude", reason: "Local executor is unavailable.", output_languages: ["Korean"], backends: [{ id: "claude", label: "Claude Code" }] } },
    $: node, lang: () => "Korean", fillModels() {}, document: { createElement: () => ({}) },
    show: (item) => { item.hidden = false; }, hide: (item) => { item.hidden = true; },
    refreshChatGPT() { assert.fail("plugin must not refresh local accounts"); },
  };
  vm.createContext(context); vm.runInContext(code, context); context.openSettings();
  assert.equal(node("settings").open, true);
  assert.equal(node("chatgpt-settings").hidden, true);
  assert.ok(controls.every((control) => control.disabled));
  assert.match(node("settings-reason").textContent, /local Sundark app/);
  assert.match(node("settings-reason").textContent, /Local executor is unavailable/);
});

test("native bridge correlates progress and replays the opening tool result to the shared reader", async () => {
  const progress = [];
  const meta = { doc_id: "abc", num_pages: 1, title: "Paper" };
  const host = fakeHost((message, reply) => {
    if (message.method === "tools/call") {
      host.emit({ method: "notifications/progress", params: { progressToken: "wrong", message: "ignore" } });
      host.emit({ method: "notifications/progress", params: { progressToken: message.params._meta.progressToken, message: "event" } });
    }
    reply({ structuredContent: {} });
  });
  const bridge = createBridge(host);
  await bridge.callTool("translate_stream", {}, { onprogress: (value) => progress.push(value.message) });
  assert.deepEqual(progress, ["event"]);
  host.emit({ method: "ui/notifications/tool-result", params: { structuredContent: meta } });
  const opened = [];
  const unsubscribe = createMCP(bridge).onDocument((value) => opened.push(value));
  assert.deepEqual(opened, [meta], "resource initialization must not lose an early open result");
  unsubscribe(); bridge.close();
});

test("MCP review downloads bounded chunks as a ZIP response and releases its handle", async () => {
  const zip = Buffer.alloc(1024 * 1024 + 5, 90);
  const calls = [];
  const transport = createMCP(toolBridge((name, args) => {
    calls.push([name, args]);
    if (name === "review") return { download_id: "download", slug: "paper", filename: "paper.zip", size: zip.length };
    if (name === "review_chunk") return { data_base64: zip.subarray(args.offset, args.offset + args.length).toString("base64"), offset: args.offset, total: zip.length };
    assert.equal(name, "release_review"); return { ok: true };
  }));
  const result = await transport.fetch("/api/review/abc?output_language=Korean", { method: "POST" });
  assert.equal(result.ok, true);
  assert.equal(result.headers.get("Content-Type"), "application/zip");
  assert.equal(result.headers.get("Content-Disposition"), 'attachment; filename="paper.zip"');
  assert.deepEqual(Buffer.from(await result.arrayBuffer()), zip);
  assert.deepEqual(calls[0], ["review", { doc_id: "abc", output_language: "Korean" }]);
  assert.deepEqual(calls.map(([name]) => name), ["review", "review_chunk", "review_chunk", "release_review"]);
});

test("MCP review releases a handle on corrupt chunks or cancellation", async () => {
  for (const cancelled of [false, true]) {
    const calls = [];
    const transport = createMCP(toolBridge((name) => {
      calls.push(name);
      if (name === "review") return { download_id: "d", filename: "paper.zip", size: 1 };
      if (name === "review_chunk") {
        if (cancelled) throw new DOMException("Cancelled", "AbortError");
        return { data_base64: "", total: 1, offset: 0 };
      }
      return { ok: true };
    }));
    if (cancelled) await assert.rejects(transport.fetch("/api/review/abc", { method: "POST" }), { name: "AbortError" });
    else assert.equal((await transport.fetch("/api/review/abc", { method: "POST" })).ok, false);
    assert.equal(calls.at(-1), "release_review");
  }
});

test("HTTP transport preserves real local JSON, multipart upload, stream and review responses", async (t) => {
  const { createServer } = require("node:http");
  const server = createServer((req, res) => {
    if (req.url === "/api/papers") { res.setHeader("Content-Type", "application/json"); res.end('{"papers":[]}'); }
    else if (req.url === "/api/pdf/abc") { res.setHeader("Content-Type", "application/pdf"); res.end("%PDF-source"); }
    else if (req.url === "/api/translate_stream") { res.setHeader("Content-Type", "application/x-ndjson"); res.end('{"i":0,"tr":"하나"}\n'); }
    else if (req.url === "/api/upload") {
      const chunks = [];
      req.on("data", (chunk) => chunks.push(chunk));
      req.on("end", () => {
        assert.match(req.headers["content-type"], /multipart\/form-data; boundary=/);
        assert.match(Buffer.concat(chunks).toString(), /filename="paper.pdf"/);
        res.setHeader("Content-Type", "application/json"); res.end('{"doc_id":"abc","num_pages":1}');
      });
    } else if (req.url === "/api/review/abc") {
      res.setHeader("Content-Type", "application/zip");
      res.setHeader("Content-Disposition", 'attachment; filename="paper.zip"'); res.end("zip-bytes");
    } else { res.statusCode = 404; res.end(); }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }));
  const origin = "http://127.0.0.1:" + server.address().port;
  const transport = createHTTP((path, options) => fetch(origin + path, options));
  assert.deepEqual(await (await transport.fetch("/api/papers")).json(), { papers: [] });
  assert.equal(await (await transport.fetch(await transport.pdfSource("abc"))).text(), "%PDF-source");
  const form = new FormData(); form.append("file", new File(["%PDF-source"], "paper.pdf"));
  assert.deepEqual(await (await transport.fetch("/api/upload", { method: "POST", body: form })).json(), { doc_id: "abc", num_pages: 1 });
  const stream = await transport.fetch("/api/translate_stream", { method: "POST", body: "{}" });
  assert.equal(await stream.text(), '{"i":0,"tr":"하나"}\n');
  const review = await transport.fetch("/api/review/abc", { method: "POST" });
  assert.equal(review.headers.get("Content-Disposition"), 'attachment; filename="paper.zip"');
  assert.equal(await review.text(), "zip-bytes");
});

test("host lifecycle requests do not resolve an unrelated reader request", async () => {
  let started;
  let request;
  const ready = new Promise((resolve) => { started = resolve; });
  const host = fakeHost((message, reply) => {
    if (message.method === "ui/initialize") reply({});
    else { request = message; started(); }
  });
  const bridge = createBridge(host);
  let settled = false;
  const result = bridge.callTool("translate_stream", {}).finally(() => { settled = true; });
  await ready;
  host.emit({ id: request.id, method: "ping", params: {} });
  await Promise.resolve();
  assert.equal(settled, false, "a host request ID is independent of client request IDs");
  host.emit({ id: 999, method: "ui/resource-teardown", params: {} });
  await assert.rejects(result, /connection closed/);
  assert.deepEqual(host.sent.at(-1), { jsonrpc: "2.0", id: 999, result: {} });
  await assert.rejects(bridge.callTool("list_papers", {}), /connection closed/);
});

test("native MCP download sends a standard embedded ZIP only to the host", async () => {
  // Exercise the full allowed returned ZIP size without putting bytes in tools/call.
  const bytes = Buffer.alloc(12 * 1024 * 1024, 90);
  const host = fakeHost((message, reply) => {
    if (message.method === "ui/initialize") return reply({ hostCapabilities: { downloadFile: {} } });
    assert.equal(message.method, "ui/download-file");
    const [item] = message.params.contents;
    assert.deepEqual(Object.keys(message.params), ["contents"]);
    assert.equal(item.type, "resource");
    assert.equal(item.resource.uri, "file:///paper_.zip");
    assert.equal(item.resource.mimeType, "application/zip");
    assert.deepEqual(Buffer.from(item.resource.blob, "base64"), bytes);
    reply({ isError: true }, {}); // Other windows cannot deny a download.
    reply({});
  });
  const bridge = createBridge(host);
  await createMCP(bridge).download(new Blob([bytes]), "../../paper?.zip");
  assert.deepEqual(host.sent.map((m) => m.method), ["ui/initialize", "ui/notifications/initialized", "ui/download-file"]);
  bridge.close();
});

test("unsupported hosts fail review preflight without generation, retry or download", async () => {
  for (const hostCapabilities of [{}, { downloadFile: null }]) {
    const host = fakeHost((message, reply) => {
      assert.equal(message.method, "ui/initialize");
      reply({ hostCapabilities });
    });
    const bridge = createBridge(host);
    const transport = createMCP(bridge);
    const response = await transport.fetch("/api/review/abc", { method: "POST" });
    assert.equal(response.ok, false);
    assert.match((await response.json()).detail, /host does not support file downloads/);
    await assert.rejects(transport.download(new Blob(["zip"]), "paper.zip"), /host does not support/);
    assert.equal(host.sent.filter((m) => m.method === "ui/initialize").length, 1);
    assert.equal(host.sent.some((m) => m.method === "tools/call" || m.method === "ui/download-file"), false);
    bridge.close();
  }
});

test("native download surfaces host refusal and JSON-RPC errors without retries", async () => {
  for (const failure of ["refused", "rpc"]) {
    const host = fakeHost((message, reply) => {
      if (message.method === "ui/initialize") return reply({ hostCapabilities: { downloadFile: {} } });
      if (failure === "refused") reply({ isError: true });
      else host.emit({ id: message.id, error: { code: -32601, message: "Download method unavailable" } });
    });
    const bridge = createBridge(host);
    await assert.rejects(createMCP(bridge).download(new Blob(["zip"]), "paper.zip"), /cancelled or denied|method unavailable/);
    assert.equal(host.sent.filter((m) => m.method === "ui/download-file").length, 1);
    bridge.close();
  }
});

test("MCP releases the generated review before a denied host download and rejects oversize", async () => {
  const calls = [];
  const bridge = toolBridge((name) => {
    calls.push(name);
    if (name === "review") return { download_id: "d", filename: "..", size: 3 };
    if (name === "review_chunk") return { data_base64: "emlw", total: 3, offset: 0 };
    return { ok: true };
  });
  const downloads = [];
  bridge.downloadFile = async (contents) => { downloads.push(contents); throw new Error("Host denied download"); };
  const transport = createMCP(bridge);
  const response = await transport.fetch("/api/review/abc", { method: "POST" });
  assert.equal(response.ok, true);
  assert.deepEqual(calls, ["review", "review_chunk", "release_review"]);
  await assert.rejects(transport.download(await response.blob(), ".."), /Host denied/);
  assert.equal(downloads[0][0].resource.uri, "file:///review.zip");
  await assert.rejects(transport.download(new Blob([Buffer.alloc(12 * 1024 * 1024 + 1)]), "paper.zip"), /limited to 12 MiB/);
  assert.equal(downloads.length, 1);
  assert.equal(calls.filter((n) => n === "review").length, 1);
});

test("HTTP download retains native Blob anchor and always revokes its URL", async () => {
  const fs = require("node:fs"), vm = require("node:vm");
  for (const fail of [false, true]) {
    const events = [];
    const blob = new Blob(["zip"]);
    const anchor = { click() { events.push("click"); if (fail) throw new Error("click failed"); }, remove() { events.push("remove"); } };
    const root = {
      document: { createElement(tag) { assert.equal(tag, "a"); return anchor; }, body: { appendChild(a) { assert.equal(a, anchor); events.push("append"); } } },
      URL: { createObjectURL(value) { assert.equal(value, blob); return "blob:test"; }, revokeObjectURL(value) { assert.equal(value, "blob:test"); events.push("revoke"); } },
      fetch: async () => {},
    };
    vm.runInNewContext(fs.readFileSync("web/transport.js", "utf8"), { window: root });
    await root.SundarkTransport.assertDownloadSupported();
    const result = root.SundarkTransport.download(blob, "paper.zip");
    if (fail) await assert.rejects(result, /click failed/); else await result;
    assert.equal(anchor.download, "paper.zip");
    assert.deepEqual(events, ["append", "click", "remove", "revoke"]);
  }
});

test("review export preflight fails clearly before generating on an unsupported host", async () => {
  const fs = require("node:fs"), vm = require("node:vm");
  const source = fs.readFileSync("web/app.js", "utf8");
  const start = source.indexOf('$("export-review").addEventListener("click", async () => {');
  const snippet = source.slice(start, source.indexOf("\n});", start) + 4);
  let click, generated = 0;
  const error = { textContent: "", hidden: true };
  const button = { textContent: "Export", disabled: false,
    addEventListener(event, handler) { click = handler; } };
  const context = {
    $: (id) => id === "export-review" ? button : error,
    hide: (element) => { element.hidden = true; },
    show: (element) => { element.hidden = false; },
    S: { docId: "abc" },
    readerTransport: { assertDownloadSupported: async () => { throw new Error("Host does not support downloads"); } },
    fetch: async () => { generated++; },
    alert: () => { throw new Error("Sandbox modals are unavailable"); },
  };
  vm.runInNewContext(snippet, context);
  await click();
  assert.equal(generated, 0);
  assert.match(error.textContent, /Host does not support downloads/);
  assert.equal(error.hidden, false);
  assert.equal(button.disabled, false);
  assert.equal(button.textContent, "Export");
});
