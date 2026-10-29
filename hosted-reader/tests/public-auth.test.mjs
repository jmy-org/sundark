// Public audience: the platform no longer guarantees identity, so the app must.
// 1. Anonymous callers get 401 (API) or an MCP error before any D1/R2 access, on every route
//    and every listed tool, and anonymous /original never returns the reader HTML.
// 2. Two signed-in users (synthetic Site-scoped IDs) share one D1/R2 and cannot read, change or
//    enumerate each other's records, through the REST API or MCP tools.
// D1 is node:sqlite with the real drizzle migrations; R2 is an in-memory Map. Synthetic data only.
// Platform header stripping (a forged oai-authenticated-user-id on a public Site) cannot be
// tested here: that is a hosted gate.
import assert from 'node:assert/strict';
import {readdirSync, readFileSync} from 'node:fs';
import {register} from 'node:module';
import {DatabaseSync} from 'node:sqlite';
import test from 'node:test';
import {twoPagePdf} from './fixtures/synthetic-pdf.mjs';

register('./fixtures/worker-loader.mjs', import.meta.url);

function d1(sqlite) {
  const value = v => v === undefined ? null : typeof v === 'boolean' ? Number(v) : v instanceof ArrayBuffer ? new Uint8Array(v) : v;
  const statement = (sql, params = []) => ({
    bind: (...args) => statement(sql, args.map(value)),
    async first(column) { const row = sqlite.prepare(sql).get(...params) ?? null; return column && row ? row[column] : row; },
    async all() { return {results: sqlite.prepare(sql).all(...params), success: true, meta: {}}; },
    async run() { const r = sqlite.prepare(sql).run(...params); return {results: [], success: true, meta: {changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid)}}; },
    _exec() { const s = sqlite.prepare(sql); return s.columns().length ? {results: s.all(...params), success: true, meta: {changes: 0}} : {results: [], success: true, meta: {changes: Number(s.run(...params).changes)}}; },
  });
  return {
    prepare: sql => statement(sql),
    async batch(list) {
      sqlite.exec('BEGIN');
      try { const out = list.map(s => s._exec()); sqlite.exec('COMMIT'); return out; } catch (e) { sqlite.exec('ROLLBACK'); throw e; }
    },
  };
}
function r2() {
  const objects = new Map();
  const bytes = async v => v instanceof Uint8Array ? new Uint8Array(v) : v instanceof ArrayBuffer ? new Uint8Array(v) : typeof v === 'string' ? new TextEncoder().encode(v) : new Uint8Array(await new Response(v).arrayBuffer());
  const object = (key, o) => ({key, size: o.data.length, httpMetadata: o.httpMetadata, customMetadata: o.customMetadata,
    get body() { return new Response(o.data).body; }, arrayBuffer: async () => o.data.slice().buffer, text: async () => new TextDecoder().decode(o.data),
    writeHttpMetadata(h) { if (o.httpMetadata?.contentType) h.set('content-type', o.httpMetadata.contentType); }});
  return {
    objects,
    async put(key, v, opts = {}) { objects.set(key, {data: await bytes(v), httpMetadata: opts.httpMetadata, customMetadata: opts.customMetadata}); return object(key, objects.get(key)); },
    async get(key) { const o = objects.get(key); return o ? object(key, o) : null; },
    async head(key) { const o = objects.get(key); return o ? object(key, o) : null; },
    async delete(keys) { for (const k of [].concat(keys)) objects.delete(k); },
  };
}

const sqlite = new DatabaseSync(':memory:');
for (const file of readdirSync(new URL('../drizzle/', import.meta.url)).filter(f => f.endsWith('.sql')).sort())
  for (const sql of readFileSync(new URL(`../drizzle/${file}`, import.meta.url), 'utf8').split('--> statement-breakpoint')) if (sql.trim()) sqlite.exec(sql);
const live = {DB: d1(sqlite), BUCKET: r2()};
let deny = false;
const storage = [];
globalThis.__workerEnv = new Proxy({}, {
  get(target, key) {
    if (key === 'DB' || key === 'BUCKET') { storage.push(String(key)); if (deny) throw new Error(`storage access: ${String(key)}`); return live[key]; }
    return target[key];
  },
});

const ORIGIN = 'https://site.example';
const A = {'oai-authenticated-user-id': 'synthetic-user-a', 'oai-authenticated-user-email': 'a@example.invalid'};
const B = {'oai-authenticated-user-id': 'synthetic-user-b', 'oai-authenticated-user-email': 'b@example.invalid'};
const NOBODY = {};
const UUID = '00000000-0000-4000-8000-000000000001';
const mod = path => import(new URL(`../app/${path}`, import.meta.url));
const routes = {
  'api/papers': await mod('api/papers/route.ts'),
  'api/papers/[id]': await mod('api/papers/[id]/route.ts'),
  'api/papers/[id]/analysis': await mod('api/papers/[id]/analysis/route.ts'),
  'api/papers/[id]/content': await mod('api/papers/[id]/content/route.ts'),
  'api/papers/[id]/file': await mod('api/papers/[id]/file/route.ts'),
  'api/papers/[id]/review': await mod('api/papers/[id]/review/route.ts'),
  'api/papers/[id]/figures': await mod('api/papers/[id]/figures/route.ts'),
  'api/papers/[id]/figures/[figureId]/file': await mod('api/papers/[id]/figures/[figureId]/file/route.ts'),
};
const {POST: mcpPost} = await mod('mcp/route.ts');
const {GET: originalGet} = await mod('original/route.ts');
const {chatGPTSignInPath} = await import('../app/chatgpt-auth.ts');
const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'];

