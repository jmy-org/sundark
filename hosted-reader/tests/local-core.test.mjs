import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import test from 'node:test';
import {
  LOCAL_CORE_TOOLS,
  LocalCore,
  LocalCoreError,
  RESPONSE_MAX,
  UPLOAD_CHUNK,
  checkPairingToken,
  coreLanguage,
  fileFingerprint,
  localCoreEndpoint,
  parseRpcReply,
} from '../lib/local-core.ts';

const TOKEN = 'k3J9_xV-0aQ7mZ2pL8rT4wY6uN1bC5dE';
const SESSION = 'session-1';

function fingerprint(bytes) {
  return createHash('sha256').update(bytes).digest('hex').slice(0, 16);
}

/** A fake companion: records every request and answers like the MCP server would. */
function companion({ tools = {}, sse = false, status } = {}) {
  const requests = [];
  const fetch = async (url, options) => {
    const body = options.body ? JSON.parse(options.body) : null;
    requests.push({ url, options, body });
    if (status) return new Response('', { status });
    if (options.method === 'DELETE') return new Response(null, { status: 200 });
    if (body.method === 'notifications/initialized') return new Response(null, { status: 202 });
    let result;
    if (body.method === 'initialize') result = { protocolVersion: '2025-11-25', capabilities: {} };
    else {
      const handler = tools[body.params.name];
      result = handler ? handler(body.params.arguments) : { isError: true, structuredContent: { detail: 'no', status: 400 } };
    }
    const message = JSON.stringify({ jsonrpc: '2.0', id: body.id, result });
    const headers = { 'mcp-session-id': SESSION };
    if (sse) {
      return new Response(`event: message\ndata: ${message}\n\n`, { headers: { ...headers, 'content-type': 'text/event-stream' } });
    }
    return new Response(message, { headers: { ...headers, 'content-type': 'application/json' } });
  };
  return { fetch, requests };
}

const ok = (structuredContent) => ({ structuredContent, content: [] });

test('the endpoint is always loopback on a valid port', () => {
  assert.equal(localCoreEndpoint(8744), 'http://127.0.0.1:8744/mcp');
  for (const port of [80, 1023, 65536, 8744.5, '8744', NaN, null, undefined]) {
    assert.throws(() => localCoreEndpoint(port), LocalCoreError, String(port));
  }
  // There is no way to pass a URL or host.
  assert.throws(() => new LocalCore({ port: 'https://evil.example', token: TOKEN }), LocalCoreError);
});

test('the pairing token must look like the one the companion prints', () => {
  assert.equal(checkPairingToken(TOKEN), TOKEN);
  for (const token of ['', 'short', `${TOKEN} `, `Bearer ${TOKEN}`, 'a'.repeat(513), 'x\ny'.repeat(8), 42]) {
    assert.throws(() => checkPairingToken(token), LocalCoreError);
  }
});

test('connect opens a session; the token goes only in the Authorization header', async () => {
  for (const sse of [false, true]) {
    const core = companion({ sse, tools: { layout_status: () => ok({ done: 1, num_pages: 2, finished: false }) } });
    const client = new LocalCore({ token: TOKEN, fetch: core.fetch });
    assert.deepEqual(await client.layoutStatus('0123456789abcdef'), { done: 1, num_pages: 2, finished: false });
    assert.deepEqual(core.requests.map((r) => r.body.method), ['initialize', 'notifications/initialized', 'tools/call']);
    for (const { url, options } of core.requests) {
      assert.equal(url, 'http://127.0.0.1:8744/mcp');
      assert.equal(options.headers.Authorization, `Bearer ${TOKEN}`);
      assert.equal(options.credentials, 'omit');
      assert.equal(options.redirect, 'error');
      assert.ok(!url.includes(TOKEN) && !options.body.includes(TOKEN));
    }
    assert.equal(core.requests[0].options.headers['Mcp-Session-Id'], undefined);
    assert.equal(core.requests[2].options.headers['Mcp-Session-Id'], SESSION);
  }
});

