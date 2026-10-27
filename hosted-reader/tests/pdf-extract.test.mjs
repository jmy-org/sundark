// Server extraction against a fake Workers env: node:sqlite stands in for D1 (with the real
// drizzle/ migrations) and a Map for R2, so a reader write can be interleaved deterministically.
// Synthetic PDFs and identities only.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {register} from 'node:module';
import {DatabaseSync} from 'node:sqlite';
import test from 'node:test';
import {mixedScanPdf, twoPagePdf} from './fixtures/synthetic-pdf.mjs';

register('./fixtures/worker-loader.mjs', import.meta.url);
const root = new URL('../', import.meta.url);
const sqlite = new DatabaseSync(':memory:');
for (const {tag} of JSON.parse(readFileSync(new URL('drizzle/meta/_journal.json', root))).entries)
  for (const statement of readFileSync(new URL(`drizzle/${tag}.sql`, root), 'utf8').split('--> statement-breakpoint')) sqlite.exec(statement);
const hooks = {beforePageInsert: null};
const DB = {
  prepare(sql) {
    let args = [];
    const statement = {
      bind(...values) { args = values; return statement; },
      async run() {
        const hook = /^INSERT INTO page_contents/.test(sql) && hooks.beforePageInsert;
        if (hook) { hooks.beforePageInsert = null; await hook(args); }
        return {meta: {changes: Number(sqlite.prepare(sql).run(...args).changes)}};
      },
      async first() { return sqlite.prepare(sql).get(...args) ?? null; },
      async all() { return {results: sqlite.prepare(sql).all(...args)}; },
    };
    return statement;
  },
};
const objects = new Map();
const BUCKET = {
  async get(key) { const bytes = objects.get(key); return bytes ? {size: bytes.length, arrayBuffer: async () => bytes.slice().buffer} : null; },
  async put(key, bytes) { objects.set(key, new Uint8Array(bytes)); },
  async delete(key) { objects.delete(key); },
};
globalThis.__workerEnv = {DB, BUCKET};
const {extractPages, importPdf} = await import('../lib/pdf-import.ts');
const {savePageContent} = await import('../lib/page-content.ts');
const {sha256Hex} = await import('../lib/pdf-store.ts');

const OWNER = 'synthetic-owner';
let n = 0;
async function paper(bytes, extra = {}) {
  const id = `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`;
  const key = `papers/${id}/${crypto.randomUUID()}.pdf`;
  objects.set(key, new Uint8Array(bytes));
  const cols = {id, owner: OWNER, title: 'SYNTHETIC', file_name: 'synthetic.pdf', file_key: key, size: bytes.length, updated_at: '2026-01-01', ...extra};
  sqlite.prepare(`INSERT INTO papers (${Object.keys(cols).join(',')}) VALUES (${Object.keys(cols).map(() => '?').join(',')})`).run(...Object.values(cols));
  return {id, key};
}
const row = (id, page) => sqlite.prepare('SELECT * FROM page_contents WHERE paper_id=? AND page=?').get(id, page);
const range = (a, b) => Array.from({length: b - a + 1}, (_, i) => a + i);

test('20 pages, 1-16 scanned: nextPages reaches 17-20, ends, and never repeats a page', async () => {
  const requestId = crypto.randomUUID(), fileId = 'file-synthetic-mixed';
  const {id} = await paper(mixedScanPdf(), {import_request_id: requestId, import_file_hash: await sha256Hex(new TextEncoder().encode(fileId))});
  const attempted = [];
  let e = await extractPages(OWNER, {id, pages: [1, 2, 3, 4]});
  attempted.push(1, 2, 3, 4);
  for (let calls = 0; e.nextPages.length && calls < 10; calls++) { attempted.push(...e.nextPages); e = await extractPages(OWNER, {id, pages: e.nextPages}); }
  assert.deepEqual(e.nextPages, [], 'continuation ends');
  assert.deepEqual(e.extractedPages, range(17, 20), 'every text page is extracted');
  assert.deepEqual(e.needsOcrPages, range(1, 16), 'scanned pages stay reported');
  assert.deepEqual(e.missingPages, range(1, 16));
  assert.equal(e.complete, false, 'scanned pages are not reported as extracted');
  assert.equal(new Set(attempted).size, attempted.length, `no page offered twice: ${attempted}`);
  for (const page of range(1, 16)) assert.equal(row(id, page), undefined, 'no invented source for a scanned page');
  // A replay reports the same terminal outcomes without extracting again.
  const again = await importPdf(OWNER, {requestId, file: {file_id: fileId, download_url: 'https://files.oaiusercontent.com/rotated'}});
  assert.equal(again.idempotent, true);
  assert.deepEqual(again.extraction.needsOcrPages, range(1, 16));
  assert.deepEqual(again.extraction.extractedPages, range(17, 20));
  assert.deepEqual(again.extraction.nextPages, []);
  // An explicit request still retries a terminal page, honestly.
  const retry = await extractPages(OWNER, {id, pages: [3]});
  assert.deepEqual(retry.needsOcrPages, range(1, 16));
  assert.deepEqual(retry.nextPages, []);
});