async function as(who, run) {
  globalThis.__requestHeaders = new Headers(who);
  try { return await run(); } finally { globalThis.__requestHeaders = undefined; }
}
async function api(who, route, method, {id = UUID, figureId = UUID, query = '', body, type = 'application/json'} = {}) {
  const path = route.replace('[id]', id).replace('[figureId]', figureId);
  const init = {method, headers: {Origin: ORIGIN}};
  if (body !== undefined) { init.body = type === 'application/json' ? JSON.stringify(body) : body; init.headers['Content-Type'] = type; }
  const res = await as(who, () => routes[route][method](new Request(`${ORIGIN}/${path}${query}`, init), {params: Promise.resolve({id, figureId})}));
  const text = res.headers.get('content-type')?.includes('json') ? await res.text() : '';
  return {status: res.status, json: text ? JSON.parse(text) : null, res};
}
async function rpc(who, method, params) {
  const res = await as(who, () => mcpPost(new Request(`${ORIGIN}/mcp`, {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({jsonrpc: '2.0', id: 1, method, params})})));
  return (await res.json()).result;
}
const tool = async (who, name, args) => { const r = await rpc(who, 'tools/call', {name, arguments: args}); return r.isError ? r : JSON.parse(r.content[0].text); };
async function noStorage(run) {
  deny = true; const before = storage.length;
  try { return await run(); } finally { deny = false; assert.equal(storage.length, before, 'no D1/R2 access'); }
}

test('anonymous: every exported API handler returns 401 before any D1/R2 access', async () => {
  let handlers = 0;
  for (const [route, m] of Object.entries(routes)) for (const method of METHODS) {
    if (!m[method]) continue;
    handlers++;
    const body = method === 'GET' ? undefined : {title: 'SYNTHETIC', page: 1};
    const r = await noStorage(() => api(NOBODY, route, method, {body}));
    assert.equal(r.status, 401, `${method} /${route}`);
    assert.equal(r.res.headers.get('cache-control'), 'private, no-store', `${method} /${route}`);
  }
  assert.equal(handlers, 13, 'all API handlers covered');
});

test('anonymous: every listed MCP tool errors before any D1/R2 access or download', async () => {
  const {tools} = await rpc(NOBODY, 'tools/list', {});
  assert(tools.length >= 20);
  const file = {download_url: 'https://files.oaiusercontent.com/synthetic.pdf', file_id: 'file-SYNTHETIC', file_name: 'synthetic.pdf'};
  for (const {name} of [...tools, {name: 'unknown_tool'}]) {
    const r = await noStorage(() => rpc(NOBODY, 'tools/call', {name, arguments: {id: UUID, file, page: 1, pages: [1], query: ''}}));
    assert.equal(r.isError, true, name);
    assert.equal(r.content[0].text, '로그인이 필요합니다.', name);
    assert.equal(r.structuredContent, undefined, name);
    assert.equal(r._meta, undefined, name);
  }
});

test('anonymous: /original redirects to Sites sign-in without returning the reader', async () => {
  await noStorage(() => as(NOBODY, () => assert.rejects(originalGet(new Request(`${ORIGIN}/original?paper=${UUID}`)), /redirect/)));
  assert.equal(chatGPTSignInPath(`/original?paper=${UUID}`), `/signin-with-chatgpt?return_to=${encodeURIComponent(`/original?paper=${UUID}`)}`);
  assert.equal(chatGPTSignInPath('//evil.example/'), '/signin-with-chatgpt?return_to=%2F');
  const signedIn = await as(A, () => originalGet(new Request(`${ORIGIN}/original`)));
  assert.equal(signedIn.status, 200);
  assert.equal(signedIn.headers.get('cache-control'), 'private, no-store');
});