test('only the companion tools can be called', async () => {
  const core = companion();
  const client = new LocalCore({ token: TOKEN, fetch: core.fetch });
  for (const name of ['list_papers', 'open_paper', 'chat', 'chat_reset', 'zotero_items', 'pdf_chunk']) {
    await assert.rejects(client.call(name, {}), (e) => e instanceof LocalCoreError && e.kind === 'invalid');
  }
  assert.equal(core.requests.length, 0);
  assert.deepEqual([...LOCAL_CORE_TOOLS].sort(), [
    'anatomy', 'begin_upload', 'cancel_upload', 'finish_upload', 'layout_status', 'page_layout', 'summarize', 'translate_page', 'upload_chunk',
  ]);
  await assert.rejects(client.summarize('not-a-doc'), LocalCoreError);
  await assert.rejects(client.pageLayout('0123456789abcdef', -1), LocalCoreError);
});

test('core errors keep their status and rate limit', async () => {
  const core = companion({
    tools: { summarize: () => ({ isError: true, structuredContent: { detail: 'Rate limited', status: 429, rate_limited: true }, content: [] }) },
  });
  const client = new LocalCore({ token: TOKEN, fetch: core.fetch });
  await assert.rejects(client.summarize('0123456789abcdef', 'ko'), (e) => {
    assert.equal(e.kind, 'tool');
    assert.equal(e.status, 429);
    assert.equal(e.rateLimited, true);
    assert.equal(e.message, 'Rate limited');
    return true;
  });
  assert.deepEqual(core.requests.at(-1).body.params.arguments, { doc_id: '0123456789abcdef', output_language: 'ko' });
});

test('refusals and an unreachable companion are told apart', async () => {
  for (const [status, kind] of [[401, 'unauthorized'], [403, 'refused'], [421, 'refused']]) {
    const client = new LocalCore({ token: TOKEN, fetch: companion({ status }).fetch });
    await assert.rejects(client.connect(), (e) => e.kind === kind && e.status === status);
  }
  const client = new LocalCore({ token: TOKEN, fetch: async () => { throw new TypeError('Failed to fetch'); } });
  await assert.rejects(client.connect(), (e) => e.kind === 'unreachable' && !e.message.includes(TOKEN));
});

test('a PDF goes in bounded chunks and must come back as the same file', async () => {
  const pdf = new Uint8Array(UPLOAD_CHUNK * 2 + 10).map((_, i) => i % 251);
  let received = [];
  const tools = {
    begin_upload: (a) => { assert.equal(a.size, pdf.length); assert.equal(a.filename, 'paper.pdf'); return ok({ upload_id: 'u1' }); },
    upload_chunk: (a) => {
      const data = Buffer.from(a.data_base64, 'base64');
      assert.equal(a.offset, received.length);
      assert.ok(data.length <= UPLOAD_CHUNK);
      received = [...received, ...data];
      return ok({ offset: received.length, received: received.length });
    },
    finish_upload: () => ok({ doc_id: fingerprint(Uint8Array.from(received)), num_pages: 3 }),
  };
  const progress = [];
  const client = new LocalCore({ token: TOKEN, fetch: companion({ tools }).fetch });
  const meta = await client.uploadPdf(pdf, '../secret/paper.pdf', (sent) => progress.push(sent));
  assert.equal(meta.doc_id, fingerprint(pdf));
  assert.deepEqual(progress, [UPLOAD_CHUNK, UPLOAD_CHUNK * 2, pdf.length]);
  assert.equal(await fileFingerprint(pdf), fingerprint(pdf));

  const other = new LocalCore({ token: TOKEN, fetch: companion({ tools: { ...tools, finish_upload: () => ok({ doc_id: 'ffffffffffffffff' }) } }).fetch });
  received = [];
  await assert.rejects(other.uploadPdf(pdf), (e) => e.kind === 'protocol');
  await assert.rejects(other.uploadPdf(new Uint8Array(0)), (e) => e.kind === 'invalid');
});

test('a failed chunk cancels the upload', async () => {
  const core = companion({
    tools: {
      begin_upload: () => ok({ upload_id: 'u1' }),
      upload_chunk: () => ({ isError: true, structuredContent: { detail: 'Invalid upload chunk', status: 400 }, content: [] }),
      cancel_upload: () => ok({ ok: true }),
    },
  });
  const client = new LocalCore({ token: TOKEN, fetch: core.fetch });
  await assert.rejects(client.uploadPdf(new Uint8Array([1, 2, 3])), (e) => e.kind === 'tool');
  assert.equal(core.requests.at(-1).body.params.name, 'cancel_upload');
});