async function readerSegments(bytes, page) {
  const pdf = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const {buildSentenceSegments, pdfTextAtoms} = await import('../lib/source-geometry.ts');
  const task = pdf.getDocument({data: new Uint8Array(bytes), useWorkerFetch: false, isEvalSupported: false, disableFontFace: true});
  const doc = await task.promise;
  const p = await doc.getPage(page);
  const viewport = p.getViewport({scale: 1});
  const segments = buildSentenceSegments(pdfTextAtoms(await p.getTextContent(), viewport, pdf.Util.transform, page), page, 'ocr');
  await task.destroy();
  return {width: viewport.width, height: viewport.height, segments: segments.map((s, i) => i ? s : {...s, text: 'SYNTHETIC READER CORRECTION.'})};
}

test('a reader save that lands mid-extraction is kept, not overwritten', async () => {
  const bytes = twoPagePdf();
  const {id} = await paper(bytes);
  const p = sqlite.prepare('SELECT * FROM papers WHERE id=?').get(id);
  const reader = await readerSegments(bytes, 1);
  hooks.beforePageInsert = async () => { await savePageContent(OWNER, p, 1, {method: 'ocr', confidence: 87, ...reader}); };
  const e = await extractPages(OWNER, {id, pages: [1, 2]});
  assert.equal(hooks.beforePageInsert, null, 'the reader write ran between snapshot and insert');
  assert.equal(row(id, 1).method, 'ocr');
  assert.equal(JSON.parse(row(id, 1).segments)[0].text, 'SYNTHETIC READER CORRECTION.');
  assert.deepEqual(e.alreadySavedPages, [1]);
  assert.deepEqual(e.savedPages, [2]);
  assert.equal(e.error, undefined);
  assert.deepEqual(e.extractedPages, [1, 2]);
  // The reader itself still replaces a server page.
  await savePageContent(OWNER, p, 2, {method: 'ocr', confidence: 90, ...(await readerSegments(bytes, 2))});
  assert.equal(row(id, 2).method, 'ocr');
});

test('a full text quota or a replaced PDF is an error, never "already saved"', async () => {
  const bytes = twoPagePdf();
  const quota = await paper(bytes);
  sqlite.prepare("INSERT INTO page_contents VALUES ('quota-fill',?,?,'x',1,'text',100,1,1,'[]',52428800,'2026-01-01')").run(quota.id, OWNER);
  try {
    const e = await extractPages(OWNER, {id: quota.id, pages: [1]});
    assert.deepEqual([e.savedPages, e.alreadySavedPages, e.deferredPages], [[], [], [1]]);
    assert.match(e.error, /50 MiB/); assert.doesNotMatch(e.error, /replaced/);
  } finally { sqlite.prepare("DELETE FROM page_contents WHERE id='quota-fill'").run(); }
  const replaced = await paper(bytes);
  hooks.beforePageInsert = async () => { sqlite.prepare('UPDATE papers SET file_key=? WHERE id=?').run(`papers/${replaced.id}/replacement.pdf`, replaced.id); };
  const e = await extractPages(OWNER, {id: replaced.id, pages: [1]});
  assert.deepEqual([e.savedPages, e.alreadySavedPages, e.deferredPages], [[], [], [1]]);
  assert.match(e.error, /replaced/); assert.doesNotMatch(e.error, /50 MiB/);
  assert.equal(row(replaced.id, 1), undefined);
});
