// MCP 2026-07-28 result envelopes, through the real /mcp route handler.
// Primary spec (https://modelcontextprotocol.io/specification/2026-07-28):
// - basic/index: every result MUST include resultType; "complete" means a final result.
// - server/utilities/caching: complete results of server/discover, tools/list, resources/list and
//   resources/read MUST carry ttlMs (integer >= 0) and cacheScope ("public" | "private").
// - server/discover: _meta["io.modelcontextprotocol/serverInfo"] {name, version} SHOULD be present.
// - server/resources: an unknown resource MUST be a JSON-RPC error -32602, never empty contents.
// - server/tools: an unknown tool is a protocol error (-32602); a failed call of a known tool is a
//   complete result with isError: true.
// - basic/transports/streamable-http: an invalid Origin MUST get HTTP 403; an accepted notification
//   MUST get 202 with no body.
// The fake Workers env throws on any DB/BUCKET access, so none of these calls can save anything.
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

const ATTACHMENT_URI = 'ui://sundark/attachment-reader-v6.html';
const V4_ATTACHMENT_URI = 'ui://sundark/attachment-reader-v4.html';
const V5_ATTACHMENT_URI = 'ui://sundark/attachment-reader-v5.html';
const SAVED_URI = 'ui://sundark/reader-compat-v4.html';
const OLD_ATTACHMENT_URI = 'ui://sundark/attachment-reader.html', OLD_SAVED_URI = 'ui://sundark/reader-compat-v2.html', V3_SAVED_URI = 'ui://sundark/reader-compat-v3.html';
const MODERN = {'io.modelcontextprotocol/protocolVersion': '2026-07-28', 'io.modelcontextprotocol/clientCapabilities': {extensions: {'io.modelcontextprotocol/ui': {mimeTypes: ['text/html;profile=mcp-app']}}}};
const signedIn = {'oai-authenticated-user-id': 'synthetic-user', 'oai-authenticated-user-email': 'synthetic@example.invalid'};
const file = {download_url: `${origin}/two.pdf`, file_id: 'file-SYNTHETIC', file_name: 'synthetic.pdf'};

async function post(body, {headers = {}, auth = true} = {}) {
  globalThis.__requestHeaders = new Headers(auth ? signedIn : {});
  const before = storage.length;
  try {
    const response = await POST(new Request('https://site.example/mcp', {method: 'POST', headers: {'content-type': 'application/json', 'mcp-protocol-version': '2026-07-28', ...headers},
      body: typeof body === 'string' ? body : JSON.stringify(body)}));
    const text = await response.text();
    return {status: response.status, headers: response.headers, text, body: text ? JSON.parse(text) : undefined};
  } finally {
    globalThis.__requestHeaders = undefined;
    assert.equal(storage.length, before, 'no D1/R2 access');
  }
}
const call = (method, params = {}, options) => post({jsonrpc: '2.0', id: 7, method, params: {...params, _meta: MODERN}}, options);

// Faithful to the spec's JSONRPCResultResponse / JSONRPCErrorResponse: one of result or error, same id.
function complete(r) {
  assert.equal(r.status, 200);
  assert.equal(r.body.jsonrpc, '2.0');
  assert.equal(r.body.id, 7);
  assert.equal(r.body.error, undefined);
  assert.equal(r.body.result.resultType, 'complete');
  return r.body.result;
}
function cacheable(r) {
  const result = complete(r);
  assert(Number.isInteger(result.ttlMs) && result.ttlMs >= 0, 'ttlMs is an integer >= 0');
  assert.equal(result.ttlMs, 0, 'immediately stale: a republish must be picked up on the next read');
  assert.equal(result.cacheScope, 'private', 'never shared across authorization contexts');
  return result;
}
function protocolError(r, code, status = 200) {
  assert.equal(r.status, status);
  assert.equal(r.body.jsonrpc, '2.0');
  assert.equal(r.body.result, undefined, 'a protocol error is not a result');
  assert(Number.isInteger(r.body.error.code));
  assert.equal(r.body.error.code, code);
  assert.equal(typeof r.body.error.message, 'string');
  return r.body.error;
}

test('server/discover: complete, cacheable, with serverInfo; versions, capabilities and instructions unchanged', async () => {
  const result = cacheable(await call('server/discover'));
  assert.deepEqual(result.supportedVersions, ['2026-07-28']);
  assert.deepEqual(result.capabilities, {tools: {}, resources: {}});
  assert.match(result.instructions, /read_attached_pdf/);
  assert.deepEqual(result._meta['io.modelcontextprotocol/serverInfo'], {name: 'sundark-library', version: '2.0.0'});
});

test('tools/list and resources/list: complete and cacheable, payload unchanged', async () => {
  const tools = cacheable(await call('tools/list'));
  assert.deepEqual(Object.keys(tools).sort(), ['cacheScope', 'resultType', 'tools', 'ttlMs']);
  assert(tools.tools.length >= 20);
  for (const t of tools.tools) {
    assert.equal(typeof t.name, 'string');
    assert.equal(t.inputSchema.type, 'object', t.name);
  }
  const resources = cacheable(await call('resources/list'));
  assert.deepEqual(Object.keys(resources).sort(), ['cacheScope', 'resources', 'resultType', 'ttlMs']);
  assert.deepEqual(resources.resources.map(r => [r.uri, r.mimeType]).sort(), [[ATTACHMENT_URI, 'text/html;profile=mcp-app'], [SAVED_URI, 'text/html+skybridge']].sort());
  for (const r of resources.resources) assert.equal(typeof r.name, 'string');
});

