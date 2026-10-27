// Opt-in MCP observation (SUNDARK_MCP_DIAGNOSTICS=1): off logs nothing; on logs one line per request
// with enum fields only, and never params, arguments, URIs, file ids, headers or paper text.
// The fake Workers env throws on any DB/BUCKET access, so attachment calls prove zero storage.
import assert from 'node:assert/strict';
import http from 'node:http';
import {register} from 'node:module';
import test from 'node:test';
import {twoPagePdf} from './fixtures/synthetic-pdf.mjs';

register('./fixtures/worker-loader.mjs', import.meta.url);
const storage = [];
const vars = {};
globalThis.__workerEnv = new Proxy(vars, {
  get(target, key) {
    if (key === 'DB' || key === 'BUCKET') { storage.push(String(key)); throw new Error(`storage access: ${String(key)}`); }
    return target[key];
  },
});
const pdf = twoPagePdf();
const server = http.createServer((req, res) => {
  if (req.url.split('?')[0] === '/two.pdf') { res.writeHead(200, {'Content-Type': 'application/pdf'}); return res.end(pdf); }
  res.writeHead(404); res.end('gone');
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const origin = `http://127.0.0.1:${server.address().port}`;
test.after(() => new Promise(r => { server.closeAllConnections(); server.close(r); }));
globalThis.__viteDev = true;
vars.SUNDARK_DEV_FILE_ORIGIN = origin;
vars.SUNDARK_FILE_HOSTS = 'files.oaiusercontent.com';
const {POST} = await import('../app/mcp/route.ts');
const {attachmentReaderHtml} = await import('../lib/attachment-reader.ts');

const SECRET = 'SECRET-MARKER';
const ATTACHMENT_URI = 'ui://sundark/attachment-reader-v4.html';
const SAVED_URI = 'ui://sundark/reader-compat-v3.html';
const signedIn = {'oai-authenticated-user-id': `user-${SECRET}`, 'oai-authenticated-user-email': `${SECRET}@example.invalid`};
const file = {download_url: `${origin}/two.pdf?sig=${SECRET}`, file_id: `file-${SECRET}`, file_name: `${SECRET}.pdf`};
const FIELDS = new Set(['event', 'method', 'tool', 'resource', 'requestedVersion', 'protocolVersion', 'uiCapability', 'outcome', 'status', 'reason', 'bytes']);

async function send(body, {headers = {}, auth = true, raw = false} = {}) {
  globalThis.__requestHeaders = new Headers(auth ? signedIn : {});
  try {
    const response = await POST(new Request('https://site.example/mcp', {method: 'POST', headers: {'content-type': 'application/json', authorization: `Bearer ${SECRET}`, ...headers},
      body: raw ? body : JSON.stringify({jsonrpc: '2.0', id: 1, ...body})}));
    return {status: response.status, body: await response.json()};
  } finally { globalThis.__requestHeaders = undefined; }
}
async function observe(run) {
  const logged = [];
  const saved = {};
  const before = storage.length;
  for (const level of ['log', 'info', 'warn', 'error', 'debug']) { saved[level] = console[level]; console[level] = (...args) => logged.push({level, args}); }
  try { await run(); } finally { Object.assign(console, saved); }
  assert.equal(storage.length, before, 'no D1/R2 access');
  // pdf.js may print its own font warnings; only the observation event is this code's.
  const events = logged.filter(l => String(l.args[0]).includes('sundark_mcp_observation'));
  for (const e of events) {
    assert.equal(e.args.length, 1);
    assert(!e.args[0].includes(SECRET) && !e.args[0].includes(origin) && !e.args[0].includes('ui://') && !e.args[0].includes('two.pdf'), e.args[0]);
    for (const key of Object.keys(JSON.parse(e.args[0]))) assert(FIELDS.has(key), `unexpected field ${key}`);
  }
  return {events: events.map(e => ({level: e.level, ...JSON.parse(e.args[0])})), all: JSON.stringify(logged)};
}
const flag = value => { if (value === undefined) delete vars.SUNDARK_MCP_DIAGNOSTICS; else vars.SUNDARK_MCP_DIAGNOSTICS = value; };

test('flag off (unset, "0", "true"): nothing is logged and responses are unchanged', async () => {
  for (const value of [undefined, '0', 'true']) {
    flag(value);
    const {events} = await observe(async () => {
      await send({method: 'initialize', params: {protocolVersion: '2025-11-25', capabilities: {}}});
      await send({method: 'resources/read', params: {uri: ATTACHMENT_URI}});
      await send({method: 'tools/call', params: {name: 'open_attachment_reader', arguments: {}}});
      await send({method: `bogus/${SECRET}`});
    });
    assert.deepEqual(events, [], String(value));
  }
});

test('flag on: protocol methods log enum fields, versions and the resource size only', async () => {
  flag('1');
  let read;
  const {events} = await observe(async () => {
    await send({method: 'initialize', params: {protocolVersion: '2025-11-25', capabilities: {extensions: {'io.modelcontextprotocol/ui': {mimeTypes: ['text/html;profile=mcp-app']}}}, clientInfo: {name: SECRET, version: SECRET}}});
    await send({method: 'server/discover', params: {_meta: {'io.modelcontextprotocol/protocolVersion': '2026-07-28', 'io.modelcontextprotocol/clientCapabilities': {extensions: {'io.modelcontextprotocol/ui': {mimeTypes: [SECRET]}}}}}});
    await send({method: 'tools/list'}, {headers: {'mcp-protocol-version': '2026-07-28'}});
    await send({method: 'resources/list'}, {headers: {'mcp-protocol-version': `${SECRET}`}});
    read = await send({method: 'resources/read', params: {uri: ATTACHMENT_URI, _meta: {'io.modelcontextprotocol/clientCapabilities': {}}}});
    await send({method: 'resources/read', params: {uri: SAVED_URI}});
  });
  assert.equal(read.body.result.contents[0].text, attachmentReaderHtml, 'response unchanged');
  assert.deepEqual(events, [
    {level: 'info', event: 'sundark_mcp_observation', method: 'initialize', requestedVersion: '2025-11-25', uiCapability: 'mcp_app', outcome: 'ok', protocolVersion: '2026-07-28'},
    {level: 'info', event: 'sundark_mcp_observation', method: 'server/discover', requestedVersion: '2026-07-28', uiCapability: 'other', outcome: 'ok', protocolVersion: '2026-07-28'},
    {level: 'info', event: 'sundark_mcp_observation', method: 'tools/list', requestedVersion: '2026-07-28', outcome: 'ok'},
    {level: 'info', event: 'sundark_mcp_observation', method: 'resources/list', outcome: 'ok'},
    {level: 'info', event: 'sundark_mcp_observation', method: 'resources/read', resource: 'attachment', uiCapability: 'absent', outcome: 'ok', bytes: Buffer.byteLength(attachmentReaderHtml)},
    {level: 'info', event: 'sundark_mcp_observation', method: 'resources/read', resource: 'saved', outcome: 'ok', bytes: events[5]?.bytes},
  ]);
  assert(events[5].bytes > 0);
});

test('flag on: whitelisted tool calls map to enum names, other tools to other; no storage', async () => {
  flag('1');
  let read, original;
  const {events, all} = await observe(async () => {
    read = await send({method: 'tools/call', params: {name: 'read_attached_pdf', arguments: {file}}});
    const sourceHash = read.body.result.structuredContent.sourceHash;
    await send({method: 'tools/call', params: {name: 'render_attached_reader', arguments: {file, page: 1, sourceHash}}});
    const pdfSha256 = read.body.result.structuredContent.attachment.pdfSha256;
    original = await send({method: 'tools/call', params: {name: 'read_attachment_original', arguments: {file, pdfSha256, offset: 0}}});
    await send({method: 'tools/call', params: {name: 'read_attachment_original', arguments: {file, pdfSha256: '0'.repeat(64), offset: 0}}});
    await send({method: 'tools/call', params: {name: 'prepare_attachment_task', arguments: {file, pages: [1], kind: 'summary'}}});
    await send({method: 'tools/call', params: {name: 'open_attachment_reader', arguments: {}}});
    await send({method: 'tools/call', params: {name: 'open_pdf_file', arguments: {file: {name: `${SECRET}.pdf`, resourceUri: `x://${SECRET}`}}}});
    await send({method: 'tools/call', params: {name: `tool-${SECRET}`, arguments: {}}});
  });
  assert.equal(read.body.result.isError, undefined);
  const chunk = original.body.result._meta['sundark/originalChunk'];
  assert.equal(Buffer.from(chunk, 'base64').length, pdf.length);
  // Neither the original's bytes nor its arguments reach the log: enum, status and reason only.
  assert(!all.includes(chunk.slice(0, 64)) && !all.includes(read.body.result.structuredContent.attachment.pdfSha256), 'no bytes or digest logged');
  assert.deepEqual(events.map(e => [e.method, e.tool, e.outcome, e.status, e.reason]), [
    ['tools/call', 'read_attached', 'ok', undefined, undefined],
    ['tools/call', 'render_attached', 'ok', undefined, undefined],
    ['tools/call', 'original', 'ok', undefined, undefined],
    ['tools/call', 'original', 'error', 409, 'source_changed'],
    ['tools/call', 'prepare', 'ok', undefined, undefined],
    ['tools/call', 'open', 'ok', undefined, undefined],
    ['tools/call', 'open', 'ok', undefined, undefined],
    ['tools/call', 'other', 'error', 400, 'invalid'],
  ]);
});

test('flag on: errors, refusals and unknown methods are sanitized classes', async () => {
  flag('1');
  const responses = [];
  const {events, all} = await observe(async () => {
    responses.push(await send({method: 'tools/call', params: {name: 'read_attached_pdf', arguments: {file: {download_url: `https://cdn.example.com/p/${SECRET}.pdf?sig=${SECRET}`, file_id: `file-${SECRET}`}}}}));
    responses.push(await send({method: 'tools/call', params: {name: 'render_paper_reader', arguments: {id: SECRET, page: 1}}}, {auth: false}));
    responses.push(await send({method: 'resources/read', params: {uri: `ui://sundark/${SECRET}.html?token=${SECRET}`}}));
    responses.push(await send({method: `bogus/${SECRET}`, params: {secret: SECRET}}));
    responses.push(await send({jsonrpc: '2.0', method: 'notifications/initialized'}));
    responses.push(await send(`{"jsonrpc":"2.0","id":1,"method":"${SECRET}"`, {raw: true}));
    responses.push(await send({method: 'tools/list'}, {headers: {origin: `https://${SECRET}.example`}}));
    responses.push(await send({method: 'tools/list'}, {headers: {'content-type': 'text/plain'}}));
  });
  assert.deepEqual(events.map(({level, method, tool, resource, outcome, status, reason}) => ({level, method, tool, resource, outcome, status, reason})), [
    {level: 'error', method: 'tools/call', tool: 'read_attached', resource: undefined, outcome: 'error', status: 400, reason: 'unsupported_host'},
    {level: 'error', method: 'tools/call', tool: 'saved_render', resource: undefined, outcome: 'error', status: 401, reason: 'auth'},
    {level: 'error', method: 'resources/read', tool: undefined, resource: 'other', outcome: 'error', status: 404, reason: 'not_found'},
    {level: 'error', method: 'other', tool: undefined, resource: undefined, outcome: 'unsupported', status: undefined, reason: 'method_not_found'},
    {level: 'error', method: 'notifications/initialized', tool: undefined, resource: undefined, outcome: 'unsupported', status: undefined, reason: 'method_not_found'},
    {level: 'error', method: 'other', tool: undefined, resource: undefined, outcome: 'error', status: undefined, reason: 'parse'},
    {level: 'error', method: 'other', tool: undefined, resource: undefined, outcome: 'error', status: 403, reason: 'origin'},
    {level: 'error', method: 'other', tool: undefined, resource: undefined, outcome: 'error', status: 415, reason: 'content_type'},
  ]);
  assert(!all.includes(SECRET), 'no marker anywhere in console output');
  // Responses keep their existing shape: HTTP 200, an isError result or a -32601 error.
  assert(responses.every(r => r.status === 200));
  assert.equal(responses[3].body.error.code, -32601);
  assert.equal(responses[0].body.result.isError, true);
  assert.match(responses[0].body.result.content[0].text, /unsupported_host/);
  flag(undefined);
});
