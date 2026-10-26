// Ephemeral ChatGPT attachment reading: no D1 row, no R2 object, not even temporarily.
// The fake Workers env throws on any DB/BUCKET access and counts it, so every path below
// (happy, error, retry, concurrent, route) proves zero storage access. Synthetic PDFs only.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import http from 'node:http';
import {register} from 'node:module';
import test from 'node:test';
import {encryptedPdf, manyPagePdf, mixedScanPdf, scannedPdf, twoPagePdf} from './fixtures/synthetic-pdf.mjs';

register('./fixtures/worker-loader.mjs', import.meta.url);
const storage = [];
const vars = {};
globalThis.__workerEnv = new Proxy(vars, {
  get(target, key) {
    if (key === 'DB' || key === 'BUCKET') { storage.push(String(key)); throw new Error(`storage access: ${String(key)}`); }
    return target[key];
  },
});
const {readAttached, renderAttached, prepareAttachedTask, attachmentLauncher, attachmentFileEntrypoint} = await import('../lib/attachment.ts');
const {MAX_PDF} = await import('../lib/pdf-file.ts');

const routes = new Map();
const server = http.createServer((req, res) => {
  const handler = routes.get(req.url.split('?')[0]);
  if (handler) return handler(req, res);
  res.writeHead(404); res.end('gone');
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const origin = `http://127.0.0.1:${server.address().port}`;
test.after(() => new Promise(r => { server.closeAllConnections(); server.close(r); }));
const serve = (path, bytes) => routes.set(path, (req, res) => { res.writeHead(200, {'Content-Type': 'application/pdf'}); res.end(bytes); });
const status = (path, code) => routes.set(path, (req, res) => { res.writeHead(code); res.end('no'); });
serve('/two.pdf', twoPagePdf());
serve('/many.pdf', manyPagePdf(12));
serve('/mixed.pdf', mixedScanPdf());
serve('/scanned.pdf', scannedPdf());
serve('/encrypted.pdf', encryptedPdf());
routes.set('/html.pdf', (req, res) => { res.writeHead(200); res.end('<html>not a pdf</html>'); });
routes.set('/huge.pdf', (req, res) => { res.writeHead(200); const chunk = Buffer.alloc(1024 * 1024, 32); let n = 0; const push = () => { while (n++ < 22) if (!res.write(chunk)) return res.once('drain', push); res.end(); }; push(); });
routes.set('/redirect.pdf', (req, res) => { res.writeHead(302, {Location: '/two.pdf'}); res.end(); });
routes.set('/slow.pdf', (req, res) => { res.writeHead(200); res.write('%PDF-1.4'); });
for (const code of [401, 403, 404, 410]) status(`/expired-${code}.pdf`, code);
status('/broken.pdf', 500);

const deps = {policy: {hosts: [], devOrigin: origin}};
const SECRET = 'SECRET-SIGNATURE';
const file = (path, extra = {}) => ({download_url: `${origin}${path}?sig=${SECRET}`, file_id: 'file-SYNTHETIC-ID', mime_type: 'application/pdf', file_name: 'synthetic.pdf', ...extra});
const range = (a, b) => Array.from({length: b - a + 1}, (_, i) => a + i);
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
function clean(value) {
  const text = JSON.stringify(value);
  assert(!text.includes(SECRET), 'no signed query in output');
  assert(!text.includes('download_url') && !text.includes(origin), 'no download URL in output');
}
async function noStorage(run) {
  const before = storage.length;
  try { return await run(); } finally { assert.equal(storage.length, before, 'no D1/R2 access'); }
}
async function fails(run, reason, check = () => true) {
  const before = storage.length;
  await assert.rejects(run, e => {
    assert.equal(e.reason, reason, `${reason}: ${e.message}`);
    assert(!e.message.includes(SECRET) && !e.message.includes('/expired') && !e.message.includes('file-SYNTHETIC-ID'), e.message);
    return check(e);
  });
  assert.equal(storage.length, before, 'no D1/R2 access on error');
}

test('new attachment modules never import storage', () => {
  for (const path of ['lib/attachment.ts', 'lib/pdf-extract.ts']) {
    const source = readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
    for (const name of ['database', 'bucket', 'pdf-store', 'page-content', 'savePageContent', 'recordOutcome'])
      assert(!new RegExp(`\\b${name}\\b`).test(source), `${path} must not reference ${name}`);
  }
});

test('read: first page by default, ephemeral contract, nothing stored', async () => {
  const r = await noStorage(() => readAttached({file: file('/two.pdf')}, deps));
  clean(r);
  assert.equal(r.mode, 'ephemeral');
  assert.equal(r.persistent, false);
  assert.deepEqual(r.attachment, {fileId: 'file-SYNTHETIC-ID', fileName: 'synthetic.pdf', pdfSha256: sha(twoPagePdf()), numPages: 2});
  assert.equal(r.page, 1);
  assert.deepEqual(r.pages.map(p => p.page), [1]);
  assert(r.pages[0].width > 0 && r.pages[0].height > 0);
  assert(r.pages[0].segments.some(s => s.text.includes('Plants use light to grow.')));
  assert.match(r.sourceHash, /^[0-9a-f]{64}$/);
  assert.equal(r.pages[0].sourceHash, r.sourceHash);
  assert.deepEqual(r.translations, []);
  assert.deepEqual([r.nextPages, r.needsOcrPages, r.failedPages, r.deferredPages, r.attemptedPages, r.unreadPages], [[2], [], [], [], [1], []]);
  assert.deepEqual([r.complete, r.reportedComplete, r.progressBasis, r.pageLimit, r.extractablePages], [false, false, 'caller-reported', 200, 2]);
  assert(r.translation.batches.every(b => b.language === 'Korean'));
  assert.deepEqual(r.translation.batches.flatMap(b => b.segmentIds), r.pages[0].segments.map(s => s.id));
  assert(r.translation.batches.every(b => b.page === 1 && b.sourceHash === r.sourceHash));
  assert.match(r.translation.instructions, /Korean/);
  assert.match(r.storageNotice, /did not store/i);
});

test('read: hash is canonical over the original bytes and exact page segments', async () => {
  const a = await readAttached({file: file('/two.pdf'), pages: [2, 1]}, deps);
  const b = await readAttached({file: file('/two.pdf', {file_id: 'file-OTHER-REFERENCE'}), pages: [1]}, deps);
  assert.equal(a.page, 2, 'initial render page is the first requested page');
  assert.deepEqual(a.pages.map(p => p.page), [2, 1]);
  assert.equal(a.pages[1].sourceHash, b.sourceHash, 'same bytes and page give the same hash');
  assert.notEqual(a.pages[0].sourceHash, a.pages[1].sourceHash);
  const other = await readAttached({file: file('/many.pdf')}, deps);
  assert.notEqual(other.sourceHash, b.sourceHash);
});

test('read: page selection is bounded and exact', async () => {
  for (const pages of [[], range(1, 9), [1, 1], [0], [201], [1.5], 'all'])
    await fails(() => readAttached({file: file('/two.pdf'), pages}, deps), 'invalid_pages');
  await fails(() => readAttached({file: file('/two.pdf'), pages: [3]}, deps), 'invalid_pages', e => /2 pages/.test(e.message));
  await fails(() => readAttached({file: file('/two.pdf'), attemptedPages: 'x'}, deps), 'invalid_pages');
});

test('whole document: caller-held visited pages make continuation finite', async () => {
  let r = await noStorage(() => readAttached({file: file('/many.pdf'), pages: range(1, 8)}, deps));
  assert.deepEqual(r.nextPages, range(9, 12));
  r = await noStorage(() => readAttached({file: file('/many.pdf'), pages: r.nextPages, attemptedPages: range(1, 8)}, deps));
  assert.deepEqual(r.pages.map(p => p.page), range(9, 12));
  assert.deepEqual(r.nextPages, []);
  assert.equal(r.reportedComplete, true, 'the caller-held lists cover every page');
  assert.equal(r.complete, false, 'pages read by earlier calls are only caller-reported');
});

test('progress: complete is verified only when this call read every page', async () => {
  const whole = await noStorage(() => readAttached({file: file('/two.pdf'), pages: [1, 2]}, deps));
  assert.deepEqual([whole.complete, whole.reportedComplete, whole.progressBasis], [true, true, 'caller-reported']);
  const claimed = await noStorage(() => readAttached({file: file('/two.pdf'), pages: [2], attemptedPages: [1]}, deps));
  assert.deepEqual(claimed.pages.map(p => p.page), [2]);
  assert.equal(claimed.complete, false, 'attemptedPages [1] is a claim, not proof that page 1 was read');
  assert.equal(claimed.reportedComplete, true);
  assert.equal(claimed.progressBasis, 'caller-reported');
  // Progress copied from another attachment certifies nothing about this one.
  const other = await noStorage(() => readAttached({file: file('/many.pdf'), pages: range(1, 8)}, deps));
  const spoofed = await noStorage(() => readAttached({file: file('/two.pdf'), pages: [2], attemptedPages: other.attemptedPages, unreadPages: other.unreadPages}, deps));
  assert.notEqual(spoofed.attachment.pdfSha256, other.attachment.pdfSha256);
  assert.equal(spoofed.complete, false, 'spoofed progress from another attachment');
  assert.deepEqual(spoofed.attemptedPages, [1, 2], 'pages beyond this PDF are dropped from the hints');
  const scanned = await noStorage(() => readAttached({file: file('/scanned.pdf')}, deps));
  assert.deepEqual([scanned.complete, scanned.reportedComplete], [false, false], 'a page without text is not available source');
  const deferred = await noStorage(() => readAttached({file: file('/two.pdf'), pages: [1, 2]}, {...deps, budgetMs: -1}));
  assert.deepEqual([deferred.deferredPages, deferred.complete], [[2], false]);
});

test('whole document: a long scanned run ends and never repeats a page', async () => {
  const attempted = [];
  const seenText = [], seenOcr = [];
  let pages = [1];
  for (let calls = 0; pages.length && calls < 10; calls++) {
    const r = await noStorage(() => readAttached({file: file('/mixed.pdf'), pages, attemptedPages: attempted}, deps));
    attempted.push(...pages);
    seenOcr.push(...r.needsOcrPages);
    seenText.push(...r.pages.filter(p => p.segments.length).map(p => p.page));
    for (const n of r.needsOcrPages) assert.deepEqual(r.pages.find(p => p.page === n).segments, [], 'no invented text');
    pages = r.nextPages;
  }
  assert.deepEqual(pages, [], 'continuation ends');
  assert.equal(new Set(attempted).size, attempted.length, `no page offered twice: ${attempted}`);
  assert.deepEqual(seenOcr, range(1, 16));
  assert.deepEqual(seenText, range(17, 20));
});

test('scanned and encrypted PDFs: no invented text, nothing stored', async () => {
  const r = await noStorage(() => readAttached({file: file('/scanned.pdf')}, deps));
  assert.deepEqual(r.needsOcrPages, [1]);
  assert.deepEqual(r.pages[0].segments, []);
  assert.deepEqual(r.translation.batches, []);
  await fails(() => readAttached({file: file('/encrypted.pdf')}, deps), 'encrypted');
  await fails(() => readAttached({file: file('/html.pdf')}, deps), 'not_pdf');
});

test('time budget defers pages instead of reading them, and offers them again', async () => {
  const r = await noStorage(() => readAttached({file: file('/many.pdf'), pages: [1, 2, 3]}, {...deps, budgetMs: -1}));
  assert.deepEqual(r.pages.map(p => p.page), [1], 'every call reads at least its first page, so the loop always advances');
  assert.deepEqual(r.deferredPages, [2, 3]);
  assert.equal(r.page, 1);
  assert.deepEqual(r.nextPages, range(2, 9), 'deferred pages were not visited');
  assert.deepEqual(r.attemptedPages, [1], 'deferred pages are not attempted');
  assert.equal(r.complete, false);
});

test('whole document: a page deferred twice is offered again, never dropped', async () => {
  const slow = {...deps, budgetMs: -1};
  // Caller follows the description literally: attemptedPages = every page already requested.
  const first = await noStorage(() => readAttached({file: file('/many.pdf'), pages: [6, 7, 8], attemptedPages: range(1, 5)}, slow));
  assert.deepEqual(first.deferredPages, [7, 8]);
  assert(first.nextPages.includes(7) && first.nextPages.includes(8));
  const second = await noStorage(() => readAttached({file: file('/many.pdf'), pages: first.nextPages, attemptedPages: range(1, 8)}, slow));
  assert(second.deferredPages.includes(8), 'page 8 deferred a second time');
  assert(second.nextPages.includes(8), `twice-deferred page 8 must be offered again: ${second.nextPages}`);
  assert.equal(second.complete, false);
});

test('whole document: echoing attemptedPages/unreadPages ends exactly once every page is read', async () => {
  const slow = {...deps, budgetMs: -1};
  let r = {nextPages: [1], attemptedPages: [], unreadPages: []};
  const read = [];
  for (let calls = 0; r.nextPages.length && calls < 30; calls++) {
    r = await noStorage(() => readAttached({file: file('/many.pdf'), pages: r.nextPages, attemptedPages: r.attemptedPages, unreadPages: r.unreadPages}, slow));
    read.push(...r.pages.map(p => p.page));
    if (r.nextPages.length) assert.equal(r.complete, false, 'not complete while pages remain');
  }
  assert.deepEqual(r.nextPages, []);
  assert.deepEqual(read, range(1, 12), 'each page read exactly once');
  assert.equal(r.reportedComplete, true);
  assert.equal(r.complete, false, 'a multi-call reading is never verified complete');
  assert.deepEqual([r.pageLimit, r.extractablePages, r.attachment.numPages], [200, 12, 12]);
});

test('whole document: scanned or failed pages anywhere keep complete false', async () => {
  let r = {nextPages: [1], attemptedPages: [], unreadPages: []};
  for (let calls = 0; r.nextPages.length && calls < 10; calls++)
    r = await noStorage(() => readAttached({file: file('/mixed.pdf'), pages: r.nextPages, attemptedPages: r.attemptedPages, unreadPages: r.unreadPages}, deps));
  assert.deepEqual(r.nextPages, []);
  assert.deepEqual(r.needsOcrPages, [], 'the last call itself read only text pages');
  assert.deepEqual(r.unreadPages, range(1, 16), 'scanned pages from earlier calls are carried');
  assert.equal(r.complete, false, 'never complete while scanned pages are unread');
  assert.equal(r.reportedComplete, false);
  await fails(() => readAttached({file: file('/mixed.pdf'), unreadPages: 'x'}, deps), 'invalid_pages');
});

test('whole document: a PDF over the page limit reports the limit, never completion', async () => {
  serve('/long.pdf', manyPagePdf(205));
  const r = await noStorage(() => readAttached({file: file('/long.pdf'), pages: range(193, 200), attemptedPages: range(1, 192)}, deps));
  assert.deepEqual(r.nextPages, []);
  assert.deepEqual([r.attachment.numPages, r.pageLimit, r.extractablePages, r.complete, r.reportedComplete], [205, 200, 200, false, false]);
  await fails(() => readAttached({file: file('/long.pdf'), pages: [201]}, deps), 'invalid_pages', e => /200/.test(e.message));
});

test('language: batches and instructions carry the target, and render checks that target', async () => {
  for (const language of ['Japanese', 'Spanish']) {
    const r = await readAttached({file: file('/two.pdf'), language}, deps);
    assert(r.translation.batches.length && r.translation.batches.every(b => b.language === language), language);
    assert.equal(r.translation.language, language);
    assert.match(r.translation.instructions, /same language/i);
    assert.match(r.translation.instructions, new RegExp(language));
  }
  const r = await readAttached({file: file('/two.pdf'), language: 'Spanish'}, deps);
  const es = r.pages[0].segments.map((s, i) => ({id: s.id, text: `Esta es la frase sintética número ${i} que envuelve dos líneas para las comprobaciones de geometría del lector.`}));
  const shown = await noStorage(() => renderAttached({file: file('/two.pdf'), page: 1, sourceHash: r.sourceHash, translations: es, language: 'Spanish'}, deps));
  assert.deepEqual(shown.translations, es);
  assert.equal(shown.translation.language, 'Spanish');
  assert.deepEqual([shown.complete, shown.reportedComplete, shown.progressBasis], [false, false, 'caller-reported'], 'a render claims no read progress');
  const ja = (await readAttached({file: file('/two.pdf'), language: 'Japanese'}, deps)).pages[0].segments.map((s, i) => ({id: s.id, text: `合成された翻訳文${i}です。`}));
  const jaShown = await renderAttached({file: file('/two.pdf'), page: 1, sourceHash: r.sourceHash, translations: ja, language: 'Japanese'}, deps);
  assert.equal(jaShown.translation.language, 'Japanese');
  // A target other than Korean must be resent; Korean checks on Spanish text say so.
  const long = r.pages[0].segments.findIndex(s => s.text.startsWith('This synthetic sentence wraps'));
  await fails(() => renderAttached({file: file('/two.pdf'), page: 1, sourceHash: r.sourceHash, translations: es.slice(0, long + 1)}, deps), 'invalid_translation', e => /language/.test(e.message));
});

test('analysis may cover pages other than the shown page, and stays bound to its own pages', async () => {
  const task = await prepareAttachedTask({file: file('/two.pdf'), pages: [2], kind: 'summary'}, deps);
  assert.doesNotMatch(task.task.instructions, /page = a source page/);
  assert.match(task.task.instructions, /sourcePages/);
  const page1 = (await readAttached({file: file('/two.pdf')}, deps)).sourceHash;
  const seg2 = task.pages[0].segments.find(s => s.text.includes('It has a second sentence.'));
  const content = {text: '합성 요약이다. 두 번째 문장이 있다.', citations: [{page: 2, segmentId: seg2.id, quote: 'It has a second sentence.'}]};
  const analysis = {kind: 'summary', sourcePages: [2], sourceHash: task.task.sourceHash, content};
  const shown = await noStorage(() => renderAttached({file: file('/two.pdf'), page: 1, sourceHash: page1, analysis}, deps));
  assert.equal(shown.page, 1);
  assert.deepEqual(shown.analysis.sourcePages, [2]);
  assert.equal(shown.analysis.coversShownPage, false);
  const seg1 = (await readAttached({file: file('/two.pdf')}, deps)).pages[0].segments.find(s => s.text.includes('Plants use light to grow.'));
  await fails(() => renderAttached({file: file('/two.pdf'), page: 1, sourceHash: page1, analysis: {...analysis, content: {...content, citations: [{page: 1, segmentId: seg1.id, quote: 'Plants use light to grow.'}]}}}, deps), 'invalid_analysis');
  await fails(() => renderAttached({file: file('/two.pdf'), page: 1, sourceHash: page1, analysis: {...analysis, sourcePages: [1]}}, deps), 'source_changed');
  const same = await renderAttached({file: file('/two.pdf'), page: 2, sourceHash: task.pages[0].sourceHash, analysis}, deps);
  assert.equal(same.analysis.coversShownPage, true);
});

test('file reference errors carry a reason and only a safe hostname', async () => {
  const strict = {policy: {hosts: ['files.oaiusercontent.com']}};
  await fails(() => readAttached({}, strict), 'missing');
  await fails(() => readAttached({file: {file_id: 'file-SYNTHETIC-ID'}}, strict), 'missing');
  await fails(() => readAttached({file: {download_url: 'https://files.oaiusercontent.com/x'}}, strict), 'missing');
  await fails(() => readAttached({file: {download_url: 'not a url', file_id: 'f'}}, strict), 'malformed');
  await fails(() => readAttached({file: {download_url: 'x'.repeat(5000), file_id: 'f'}}, strict), 'malformed');
  await fails(() => readAttached({file: {download_url: `https://cdn.example.com/file-1/x.pdf?sig=${SECRET}`, file_id: 'file-SYNTHETIC-ID'}}, strict), 'unsupported_host', e => {
    assert.equal(e.host, 'cdn.example.com');
    assert.match(e.message, /cdn\.example\.com/);
    assert.match(e.message, /SUNDARK_FILE_HOSTS/);
    assert.doesNotMatch(e.message, /attach the PDF again/i, 'a configuration error is not fixed by reattaching');
    assert.doesNotMatch(e.message, /file-1|x\.pdf/);
    return true;
  });
  for (const raw of ['http://files.oaiusercontent.com/f', 'https://user:pw@files.oaiusercontent.com/f', 'https://files.oaiusercontent.com:8443/f',
    'https://127.0.0.1/f', 'https://[::1]/f', 'https://10.0.0.1/f', 'file:///etc/passwd', 'javascript:alert(1)', 'ftp://files.oaiusercontent.com/f'])
    await fails(() => readAttached({file: {download_url: raw, file_id: 'f'}}, strict), 'unsafe_url', e => { assert.equal(e.host, undefined, raw); assert(!e.message.includes('pw')); return true; });
});

test('only an unsupported host logs a diagnostic, with the validated hostname and nothing else', async () => {
  const strict = {policy: {hosts: ['files.oaiusercontent.com']}};
  const logged = [];
  const saved = {};
  for (const level of ['log', 'info', 'warn', 'error', 'debug']) { saved[level] = console[level]; console[level] = (...args) => logged.push({level, args}); }
  try {
    const host = 'oaisdmntprindiasocentral.blob.core.windows.net';
    await fails(() => readAttached({file: {download_url: `https://${host}/file-SYNTHETIC/x.pdf?se=2026&sig=${SECRET}&skoid=TOKEN`, file_id: 'file-SYNTHETIC-ID', file_name: 'private-name.pdf'}}, strict), 'unsupported_host');
    assert.equal(logged.length, 1);
    assert.equal(logged[0].level, 'error');
    assert.equal(logged[0].args.length, 1);
    assert.deepEqual(JSON.parse(logged[0].args[0]), {event: 'sundark_attachment_policy', reason: 'unsupported_host', host});
    for (const leak of [SECRET, 'TOKEN', 'sig=', 'file-SYNTHETIC', 'x.pdf', 'private-name', 'https:'])
      assert(!logged[0].args[0].includes(leak), leak);
    logged.length = 0;
    await fails(() => prepareAttachedTask({file: {download_url: `https://CDN.Example.com/p.pdf?sig=${SECRET}`, file_id: 'file-SYNTHETIC-ID'}, kind: 'summary', pages: [1]}, strict), 'unsupported_host');
    assert.deepEqual(logged.map(l => JSON.parse(l.args[0])), [{event: 'sundark_attachment_policy', reason: 'unsupported_host', host: 'cdn.example.com'}]);
    logged.length = 0;
    for (const raw of ['not a url', 'x'.repeat(5000), 'https://user:pw@evil.example/f', 'https://evil.example:8443/f', 'https://127.0.0.1/f', 'https://[::1]/f',
      'https://ev%20il.example/f', 'https://xn--.example/f', 'http://evil.example/f', 'javascript:alert(1)'])
      await assert.rejects(readAttached({file: {download_url: raw, file_id: 'f'}}, strict));
    await fails(() => readAttached({}, strict), 'missing');
    await fails(() => readAttached({file: file('/expired-403.pdf')}, deps), 'expired');
    await fails(() => readAttached({file: file('/broken.pdf')}, deps), 'download');
    await fails(() => readAttached({file: file('/html.pdf')}, deps), 'not_pdf');
    await readAttached({file: file('/two.pdf')}, deps);
    // pdf.js may print its own font warnings; only the policy event is this code's.
    const text = JSON.stringify(logged);
    assert(!text.includes('sundark_attachment_policy'), 'no policy log for other errors or an allowed URL');
    assert(!text.includes(SECRET) && !text.includes(origin) && !text.includes('evil.example') && !text.includes('pw'), text);
  } finally { Object.assign(console, saved); }
});

test('download errors: expired asks for a fresh reference, others are bounded', async () => {
  for (const code of [401, 403, 404, 410])
    await fails(() => readAttached({file: file(`/expired-${code}.pdf`)}, deps), 'expired', e => /fresh/i.test(e.message));
  await fails(() => readAttached({file: file('/broken.pdf')}, deps), 'download');
  await fails(() => readAttached({file: file('/redirect.pdf')}, deps), 'download');
  await fails(() => readAttached({file: file('/slow.pdf')}, {...deps, timeoutMs: 300}), 'download', e => e.status === 504);
  await fails(() => readAttached({file: file('/huge.pdf')}, deps), 'size', e => /20 MiB/.test(e.message) && e.status === 413);
  assert.equal(MAX_PDF, 20 * 1024 * 1024);
});

test('repeat and concurrent reads are identical and store nothing', async () => {
  const runs = await noStorage(() => Promise.all(Array.from({length: 4}, () => readAttached({file: file('/two.pdf'), pages: [1, 2]}, deps))));
  for (const r of runs) assert.deepEqual(r, runs[0]);
  const again = await noStorage(() => readAttached({file: file('/two.pdf'), pages: [1, 2]}, deps));
  assert.deepEqual(again, runs[0]);
});

test('render: refetches, verifies the hash and shows an ordered translation prefix', async () => {
  const r = await readAttached({file: file('/two.pdf')}, deps);
  const segs = r.pages[0].segments;
  assert(segs.length >= 2, 'fixture has several sentences');
  const ko = segs.map((s, i) => ({id: s.id, text: `합성 번역 문장 ${i}이다.`}));
  const empty = await noStorage(() => renderAttached({file: file('/two.pdf'), page: 1, sourceHash: r.sourceHash}, deps));
  clean(empty);
  assert.deepEqual(empty.translations, []);
  assert.deepEqual(empty.pages, r.pages);
  assert.equal(empty.sourceHash, r.sourceHash);
  assert.equal(empty.persistent, false);
  const partial = await noStorage(() => renderAttached({file: file('/two.pdf'), page: 1, sourceHash: r.sourceHash, translations: ko.slice(0, 1)}, deps));
  assert.deepEqual(partial.translations, ko.slice(0, 1));
  const full = await noStorage(() => renderAttached({file: file('/two.pdf'), page: 1, sourceHash: r.sourceHash, translations: ko}, deps));
  assert.deepEqual(full.translations, ko);
  const bad = (translations, reason = 'invalid_translation') => fails(() => renderAttached({file: file('/two.pdf'), page: 1, sourceHash: r.sourceHash, translations}, deps), reason);
  await bad(ko.slice(1), 'invalid_translation');
  await bad([ko[1], ko[0]]);
  await bad([ko[0], ko[0]]);
  await bad([...ko, {id: 'p1-t2-s999', text: '추가 문장이다.'}]);
  const long = segs.findIndex(s => s.text.startsWith('This synthetic sentence wraps'));
  assert(long > 0);
  await bad([...ko.slice(0, long), {id: segs[long].id, text: segs[long].text}], 'invalid_translation');
  await bad([{id: ko[0].id, text: ''}]);
  await bad('nope');
});

test('render: no fabricated or stale source is accepted', async () => {
  const r = await readAttached({file: file('/two.pdf'), pages: [1, 2]}, deps);
  const render = (args, d = deps) => renderAttached({file: file('/two.pdf'), ...args}, d);
  await fails(() => render({page: 1, sourceHash: 'f'.repeat(64)}), 'source_changed');
  await fails(() => render({page: 2, sourceHash: r.pages[0].sourceHash}), 'source_changed');
  await fails(() => render({page: 1}), 'source_changed');
  await fails(() => render({page: 1, sourceHash: r.sourceHash, segments: [{id: 'x', text: 'fabricated'}]}), 'invalid_arguments');
  const ok = await render({page: 2, sourceHash: r.pages[1].sourceHash});
  assert.equal(ok.page, 2);
  serve('/swap.pdf', twoPagePdf());
  const before = await readAttached({file: file('/swap.pdf')}, deps);
  serve('/swap.pdf', manyPagePdf(2));
  await fails(() => renderAttached({file: file('/swap.pdf'), page: 1, sourceHash: before.sourceHash}, deps), 'source_changed');
  await fails(() => render({page: 0, sourceHash: r.sourceHash}), 'invalid_pages');
  await fails(() => render({page: 3, sourceHash: r.sourceHash}), 'invalid_pages');
});

test('analysis tasks: prepared in memory, validated against fresh pages on render', async () => {
  const task = await noStorage(() => prepareAttachedTask({file: file('/two.pdf'), pages: [1, 2], kind: 'summary'}, deps));
  clean(task);
  assert.deepEqual(task.task.sourcePages, [1, 2]);
  assert.match(task.task.sourceHash, /^[0-9a-f]{64}$/);
  assert.match(task.task.contentShape, /citations/);
  assert.match(task.task.instructions, /Korean/);
  assert.deepEqual(task.pages.map(p => p.page), [1, 2]);
  const seg = task.pages[0].segments.find(s => s.text.includes('Plants use light to grow.'));
  const content = {text: '합성 요약이다. 식물은 빛으로 자란다.', citations: [{page: 1, segmentId: seg.id, quote: 'Plants use light to grow.'}]};
  const page1 = task.pages[0].sourceHash;
  const analysis = {kind: 'summary', sourcePages: [1, 2], sourceHash: task.task.sourceHash, content};
  const shown = await noStorage(() => renderAttached({file: file('/two.pdf'), page: 1, sourceHash: page1, analysis}, deps));
  clean(shown);
  assert.deepEqual(shown.analysis, {kind: 'summary', language: 'Korean', sourcePages: [1, 2], sourceHash: task.task.sourceHash, coversShownPage: true, content});
  const render = extra => renderAttached({file: file('/two.pdf'), page: 1, sourceHash: page1, analysis: {...analysis, ...extra}}, deps);
  await fails(() => render({content: {...content, citations: [{page: 1, segmentId: seg.id, quote: 'Invented quote.'}]}}), 'invalid_analysis');
  await fails(() => render({content: {...content, citations: [{page: 2, segmentId: seg.id, quote: 'Plants use light to grow.'}]}}), 'invalid_analysis');
  await fails(() => render({sourceHash: 'a'.repeat(64)}), 'source_changed');
  await fails(() => render({sourcePages: [2, 1]}), 'source_changed');
  await fails(() => render({kind: 'translation'}), 'invalid_arguments');
  await fails(() => render({kind: 'review'}), 'invalid_analysis');
  const qa = await prepareAttachedTask({file: file('/two.pdf'), pages: [2], kind: 'qa', question: 'What is synthetic?'}, deps);
  assert.equal(qa.task.question, 'What is synthetic?');
  await fails(() => prepareAttachedTask({file: file('/scanned.pdf'), pages: [1], kind: 'summary'}, deps), 'invalid_pages');
  await fails(() => prepareAttachedTask({file: file('/two.pdf'), pages: [1], kind: 'translation'}, deps), 'invalid_arguments');
  await fails(() => prepareAttachedTask({file: file('/two.pdf'), kind: 'summary'}, deps), 'invalid_pages');
});

test('launcher needs no arguments and touches nothing', async () => {
  const l = await noStorage(() => attachmentLauncher());
  assert.equal(l.mode, 'ephemeral');
  assert.equal(l.persistent, false);
  assert.equal(l.attachment, null);
  assert.deepEqual(l.pages, []);
  assert.match(l.prompt, /attach/i);
  assert.deepEqual([l.attemptedPages, l.unreadPages, l.complete, l.reportedComplete, l.progressBasis], [[], [], false, false, 'caller-reported']);
});

test('file entrypoint: takes the injected {name,resourceUri}, downloads and echoes nothing', async () => {
  const uri = 'synthetic-resource://file/SYNTHETIC-RESOURCE-ID';
  const r = await noStorage(() => attachmentFileEntrypoint({file: {name: 'synthetic.pdf', resourceUri: uri}}));
  assert.equal(r.mode, 'ephemeral');
  assert.equal(r.persistent, false);
  assert.equal(r.attachment, null);
  assert.deepEqual(r.fileEntrypoint, {fileName: 'synthetic.pdf'});
  assert(!JSON.stringify(r).includes('SYNTHETIC-RESOURCE-ID'), 'resource URI not echoed');
  // The SDK's file entrypoint schema is not strict: extra top-level keys a host adds are
  // ignored, never echoed, and never stand in for the file.
  const extra = await noStorage(() => attachmentFileEntrypoint({file: {name: 'synthetic.pdf', resourceUri: uri}, download_url: 'https://example.invalid/SYNTHETIC-EXTRA', hostKey: 1}));
  assert.deepEqual(extra.fileEntrypoint, {fileName: 'synthetic.pdf'});
  assert(!/SYNTHETIC-(EXTRA|RESOURCE-ID)|example\.invalid/.test(JSON.stringify(extra)), 'extra keys and resource URI not echoed');
  for (const bad of [{}, [], 'file', {file: {name: 'x.pdf'}}, {file: {resourceUri: uri}}, {file: {name: 'x.pdf', resourceUri: ' '}}, {download_url: 'https://example.invalid/x.pdf'}])
    assert.throws(() => attachmentFileEntrypoint(bad), e => ['missing', 'invalid_arguments'].includes(e.reason));
});

// --- MCP route -----------------------------------------------------------------------------
globalThis.__viteDev = true;
vars.SUNDARK_DEV_FILE_ORIGIN = origin;
vars.SUNDARK_FILE_HOSTS = 'files.oaiusercontent.com';
const {POST} = await import('../app/mcp/route.ts');
const signedIn = new Headers({'oai-authenticated-user-id': 'synthetic-user', 'oai-authenticated-user-email': 'synthetic@example.invalid'});
async function rpc(method, params, headers = signedIn) {
  globalThis.__requestHeaders = headers;
  try {
    const response = await POST(new Request('https://site.example/mcp', {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({jsonrpc: '2.0', id: 1, method, params})}));
    return (await response.json()).result;
  } finally { globalThis.__requestHeaders = undefined; }
}
const ATTACHMENT_URI = 'ui://sundark/attachment-reader-v2.html';
const SAVED_URI = 'ui://sundark/reader-compat-v3.html';
// URIs earlier tool results named; hosts that cached them must still read the current body.
const OLD_ATTACHMENT_URI = 'ui://sundark/attachment-reader.html', OLD_SAVED_URI = 'ui://sundark/reader-compat-v2.html';
const LEGACY = ['prepare_paper_task', 'list_paper_figures', 'read_paper_figure', 'render_paper_reader', 'search_library', 'list_paper_sources', 'read_paper_source',
  'read_paper_page', 'read_paper_notes', 'read_paper_analysis', 'save_paper_analysis', 'import_paper_pdf', 'extract_paper_pages', 'import_paper_text'];

test('route: new tools are read-only, file-param and reader-template tools', async () => {
  const {tools} = await noStorage(() => rpc('tools/list'));
  const by = Object.fromEntries(tools.map(t => [t.name, t]));
  for (const name of LEGACY) assert(by[name], `legacy tool ${name} kept`);
  for (const name of ['read_attached_pdf', 'render_attached_reader', 'open_attachment_reader']) {
    const t = by[name];
    assert(t, name);
    assert.equal(t.annotations.readOnlyHint, true, name);
    assert.equal(t.annotations.destructiveHint, false, name);
    assert.equal(t._meta.ui.resourceUri, ATTACHMENT_URI, name);
    assert.equal(t._meta['openai/outputTemplate'], ATTACHMENT_URI, name);
    assert.equal(t.inputSchema.additionalProperties, false, name);
  }
  for (const name of ['read_attached_pdf', 'render_attached_reader', 'prepare_attachment_task']) {
    const t = by[name];
    assert.deepEqual(t._meta['openai/fileParams'], ['file']);
    assert.equal(t.annotations.openWorldHint, true);
    assert.deepEqual(Object.keys(t.inputSchema.properties.file.properties).sort(), ['download_url', 'file_id', 'file_name', 'mime_type']);
    assert.deepEqual(t.inputSchema.properties.file.required, ['download_url', 'file_id']);
  }
  assert.equal(by.prepare_attachment_task.annotations.readOnlyHint, true);
  assert.deepEqual(by.open_attachment_reader.inputSchema.properties, {});
  assert.deepEqual(by.open_attachment_reader._meta['openai/ui'], {entrypoints: [{type: 'thread'}]});
  assert.equal(by.open_attachment_reader._meta['openai/fileParams'], undefined);
  assert.equal(by.read_attached_pdf.inputSchema.properties.pages.maxItems, 8);
  const entry = by.open_pdf_file;
  assert.deepEqual(entry._meta.ui, {resourceUri: ATTACHMENT_URI, visibility: ['app']});
  assert.deepEqual(entry._meta['openai/ui'], {entrypoints: [{type: 'file', extensions: ['.pdf']}]});
  assert.equal(entry._meta['openai/fileParams'], undefined, 'no invented download_url/file_id input');
  assert.deepEqual(entry.inputSchema.properties.file.required, ['name', 'resourceUri']);
  assert.deepEqual([entry.annotations.readOnlyHint, entry.annotations.destructiveHint, entry.annotations.openWorldHint], [true, false, false]);
  for (const name of ['import_paper_pdf', 'save_paper_analysis', 'extract_paper_pages', 'import_paper_text'])
    assert.match(by[name].description, /only when the user explicitly asks/i, name);
  assert.match(by.import_paper_pdf.description, /read_attached_pdf/);
  const {resources} = await rpc('resources/list');
  assert(resources.some(r => r.uri === ATTACHMENT_URI));
  assert(resources.some(r => r.uri === SAVED_URI), 'saved reader resource kept');
  const read = await rpc('resources/read', {uri: ATTACHMENT_URI});
  const {attachmentReaderHtml} = await import('../lib/attachment-reader.ts');
  assert.equal(read.contents[0].text, attachmentReaderHtml);
  assert.equal(read.contents[0].uri, ATTACHMENT_URI);
  assert.equal(read.contents[0].mimeType, 'text/html;profile=mcp-app');
  assert.deepEqual(read.contents[0]._meta.ui.csp, {connectDomains: ['https://files.oaiusercontent.com'], resourceDomains: []});
  assert.deepEqual(read.contents[0]._meta['openai/widgetCSP'], {connect_domains: ['https://files.oaiusercontent.com'], resource_domains: []});
});

test('route: old reader URIs read the current body but only the new URIs are advertised', async () => {
  const {resources} = await rpc('resources/list');
  assert.deepEqual(resources.map(r => r.uri).sort(), [ATTACHMENT_URI, SAVED_URI].sort());
  const {tools} = await noStorage(() => rpc('tools/list'));
  const named = JSON.stringify(tools);
  assert(!named.includes(OLD_ATTACHMENT_URI) && !named.includes(OLD_SAVED_URI), 'tool metadata names only the new URIs');
  for (const [current, old] of [[ATTACHMENT_URI, OLD_ATTACHMENT_URI], [SAVED_URI, OLD_SAVED_URI]]) {
    const now = (await rpc('resources/read', {uri: current})).contents[0];
    const alias = (await rpc('resources/read', {uri: old})).contents[0];
    assert.equal(alias.uri, old, 'echoes the URI the host asked for');
    assert.deepEqual({...alias, uri: current}, now, `${old} serves the same body, MIME and CSP`);
  }
  const unknown = await rpc('resources/read', {uri: 'ui://sundark/attachment-reader-v1.html'});
  assert.equal(unknown.isError, true, 'unknown URIs still fail');
  assert.equal(unknown.contents, undefined);
});

test('route: UI tool metadata matches what the installed ext-apps registerAppTool registers', async () => {
  // registerAppTool mirrors _meta.ui.resourceUri into the legacy _meta['ui/resourceUri'] key (and back) and
  // changes nothing else; a fake server records exactly what it would register.
  const {registerAppTool, RESOURCE_URI_META_KEY} = await import('@modelcontextprotocol/ext-apps/server');
  assert.equal(RESOURCE_URI_META_KEY, 'ui/resourceUri');
  const registered = meta => {
    let seen;
    registerAppTool({registerTool: (_name, config) => { seen = config._meta; }}, 'probe', {_meta: meta}, () => {});
    return seen;
  };
  const {tools} = await noStorage(() => rpc('tools/list'));
  const ui = {open_pdf_file: ATTACHMENT_URI, read_attached_pdf: ATTACHMENT_URI, render_attached_reader: ATTACHMENT_URI,
    open_attachment_reader: ATTACHMENT_URI, render_paper_reader: SAVED_URI};
  for (const t of tools) {
    const uri = ui[t.name];
    if (!uri) {
      assert.equal(t._meta?.ui, undefined, `${t.name} has no UI`);
      assert.equal(t._meta?.[RESOURCE_URI_META_KEY], undefined, t.name);
      assert.equal(t._meta?.['openai/outputTemplate'], undefined, t.name);
      continue;
    }
    assert.deepEqual([t._meta.ui.resourceUri, t._meta[RESOURCE_URI_META_KEY], t._meta['openai/outputTemplate']], [uri, uri, uri], t.name);
    assert.deepEqual(registered(t._meta), t._meta, `${t.name} is already normalized`);
    const {[RESOURCE_URI_META_KEY]: _legacy, ...current} = t._meta;
    assert.deepEqual(registered(current), t._meta, `${t.name} equals the SDK registration of its current-key metadata`);
  }
  assert.deepEqual(tools.filter(t => t._meta?.ui).map(t => t.name).sort(), Object.keys(ui).sort());
});

test('route: initialize carries standard instructions that route an attached PDF to read', async () => {
  const init = await noStorage(() => rpc('initialize', {protocolVersion: '2026-07-28', capabilities: {}, clientInfo: {name: 'synthetic', version: '0'}}));
  assert.deepEqual(Object.keys(init).sort(), ['capabilities', 'instructions', 'protocolVersion', 'serverInfo']);
  assert.equal(typeof init.instructions, 'string');
  assert.match(init.instructions, /read_attached_pdf/);
  assert.match(init.instructions, /without asking/i);
  assert.match(init.instructions, /import_paper_pdf/);
  assert.match(init.instructions, /explicitly/i);
  const {tools} = await rpc('tools/list');
  const read = tools.find(t => t.name === 'read_attached_pdf');
  assert.match(read.description, /@Sundark|mentions Sundark/);
  assert.match(read.description, /without asking/i);
  assert.match(read.description, /unreadPages/);
  assert.match(read.description, /reportedComplete/);
  assert.match(read.description, /caller-reported/);
  assert.match(read.inputSchema.properties.language.description, /render_attached_reader/);
  assert.equal(read.inputSchema.properties.unreadPages.maxItems, 200);
  const render = tools.find(t => t.name === 'render_attached_reader');
  assert.match(render.description, /same language/i);
  assert.doesNotMatch(tools.find(t => t.name === 'prepare_attachment_task').description, /page = a source page/);
});

test('route: July discovery carries the same attachment onboarding as initialize', async () => {
  const discovered = await noStorage(() => rpc('server/discover'));
  const initialized = await noStorage(() => rpc('initialize', {protocolVersion: '2026-07-28'}));
  assert.deepEqual(discovered.supportedVersions, ['2026-07-28']);
  assert.equal(discovered.instructions, initialized.instructions);
  assert.match(discovered.instructions, /read_attached_pdf/);
  assert.match(discovered.instructions, /explicit/i);
});

test('route: read and render return model text, structuredContent and no URL', async () => {
  const read = await noStorage(() => rpc('tools/call', {name: 'read_attached_pdf', arguments: {file: file('/two.pdf')}}));
  assert.equal(read.isError, undefined);
  clean(read);
  assert.equal(read.structuredContent.page, 1);
  assert.deepEqual(JSON.parse(read.content[0].text).pages, read.structuredContent.pages);
  const render = await noStorage(() => rpc('tools/call', {name: 'render_attached_reader', arguments: {file: file('/two.pdf'), page: 1, sourceHash: read.structuredContent.sourceHash}}));
  assert.equal(render.isError, undefined);
  clean(render);
  assert.equal(render.structuredContent.sourceHash, read.structuredContent.sourceHash);
  const launcher = await noStorage(() => rpc('tools/call', {name: 'open_attachment_reader', arguments: {}}));
  assert.equal(launcher.structuredContent.attachment, null);
  const entry = await noStorage(() => rpc('tools/call', {name: 'open_pdf_file', arguments: {file: {name: 'synthetic.pdf', resourceUri: 'synthetic-resource://file/1'}}}));
  assert.equal(entry.isError, undefined);
  assert.deepEqual(entry.structuredContent.fileEntrypoint, {fileName: 'synthetic.pdf'});
});

test('route: errors name the reason, never the URL; sign-in is still required', async () => {
  const host = await noStorage(() => rpc('tools/call', {name: 'read_attached_pdf', arguments: {file: {download_url: `https://cdn.example.com/p/x.pdf?sig=${SECRET}`, file_id: 'file-SYNTHETIC-ID'}}}));
  assert.equal(host.isError, true);
  assert.match(host.content[0].text, /^Attachment error \(unsupported_host, host cdn\.example\.com\)/);
  assert(!host.content[0].text.includes(SECRET) && !host.content[0].text.includes('/p/x.pdf'));
  const expired = await noStorage(() => rpc('tools/call', {name: 'read_attached_pdf', arguments: {file: file('/expired-403.pdf')}}));
  assert.match(expired.content[0].text, /^Attachment error \(expired\)/);
  clean(expired);
  const anonymous = await noStorage(() => rpc('tools/call', {name: 'read_attached_pdf', arguments: {file: file('/two.pdf')}}, new Headers()));
  assert.equal(anonymous.isError, true);
});