test('resources/read: current and alias URIs are complete and cacheable with unchanged contents', async () => {
  for (const [uri, mimeType] of [[ATTACHMENT_URI, 'text/html;profile=mcp-app'], [OLD_ATTACHMENT_URI, 'text/html;profile=mcp-app'], [V4_ATTACHMENT_URI, 'text/html;profile=mcp-app'], [V5_ATTACHMENT_URI, 'text/html;profile=mcp-app'], [SAVED_URI, 'text/html+skybridge'], [OLD_SAVED_URI, 'text/html+skybridge'], [V3_SAVED_URI, 'text/html+skybridge']]) {
    const result = cacheable(await call('resources/read', {uri}));
    assert.deepEqual(Object.keys(result).sort(), ['cacheScope', 'contents', 'resultType', 'ttlMs'], uri);
    assert.equal(result.contents.length, 1);
    assert.equal(result.contents[0].uri, uri);
    assert.equal(result.contents[0].mimeType, mimeType);
    assert.equal(typeof result.contents[0].text, 'string');
  }
  const attachment = complete(await call('resources/read', {uri: ATTACHMENT_URI})).contents[0];
  assert.equal(attachment.text, attachmentReaderHtml);
  assert.deepEqual(attachment._meta.ui.csp, {connectDomains: [], resourceDomains: []});
  assert.deepEqual(attachment._meta['openai/widgetCSP'], {connect_domains: [], resource_domains: []});
  assert.deepEqual(attachment._meta['openai/ui'], {preferredDisplayMode: 'inline', availableDisplayModes: ['inline', 'fullscreen']});
  for (const uri of [OLD_ATTACHMENT_URI, V4_ATTACHMENT_URI, V5_ATTACHMENT_URI])
    assert.deepEqual(complete(await call('resources/read', {uri})).contents[0]._meta['openai/ui'], attachment._meta['openai/ui'], uri);
  // The saved-paper reader is a different resource and keeps its metadata.
  assert.equal(complete(await call('resources/read', {uri: SAVED_URI})).contents[0]._meta['openai/ui'], undefined);
});

test('resources/read: an unknown resource is a JSON-RPC -32602 error, not an isError result', async () => {
  const uri = 'ui://sundark/attachment-reader-v1.html';
  const error = protocolError(await call('resources/read', {uri}), -32602);
  assert.equal(error.message, 'Resource not found');
  assert.deepEqual(error.data, {uri});
  protocolError(await call('resources/read', {}), -32602);
});

test('tools/call: success and tool execution errors are complete results; an unknown tool is a protocol error', async () => {
  const ok = complete(await call('tools/call', {name: 'read_attached_pdf', arguments: {file}}));
  assert.notEqual(ok.isError, true);
  assert.equal(ok.content[0].type, 'text');
  assert.deepEqual(JSON.parse(ok.content[0].text), ok.structuredContent);
  assert.equal(typeof ok.structuredContent.sourceHash, 'string');

  const failed = complete(await call('tools/call', {name: 'read_attached_pdf', arguments: {file: {...file, download_url: 'https://cdn.example.com/p/synthetic.pdf'}}}));
  assert.equal(failed.isError, true);
  assert.match(failed.content[0].text, /unsupported_host/);

  const anonymous = complete(await call('tools/call', {name: 'render_paper_reader', arguments: {id: 'x', page: 1}}, {auth: false}));
  assert.equal(anonymous.isError, true, 'missing sign-in stays a tool execution error');
  assert.equal(anonymous.content[0].text, '로그인이 필요합니다.');

  const unknown = protocolError(await call('tools/call', {name: 'no_such_tool', arguments: {}}), -32602);
  assert.match(unknown.message, /Unknown tool/);
});

test('transport: unknown methods, notifications and refused requests', async () => {
  assert.equal(protocolError(await call('prompts/list'), -32601).message, 'Method not found');
  const note = await post({jsonrpc: '2.0', method: 'notifications/initialized'});
  assert.equal(note.status, 202);
  assert.equal(note.text, '');
  const cross = protocolError(await call('tools/list', {}, {headers: {origin: 'https://widget.example'}}), -32600, 403);
  assert.match(cross.message, /Cross-origin/);
  protocolError(await call('tools/list', {}, {headers: {'content-type': 'text/plain'}}), -32600, 415);
  const parse = await post('{"jsonrpc":"2.0","id":7,"method":"tools/list"');
  protocolError(parse, -32700, 400);
  assert.equal(parse.body.id, null);
});

test('transport: a JSON array (batch) body is an invalid request, never an accepted notification', async () => {
  // streamable-http: the POST body MUST be a single JSON-RPC request or notification.
  for (const body of [[], [{jsonrpc: '2.0', id: 7, method: 'tools/list'}], [{jsonrpc: '2.0', method: 'notifications/initialized'}]]) {
    const r = await post(body);
    protocolError(r, -32600, 400);
    assert.equal(r.body.id, null, JSON.stringify(body));
  }
  const tool = await post([{jsonrpc: '2.0', id: 7, method: 'tools/call', params: {name: 'read_attached_pdf', arguments: {file}}}]);
  protocolError(tool, -32600, 400);
  // A single notification object is still accepted.
  assert.equal((await post({jsonrpc: '2.0', method: 'notifications/initialized'})).status, 202);
});
