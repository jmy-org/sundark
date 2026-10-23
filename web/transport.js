"use strict";

// The reader owns presentation and ordering. Transports only move core requests/results.
(function (root) {
  const LOCAL_SETTINGS = "Manage AI subscriptions, accounts, models and concurrency in the local Sundark app. The plugin uses that app's selected executor; signing into the host does not connect a local AI account.";

  function createHTTP(fetchImpl = root.fetch.bind(root)) {
    return {
      mode: "http",
      fetch: (url, options) => fetchImpl(url, options),
      pdfSource: async (docId) => "/api/pdf/" + encodeURIComponent(docId),
      async assertDownloadSupported() {},
      async download(blob, filename) {
        const a = root.document.createElement("a");
        a.href = root.URL.createObjectURL(blob);
        a.download = filename;
        try {
          root.document.body.appendChild(a); a.click();
        } finally {
          a.remove(); root.URL.revokeObjectURL(a.href);
        }
      },
    };
  }

  // Native MCP Apps bridge, following OpenAI's app-quickstart. Only the parent
  // window can resolve requests; the UI never sends prompts to the host chat.
  const abortError = () => new DOMException("The reader request was cancelled.", "AbortError");
  function createBridge(host = root, timeoutMs = 600000) {
    let nextId = 0;
    let closed = false;
    const pending = new Map();
    const progress = new Map();
    const toolResults = new Set();
    let lastResult;
    const notify = (method, params) => host.parent.postMessage({ jsonrpc: "2.0", method, params }, "*");
    function settle(id, error, result) {
      const item = pending.get(id);
      if (!item) return;
      pending.delete(id); progress.delete(item.progressToken);
      clearTimeout(item.timer);
      item.signal?.removeEventListener("abort", item.abort);
      if (error) item.reject(error); else item.resolve(result);
    }
    const receive = (event) => {
      if (event.source !== host.parent || event.data?.jsonrpc !== "2.0") return;
      const message = event.data;
      if (message.method === "ping") {
        host.parent.postMessage({ jsonrpc: "2.0", id: message.id, result: {} }, "*");
      } else if (message.method === "ui/resource-teardown") {
        close();
        host.parent.postMessage({ jsonrpc: "2.0", id: message.id, result: {} }, "*");
      } else if (message.method === "notifications/progress") {
        const item = progress.get(message.params?.progressToken);
        if (item) {
          try { item.onprogress(message.params); }
          catch {
            notify("notifications/cancelled", { requestId: item.id, reason: "Invalid translation progress" });
            settle(item.id, new Error("Invalid translation progress."));
          }
        }
      } else if (message.method === "ui/notifications/tool-result") {
        lastResult = message.params;
        for (const callback of toolResults) callback(lastResult);
      } else if (message.id != null && !message.method) {
        settle(message.id, message.error && new Error(message.error.message || "Reader bridge request failed."), message.result);
      }
    };
    host.addEventListener("message", receive);
    function request(method, params, options = {}) {
      if (closed) return Promise.reject(new Error("Reader connection closed."));
      if (options.signal?.aborted) return Promise.reject(abortError());
      return new Promise((resolve, reject) => {
        const id = ++nextId;
        const progressToken = options.onprogress ? "sundark-" + id : undefined;
        if (progressToken) params = { ...params, _meta: { progressToken } };
        const cancel = () => notify("notifications/cancelled", { requestId: id, reason: "Reader request cancelled" });
        const abort = () => { cancel(); settle(id, abortError()); };
        const timer = setTimeout(() => {
          cancel(); settle(id, new Error("The reader connection timed out. Reopen the reader to reconnect."));
        }, timeoutMs);
        const item = { id, resolve, reject, timer, progressToken, ...options, abort };
        pending.set(id, item);
        if (progressToken) progress.set(progressToken, item);
        options.signal?.addEventListener("abort", abort, { once: true });
        try { host.parent.postMessage({ jsonrpc: "2.0", id, method, params }, "*"); }
        catch { settle(id, new Error("Could not reach the reader host.")); }
      });
    }
    function close() {
      closed = true;
      host.removeEventListener("message", receive);
      for (const id of pending.keys()) {
        notify("notifications/cancelled", { requestId: id, reason: "Reader connection closed" });
        settle(id, new Error("Reader connection closed."));
      }
      toolResults.clear();
    }
    const ready = request("ui/initialize", {
      appInfo: { name: "sundark-reader", version: "0.1.0" },
      appCapabilities: {}, protocolVersion: "2026-01-26",
    }).then((result) => {
      notify("ui/notifications/initialized", {});
      return result;
    });
    async function assertDownloadSupported() {
      const initialized = await ready;
      if (!initialized?.hostCapabilities?.downloadFile) throw new Error("This reader host does not support file downloads. Export the review from the local Sundark app.");
    }
    return {
      async callTool(name, args, options) {
        await ready;
        return request("tools/call", { name, arguments: args }, options);
      },
      assertDownloadSupported,
      async downloadFile(contents) {
        await assertDownloadSupported();
        const result = await request("ui/download-file", { contents });
        if (!result || result.isError) throw new Error("The reader host cancelled or denied the file download.");
      },
      onToolResult(callback) {
        toolResults.add(callback);
        if (lastResult) callback(lastResult);
        return () => toolResults.delete(callback);
      },
      close,
    };
  }

  const CHUNK_SIZE = 1024 * 1024;
  const MAX_BINARY = 100 * 1024 * 1024;
  function decodeBytes(base64) {
    const binary = atob(base64);
    return Uint8Array.from(binary, (c) => c.charCodeAt(0));
  }
  function encodeBytes(bytes) {
    const parts = [];
    for (let offset = 0; offset < bytes.length; offset += 32768) {
      parts.push(String.fromCharCode(...bytes.subarray(offset, offset + 32768)));
    }
    return btoa(parts.join(""));
  }
  function safeReviewFilename(filename) {
    const name = String(filename || "review.zip").split(/[\\/]/).pop()
      .replace(/[^a-zA-Z0-9_.-]/g, "_").replace(/^\.+/, "").slice(0, 160);
    return name && name !== "zip" ? (/\.zip$/i.test(name) ? name : name + ".zip") : "review.zip";
  }
  function createMCP(bridge = createBridge(), { pdfjs } = {}) {
    async function call(name, args, options) {
      const result = await bridge.callTool(name, args, options);
      if (result.isError) {
        const data = result.structuredContent || {};
        const error = new Error(data.detail || "The core reader request failed.");
        error.status = data.status || 400; error.rate_limited = !!data.rate_limited;
        throw error;
      }
      if (!result.structuredContent) throw new Error("The core reader returned no data.");
      return result.structuredContent;
    }
    async function binary(name, args, options, maxBytes = MAX_BINARY) {
      let output;
      let offset = 0;
      do {
        if (options?.signal?.aborted) throw abortError();
        const chunk = await call(name, { ...args, offset, length: CHUNK_SIZE }, options);
        if (!Number.isSafeInteger(chunk.total) || chunk.total < 0 || chunk.total > maxBytes
            || chunk.offset !== offset || (output && chunk.total !== output.length)) throw new Error("Invalid reader binary size or offset.");
        if (typeof chunk.data_base64 !== "string" || chunk.data_base64.length > Math.ceil(CHUNK_SIZE / 3) * 4) throw new Error("Invalid reader binary chunk.");
        const bytes = decodeBytes(chunk.data_base64);
        if (bytes.length > CHUNK_SIZE || offset + bytes.length > chunk.total
            || (!bytes.length && offset < chunk.total)) throw new Error("Invalid reader binary chunk.");
        if (!output) output = new Uint8Array(chunk.total);
        output.set(bytes, offset); offset += bytes.length;
      } while (offset < output.length);
      return output;
    }
    // One validated pdf_chunk: exactly the bytes [offset, min(offset + length, total)) of a file
    // whose size is `total` (when known), so a short read, an overrun or a changed file fails.
    async function pdfChunk(docId, offset, length, total, options) {
      const chunk = await call("pdf_chunk", { doc_id: docId, offset, length }, options);
      if (!Number.isSafeInteger(chunk.total) || chunk.total < 0 || chunk.offset !== offset
          || (total !== undefined && chunk.total !== total)) throw new Error("Invalid reader binary size or offset.");
      if (typeof chunk.data_base64 !== "string" || chunk.data_base64.length > Math.ceil(CHUNK_SIZE / 3) * 4) throw new Error("Invalid reader binary chunk.");
      let bytes;
      try { bytes = decodeBytes(chunk.data_base64); } catch { throw new Error("Invalid reader binary chunk."); }
      if (bytes.length !== Math.max(0, Math.min(length, chunk.total - offset))) throw new Error("Invalid reader binary chunk.");
      return { bytes, total: chunk.total };
    }
    // pdf.js reads the PDF by range, so only the parts it draws cross the bridge and the reader
    // never holds the whole file: a folder or Zotero paper has no size cap. pdf.js 3.x has no way
    // for a range to fail, so a failure rejects `failed`, which the reader races against.
    async function pdfSource(docId, options = {}) {
      const Base = (pdfjs || root.pdfjsLib).PDFDataRangeTransport;
      const first = await pdfChunk(docId, 0, CHUNK_SIZE, undefined, options);
      const total = first.total;
      const controller = new AbortController();
      let closed = false, fail;
      // The caller's abort closes the range like pdf.js's abort(): a bridge that answers the
      // cancelled call anyway must not deliver it or start the next chunk.
      const close = () => {
        closed = true; controller.abort();
        options.signal?.removeEventListener("abort", close);
      };
      if (options.signal?.aborted) close();
      else options.signal?.addEventListener("abort", close, { once: true });
      const failed = new Promise((_, reject) => { fail = reject; });
      failed.catch(() => {});
      async function read(begin, end) {
        if (!Number.isSafeInteger(begin) || !Number.isSafeInteger(end) || begin < 0 || begin >= end || end > total) throw new Error("Invalid reader binary size or offset.");
        const out = new Uint8Array(end - begin);
        for (let offset = begin; offset < end;) {
          if (closed) return null;
          const { bytes } = await pdfChunk(docId, offset, Math.min(CHUNK_SIZE, end - offset), total, { signal: controller.signal });
          out.set(bytes, offset - begin); offset += bytes.length;
        }
        return out;
      }
      class ChunkRange extends Base {
        requestDataRange(begin, end) {
          // The first await is the bridge call: pdf.js registers this range's reader only after
          // this returns, and a delivery after abort() would find none.
          read(begin, end).then((bytes) => { if (bytes && !closed) this.onDataRange(begin, bytes); })
            .catch((error) => { if (!closed) { close(); fail(error); } });
        }
        abort() { close(); }
      }
      const range = new ChunkRange(total, first.bytes, first.bytes.length === total);
      range.failed = failed;
      if (closed) throw abortError();
      return { range, rangeChunkSize: CHUNK_SIZE, disableAutoFetch: true };
    }
    async function upload(file, options) {
      if (!file || typeof file.slice !== "function" || !Number.isSafeInteger(file.size)) throw new Error("Select a PDF file to upload.");
      if (file.size > 20 * 1024 * 1024) {
        const error = new Error("Plugin PDF uploads are limited to 20 MiB."); error.status = 413; throw error;
      }
      let uploadId;
      try {
        // Keep the begin response so an abort during allocation can still clean up.
        const started = await call("begin_upload", { filename: file.name || "paper.pdf", size: file.size });
        uploadId = started.upload_id;
        if (typeof uploadId !== "string" || !uploadId) throw new Error("Invalid upload session.");
        for (let offset = 0; offset < file.size;) {
          if (options.signal?.aborted) throw abortError();
          const bytes = new Uint8Array(await file.slice(offset, offset + CHUNK_SIZE).arrayBuffer());
          const result = await call("upload_chunk", { upload_id: uploadId, offset, data_base64: encodeBytes(bytes) }, options);
          offset += bytes.length;
          if (result.offset !== offset || result.received !== offset) throw new Error("The upload offset did not match.");
        }
        if (options.signal?.aborted) throw abortError();
        const meta = await call("finish_upload", { upload_id: uploadId }, options);
        uploadId = null;
        return meta;
      } finally {
        if (uploadId) await call("cancel_upload", { upload_id: uploadId }).catch(() => {});
      }
    }
    function translation(args, signal) {
      const controller = new AbortController();
      let sink;
      let done = false;
      const emitted = [];
      const encoder = new TextEncoder();
      const abort = () => controller.abort();
      if (signal?.aborted) controller.abort();
      else signal?.addEventListener("abort", abort, { once: true });
      const stream = new ReadableStream({
        start(value) { sink = value; },
        cancel() { done = true; controller.abort(); },
      });
      const emit = (event) => {
        if (!event || (!event.error && (!Number.isInteger(event.i) || typeof event.tr !== "string"))) throw new Error("Invalid translation event.");
        emitted.push(event);
        if (!done) sink.enqueue(encoder.encode(JSON.stringify(event) + "\n"));
      };
      call("translate_stream", args, {
        signal: controller.signal,
        onprogress(params) { if (params.message) emit(JSON.parse(params.message)); },
      }).then((result) => {
        if (done) return;
        if (!Array.isArray(result.events) || emitted.length > result.events.length) throw new Error("Invalid translation result.");
        // A host may not forward progress. The final event log is authoritative;
        // reconcile the prefix instead of delivering progress events a second time.
        for (let i = 0; i < emitted.length; i++) {
          if (emitted[i].i !== result.events[i]?.i || emitted[i].tr !== result.events[i]?.tr
              || emitted[i].error !== result.events[i]?.error || emitted[i].rate_limited !== result.events[i]?.rate_limited) throw new Error("Translation progress did not match the result.");
        }
        for (const event of result.events.slice(emitted.length)) emit(event);
        done = true; sink.close();
      }).catch((error) => { if (!done) { done = true; sink.error(error); } })
        .finally(() => signal?.removeEventListener("abort", abort));
      return new Response(stream, { headers: { "Content-Type": "application/x-ndjson" } });
    }
    const json = (data) => Response.json(data);
    return {
      mode: "mcp",
      async assertDownloadSupported() {
        if (!bridge.assertDownloadSupported || !bridge.downloadFile) throw new Error("This reader host does not support file downloads. Export the review from the local Sundark app.");
        await bridge.assertDownloadSupported();
      },
      async download(blob, filename) {
        await this.assertDownloadSupported();
        if (blob.size > 12 * 1024 * 1024) throw new Error("Review downloads are limited to 12 MiB.");
        // This URI names the embedded resource; neither side reads a local file.
        const name = safeReviewFilename(filename);
        await bridge.downloadFile([{ type: "resource", resource: {
          uri: "file:///" + name, mimeType: "application/zip",
          blob: encodeBytes(new Uint8Array(await blob.arrayBuffer())),
        } }]);
      },
      pdfSource,
      onDocument(callback) {
        return bridge.onToolResult((result) => {
          const meta = result?.structuredContent;
          if (meta?.doc_id && Number.isInteger(meta.num_pages)) callback(meta);
        });
      },
      async fetch(path, options = {}) {
        if (options.signal?.aborted) throw abortError();
        try {
          if (typeof path !== "string" || !path.startsWith("/api/")) throw new Error("Unsupported reader action.");
          const url = new URL(path, "https://sundark.invalid");
          const method = options.method || "GET";
          const body = typeof options.body === "string" ? JSON.parse(options.body) : {};
          const get = method === "GET", post = method === "POST";
          const route = url.pathname;
          const fixed = {
            "GET /api/config": "reader_config", "GET /api/papers": "list_papers",
            "POST /api/open": "open_paper", "GET /api/zotero/status": "zotero_status",
            "GET /api/zotero/collections": "zotero_collections", "POST /api/zotero/open": "open_zotero_paper",
            "POST /api/summarize": "summarize", "POST /api/anatomy": "anatomy",
            "POST /api/chat": "chat", "POST /api/explain": "explain", "POST /api/brief": "brief",
          };
          const name = fixed[method + " " + route];
          if (name) return json(await call(name, body, options));
          if (get && route === "/api/zotero/items") {
            const args = Object.fromEntries(url.searchParams);
            if (args.start != null) args.start = Number(args.start);
            return json(await call("zotero_items", args, options));
          }
          let match;
          if (get && (match = route.match(/^\/api\/(layout|math)\/([^/]+)\/(\d+)$/))) {
            return json(await call(match[1] === "layout" ? "page_layout" : "page_math", { doc_id: match[2], page: Number(match[3]) }, options));
          }
          if (get && (match = route.match(/^\/api\/status\/([^/]+)$/))) return json(await call("layout_status", { doc_id: match[1] }, options));
          if (get && (match = route.match(/^\/api\/chat\/([^/]+)$/))) return json(await call("chat_history", { doc_id: match[1] }, options));
          if (post && (match = route.match(/^\/api\/chat\/([^/]+)\/reset$/))) return json(await call("chat_reset", { doc_id: match[1] }, options));
          if (post && route === "/api/translate_stream") return translation(body, options.signal);
          if (post && route === "/api/upload") return json(await upload(options.body?.get("file"), options));
          if (post && (match = route.match(/^\/api\/review\/([^/]+)$/))) {
            await this.assertDownloadSupported();
            let downloadId;
            try {
              const meta = await call("review", { doc_id: match[1], output_language: url.searchParams.get("output_language") || undefined }, options);
              downloadId = meta.download_id;
              if (typeof downloadId !== "string" || !Number.isSafeInteger(meta.size) || meta.size < 0 || meta.size > 12 * 1024 * 1024) throw new Error("Invalid review download size or handle.");
              const bytes = await binary("review_chunk", { download_id: downloadId }, options, meta.size);
              if (bytes.length !== meta.size) throw new Error("The review download size did not match.");
              const filename = safeReviewFilename(meta.filename);
              return new Response(new Blob([bytes], { type: "application/zip" }), {
                headers: { "Content-Type": "application/zip", "Content-Disposition": 'attachment; filename="' + filename + '"' },
              });
            } finally {
              if (downloadId) await call("release_review", { download_id: downloadId }).catch(() => {});
            }
          }
          if (route === "/api/settings" || route.startsWith("/api/chatgpt/")) throw new Error(LOCAL_SETTINGS);
          throw new Error("Unsupported reader action.");
        } catch (error) {
          if (error.name === "AbortError") throw error;
          return Response.json({ detail: error.message, rate_limited: !!error.rate_limited }, { status: error.status || 400 });
        }
      },
    };
  }

  const api = { createHTTP, createBridge, createMCP, LOCAL_SETTINGS };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.SundarkTransports = api;
  if (root.document) root.SundarkTransport = root.SUNDARK_MCP_APP ? createMCP() : createHTTP();
})(typeof window === "undefined" ? globalThis : window);