test('close ends the session and forgets the token', async () => {
  const core = companion({ tools: { layout_status: () => ok({ done: 0 }) } });
  const client = new LocalCore({ token: TOKEN, fetch: core.fetch });
  await client.connect();
  await client.close();
  const del = core.requests.at(-1);
  assert.equal(del.options.method, 'DELETE');
  assert.equal(del.options.headers['Mcp-Session-Id'], SESSION);
  await assert.rejects(client.layoutStatus('0123456789abcdef'), (e) => e.kind === 'closed');
  assert.equal(core.requests.at(-1), del);
});

test('Site languages map to the core\'s names', () => {
  assert.equal(coreLanguage('ko'), 'Korean');
  assert.equal(coreLanguage('de'), 'German');
  assert.equal(coreLanguage('xx'), undefined);
  assert.equal(coreLanguage('toString'), undefined);
});

test('replies are matched by id and bounded to valid JSON', () => {
  const sse = 'event: message\ndata: {"jsonrpc":"2.0","method":"notifications/progress"}\n\nevent: message\ndata: {"jsonrpc":"2.0","id":3,"result":{"x":1}}\n\n';
  assert.deepEqual(parseRpcReply(sse, 'text/event-stream', 3).result, { x: 1 });
  assert.throws(() => parseRpcReply('{"jsonrpc":"2.0","id":2,"result":{}}', 'application/json', 3), LocalCoreError);
  assert.throws(() => parseRpcReply('not json', 'application/json', 1), LocalCoreError);
});

/** A reply streamed in 1 MiB chunks without end; records how much was read and whether it was cancelled. */
function endlessReply(contentType, headers = {}) {
  const stream = { pulled: 0, cancelled: false };
  const chunk = new Uint8Array(1024 * 1024).fill(0x20);
  const body = new ReadableStream({
    pull(controller) {
      stream.pulled += chunk.length;
      controller.enqueue(chunk);
    },
    cancel() {
      stream.cancelled = true;
    },
  }, { highWaterMark: 0 });
  return { stream, response: new Response(body, { headers: { 'content-type': contentType, 'mcp-session-id': SESSION, ...headers } }) };
}

test('an oversized reply is cut off while it is read, before it is parsed', async () => {
  for (const contentType of ['application/json', 'text/event-stream']) {
    for (const headers of [{}, { 'content-length': 'abc' }, { 'content-length': '10' }]) {
      const reply = endlessReply(contentType, headers);
      const client = new LocalCore({ token: TOKEN, fetch: async () => reply.response });
      await assert.rejects(client.connect(), (e) => e.kind === 'protocol' && /너무 큽니다/.test(e.message));
      assert.equal(reply.stream.cancelled, true, `${contentType} ${JSON.stringify(headers)}`);
      assert.ok(reply.stream.pulled <= RESPONSE_MAX + 2 * 1024 * 1024, `read ${reply.stream.pulled}`);
    }
  }
  // A declared length over the limit is refused without reading the body.
  const reply = endlessReply('application/json', { 'content-length': String(RESPONSE_MAX + 1) });
  const client = new LocalCore({ token: TOKEN, fetch: async () => reply.response });
  await assert.rejects(client.connect(), (e) => e.kind === 'protocol');
  assert.equal(reply.stream.pulled, 0);
  assert.equal(reply.stream.cancelled, true);
});

test('a reply split across many chunks is read whole', async () => {
  const message = new TextEncoder().encode(`event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: 1, result: { note: '한국어 응답' } })}\n\n`);
  const body = new ReadableStream({
    start(controller) {
      for (let i = 0; i < message.length; i += 3) controller.enqueue(message.subarray(i, i + 3));
      controller.close();
    },
  });
  let calls = 0;
  const fetch = async () => (++calls === 1
    ? new Response(body, { headers: { 'content-type': 'text/event-stream', 'mcp-session-id': SESSION } })
    : new Response(null, { status: 202 }));
  const client = new LocalCore({ token: TOKEN, fetch });
  await client.connect();
  assert.equal(client.connected, true);
});

test('the client never stores the token or reaches the Site server', () => {
  const source = fs.readFileSync('lib/local-core.ts', 'utf8');
  for (const word of ['localStorage', 'sessionStorage', 'indexedDB', 'document.cookie', 'caches.', '/api/']) {
    assert.ok(!source.includes(word), word);
  }
});