test('two signed-in users cannot reach each other\'s library', async () => {
  // User A builds a library through the same routes a browser and the plugin use.
  const created = await api(A, 'api/papers', 'POST', {body: {title: 'SYNTHETIC A PAPER', notes: 'A private note'}});
  assert.equal(created.status, 201);
  const aPaper = created.json.paper.id;
  const pdf = twoPagePdf();
  assert.equal((await api(A, 'api/papers/[id]/file', 'POST', {id: aPaper, body: pdf, type: 'application/pdf'})).status, 200);
  const imported = await tool(A, 'import_paper_text', {title: 'SYNTHETIC A TEXT', pages: [{text: 'Synthetic source sentence for user A.'}]});
  const aText = imported.id;
  assert(aText);
  const src = await tool(A, 'read_paper_source', {id: aText, pages: [1]});
  const saved = await tool(A, 'save_paper_analysis', {id: aText, requestId: crypto.randomUUID(), kind: 'summary', language: 'en', sourceHash: src.sourceHash, sourcePages: [1], content: {text: 'Synthetic A summary', citations: []}});
  assert.equal(saved.saved, true);
  const fileKey = sqlite.prepare('SELECT file_key FROM papers WHERE id=?').get(aPaper).file_key;
  const aFigure = crypto.randomUUID();
  await live.BUCKET.put(`figures/${aPaper}/${aFigure}.png`, new Uint8Array([137, 80, 78, 71]));
  sqlite.prepare('INSERT INTO paper_figures (id,paper_id,owner,file_version,page,label,bbox,width,height,object_key,byte_size,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)')
    .run(aFigure, aPaper, A['oai-authenticated-user-id'], String(fileKey).split('/').pop(), 1, 'SYNTHETIC', '[0,0,1,1]', 1, 1, `figures/${aPaper}/${aFigure}.png`, 4, new Date().toISOString());
  const snapshot = () => JSON.stringify(['papers', 'page_contents', 'analysis_artifacts', 'paper_figures'].map(t => sqlite.prepare(`SELECT * FROM ${t} ORDER BY id`).all()));
  const before = snapshot();
  const r2Before = [...live.BUCKET.objects.keys()].sort().join();

  // User B: own empty library, A's IDs are 404 on every route and method.
  assert.deepEqual((await api(B, 'api/papers', 'GET')).json.papers, []);
  for (const id of [aPaper, aText]) {
    for (const [route, method, opts] of [
      ['api/papers/[id]', 'GET'], ['api/papers/[id]', 'PATCH', {body: {title: 'stolen'}}],
      ['api/papers/[id]/analysis', 'GET'], ['api/papers/[id]/review', 'GET'],
      ['api/papers/[id]/content', 'GET', {query: '?page=1'}], ['api/papers/[id]/content', 'PUT', {body: {fileVersion: 'x', page: 1, method: 'ocr', confidence: 1, width: 1, height: 1, segments: []}}],
      ['api/papers/[id]/file', 'GET'], ['api/papers/[id]/file', 'POST', {body: pdf, type: 'application/pdf'}],
      ['api/papers/[id]/figures', 'GET'], ['api/papers/[id]/figures/[figureId]/file', 'GET', {figureId: aFigure}],
    ]) assert.equal((await api(B, route, method, {id, ...opts})).status, 404, `B ${method} /${route} on A`);
    for (const [name, args] of [
      ['read_paper_notes', {}], ['list_paper_sources', {}], ['read_paper_source', {pages: [1]}], ['read_paper_page', {page: 1}],
      ['read_paper_analysis', {}], ['render_paper_reader', {page: 1}], ['prepare_paper_task', {kind: 'summary', pages: [1], language: 'en'}],
      ['list_paper_figures', {}], ['read_paper_figure', {figureId: aFigure}], ['extract_paper_pages', {pages: [1]}],
      ['save_paper_analysis', {requestId: crypto.randomUUID(), kind: 'summary', language: 'en', sourceHash: src.sourceHash, sourcePages: [1], content: {text: 'stolen', citations: []}}],
    ]) assert.equal((await tool(B, name, {id, ...args})).isError, true, `B ${name} on A`);
  }
  assert.deepEqual(await tool(B, 'search_library', {query: 'SYNTHETIC'}), []);
  assert.equal(snapshot(), before, 'A data unchanged by B');
  assert.equal([...live.BUCKET.objects.keys()].sort().join(), r2Before, 'R2 unchanged by B');

  // B's own records stay B's, and A still reads its own data.
  const bPaper = (await api(B, 'api/papers', 'POST', {body: {title: 'SYNTHETIC B PAPER'}})).json.paper.id;
  assert.equal((await api(A, 'api/papers/[id]', 'GET', {id: bPaper})).status, 404);
  assert.deepEqual((await api(A, 'api/papers', 'GET')).json.papers.map(p => p.id).sort(), [aPaper, aText].sort());
  const aFile = await api(A, 'api/papers/[id]/file', 'GET', {id: aPaper});
  assert.equal(aFile.status, 200);
  assert.deepEqual(new Uint8Array(await aFile.res.arrayBuffer()), new Uint8Array(pdf));
  assert.equal((await api(A, 'api/papers/[id]/figures/[figureId]/file', 'GET', {id: aPaper, figureId: aFigure})).status, 200);
  assert.equal((await tool(A, 'read_paper_notes', {id: aPaper})).notes, 'A private note');
  assert.deepEqual(sqlite.prepare('SELECT owner, count(*) AS n FROM papers GROUP BY owner ORDER BY owner').all().map(r => [r.owner, r.n]),
    [['synthetic-user-a', 2], ['synthetic-user-b', 1]]);
});
