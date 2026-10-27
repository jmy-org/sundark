// Ephemeral attachment reader in real Chromium: a fake MCP Apps host (official AppBridge)
// drives the built widget with REAL read_attached_pdf/render_attached_reader results for a
// synthetic PDF, inside an opaque-origin sandbox with a strict CSP. Synthetic data only.
// The original PDF arrives in-band: the widget calls read_attachment_original through the
// bridge, the REAL server tool answers, and the widget's CSP allows no network at all.
// Run with `npm run test:attachment-reader` (builds the widget first); Chromium comes from
// `npm run test:browsers:install`. Playwright is a dev dependency: a missing module or
// browser fails this file, it never skips.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import http from 'node:http';
import {mkdtempSync, readFileSync, rmSync} from 'node:fs';
import https from 'node:https';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {register} from 'node:module';
import {after, before, test} from 'node:test';
import {build} from 'esbuild';
import {chromium} from 'playwright';
import {manyPagePdf, twoPagePdf} from './fixtures/synthetic-pdf.mjs';

register('./fixtures/worker-loader.mjs', import.meta.url);
globalThis.__workerEnv = new Proxy({}, {get(t, key) { if (key === 'DB' || key === 'BUCKET') throw new Error('storage access'); return t[key]; }});
const {readAttached, readAttachedOriginal, ORIGINAL_CHUNK, renderAttached, prepareAttachedTask, attachmentLauncher} = await import('../lib/attachment.ts');
const {attachmentReaderHtml, attachmentReaderUri, attachmentReaderAliases} = await import('../lib/attachment-reader.ts');

const pdf = twoPagePdf();
const pdfSha = createHash('sha256').update(pdf).digest('hex');
// Over one 2 MiB chunk: the same two pages with comment padding after %%EOF (pdf.js finds
// startxref by scanning back), so the original arrives in two chunks.
const big = Buffer.concat([pdf, Buffer.from(('%' + 'p'.repeat(1022) + '\n').repeat(2600), 'latin1')]);
const bigSha = createHash('sha256').update(big).digest('hex');
const FILE_URL = 'file.pdf?token=short-lived';
const requests = [];
// The widget accepts only https file URLs, so the fixture host is https with a throwaway cert.
const certDir = mkdtempSync(join(tmpdir(), 'sundark-reader-test-'));
execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=127.0.0.1',
  '-addext', 'subjectAltName=IP:127.0.0.1', '-keyout', join(certDir, 'key.pem'), '-out', join(certDir, 'cert.pem')], {stdio: 'ignore'});
const tls = {key: readFileSync(join(certDir, 'key.pem')), cert: readFileSync(join(certDir, 'cert.pem'))};
rmSync(certDir, {recursive: true, force: true});
const server = https.createServer(tls, async (req, res) => {
  const url = new URL(req.url, origin);
  requests.push(url.pathname);
  // The host-issued file URL. The widget must never request it; it stays servable so a
  // regression would show up as a request here, not as a silent failure.
  if (url.pathname === '/file.pdf') {
    res.writeHead(200, {'Content-Type': 'application/pdf', 'Access-Control-Allow-Origin': '*'});
    return res.end(pdf);
  }
  if (url.pathname === '/host.html') {
    res.writeHead(200, {'Content-Type': 'text/html'});
    return res.end('<!doctype html><meta charset="utf-8"><title>host</title><body><script src="/host.js"></script>');
  }
  if (url.pathname === '/host.js') { res.writeHead(200, {'Content-Type': 'text/javascript'}); return res.end(hostJs); }
  if (url.pathname === '/pdf-harness.html') {
    res.writeHead(200, {'Content-Type': 'text/html'});
    return res.end('<!doctype html><meta charset="utf-8"><title>pdf</title><canvas id="c"></canvas><div id="t"></div><script src="/pdf-harness.js"></script>');
  }
  if (url.pathname === '/pdf-harness.js') { res.writeHead(200, {'Content-Type': 'text/javascript'}); return res.end(pdfJs); }
  if (url.pathname === '/widget.html') {
    const q = url.searchParams;
    const fileUrl = `${origin}/${FILE_URL}`;
    const stub = `<script>window.__csp=[];document.addEventListener('securitypolicyviolation',e=>window.__csp.push(e.violatedDirective+' '+e.blockedURI+' '+e.lineNumber+':'+e.columnNumber));` +
      (q.get('openai') ? `window.__states=[];window.openai={widgetState:${q.get('state') || 'null'},setWidgetState(s){this.widgetState=s;window.__states.push(JSON.stringify(s));${q.get('globals') ? "dispatchEvent(new CustomEvent('openai:set_globals',{detail:{globals:{widgetState:s}}}))" : ''}},fileUrls:0,${q.get('output') ? `toolOutput:${JSON.stringify(read1).replace(/</g, '\\u003c')},` : ''}getFileDownloadUrl:async({fileId})=>{await new Promise(r=>setTimeout(r,${Number(q.get('urldelay')) || 0}));return fileId==='file-TEST'?(window.openai.fileUrls++,{downloadUrl:${JSON.stringify(fileUrl)}}):Promise.reject(new Error('unknown file'))}};` : '') +
      '</script>';
    res.writeHead(200, {'Content-Type': 'text/html',
      // As strict as the resource's declared CSP (connectDomains []): inline code only, no network.
      'Content-Security-Policy': "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data: blob:; connect-src 'none'"});
    return res.end(attachmentReaderHtml.replace('<script>', () => stub + '<script>'));
  }
  res.writeHead(404); res.end();
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const origin = `https://127.0.0.1:${server.address().port}`;
// The widget's own pdf.ts, bundled alone so a test can drive drawPage against a gated text stream.
const pdfJs = (await build({stdin: {contents: "import {drawPage, openPdfBytes} from './client/attachment-reader/pdf.ts'; window.harness = {drawPage, openPdfBytes};",
  resolveDir: new URL('..', import.meta.url).pathname, loader: 'js'}, bundle: true, write: false, format: 'iife', platform: 'browser', logLevel: 'silent',
  external: ['module', 'fs', 'path', 'url', 'http', 'https', 'zlib', 'canvas']})).outputFiles[0].text;
const hostJs = (await build({entryPoints: [new URL('./fixtures/attachment-host.mjs', import.meta.url).pathname], bundle: true, write: false, format: 'iife', platform: 'browser', logLevel: 'silent'})).outputFiles[0].text;

// The server tools read the same bytes from a plain-http dev origin (the only kind their
// download gate allows besides the real file host). /big.pdf is the two-chunk file.
const backend = http.createServer((req, res) => { res.writeHead(200, {'Content-Type': 'application/pdf'}); res.end(req.url.startsWith('/big.pdf') ? big : pdf); });
await new Promise(r => backend.listen(0, '127.0.0.1', r));
const backendOrigin = `http://127.0.0.1:${backend.address().port}`;
const deps = {policy: {hosts: [], devOrigin: backendOrigin}};
const file = {download_url: `${backendOrigin}/file.pdf`, file_id: 'file-TEST', file_name: 'two/page: fixture?.pdf'};
const read1 = await readAttached({file, pages: [1]}, deps);
const read2 = await readAttached({file, pages: [2], attemptedPages: [1]}, deps);
const ids = read1.pages[0].segments.map(s => s.id);
const render = n => renderAttached({file, page: 1, sourceHash: read1.sourceHash, translations: ids.slice(0, n).map((id, i) => ({id, text: `번역된 문장 ${i + 1}입니다.`}))}, deps);
// The reader view must show the server's sources, never a URL.
for (const r of [read1, read2, await render(1)]) assert(!JSON.stringify(r).includes(backendOrigin), 'tool results carry no file URL');
const bigRead = await readAttached({file: {...file, download_url: `${backendOrigin}/big.pdf`}, pages: [1]}, deps);
assert.equal(bigRead.attachment.pdfSha256, bigSha);
assert(big.length > ORIGINAL_CHUNK && big.length < 2 * ORIGINAL_CHUNK, 'the big fixture takes exactly two chunks');

/** The server side of read_attachment_original, called by the host fixture: the REAL tool,
 * downloading the backend copy of the file the host URL stands for. `fault` bends one reply the
 * way a broken or hostile host might; `delay` holds every reply back. */
function originalServer(state) {
  return async args => {
    if (state.delay) await new Promise(r => setTimeout(r, state.delay));
    assert.equal(args.file.download_url, `${origin}/${FILE_URL}`, 'the server is handed the fresh host URL');
    // Consistent but hostile: one-byte slices of the big file, so a load would never end on its own.
    if (state.fault === 'tiny') {
      const data = big.subarray(args.offset, args.offset + 1);
      const sc = {fileId: args.file.file_id, pdfSha256: args.pdfSha256, offset: args.offset, length: 1, total: big.length, done: args.offset + 1 === big.length};
      return {content: [{type: 'text', text: JSON.stringify(sc)}], structuredContent: sc, _meta: {'sundark/originalChunk': data.toString('base64')}};
    }
    let r;
    try { r = await readAttachedOriginal({...args, file: {...args.file, download_url: `${backendOrigin}/${state.source || 'file.pdf'}`}}, deps); }
    catch (e) { return {content: [{type: 'text', text: `${e.message} ${args.file.download_url}`}], isError: true}; }
    const result = {content: [{type: 'text', text: JSON.stringify(r.data)}], structuredContent: {...r.data}, _meta: {...r.meta}};
    const later = r.data.offset > 0;
    if (state.fault === 'meta') delete result._meta;
    if (state.fault === 'total' && later) result.structuredContent.total += ORIGINAL_CHUNK;
    if (state.fault === 'offset' && later) result.structuredContent.offset -= 1;
    if (state.fault === 'sha') result.structuredContent.pdfSha256 = 'f'.repeat(64);
    if (state.fault === 'bytes' && r.data.done) {
      const b = Buffer.from(r.meta['sundark/originalChunk'], 'base64'); b[b.length - 1] ^= 1;
      result._meta['sundark/originalChunk'] = b.toString('base64');
    }
    return result;
  };
}

let browser;
before(async () => { browser = await chromium.launch(); });
after(async () => { await browser?.close(); for (const s of [server, backend]) { s.closeAllConnections(); s.close(); } });

async function open(query = 'openai=1', viewport = {width: 1320, height: 960}, original = {}) {
  const page = await browser.newPage({viewport, ignoreHTTPSErrors: true});
  const errors = [];
  page.on('pageerror', e => errors.push(String(e)));
  await page.exposeFunction('serveOriginal', originalServer(original));
  await page.goto(`${origin}/host.html?${query}`);
  await page.waitForFunction(() => window.testHost);
  await page.evaluate(() => window.testHost.ready());
  const frame = () => page.frames().find(f => f.url().includes('/widget.html'));
  return {page, errors, original, frame: frame(), host: (fn, arg) => page.evaluate(fn, arg)};
}
const text = (frame, sel) => frame.$eval(sel, e => e.textContent);
const painted = frame => frame.$eval('#canvas', c => {
  const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
  let dark = 0; for (let i = 0; i < d.length; i += 4) if (d[i] < 128) dark++;
  return {w: c.width, h: c.height, dark, visible: !c.closest('#stage').hidden};
});

test('exports the resource the backend registers', () => {
  // The CSP is part of the host's template cache key: the empty-CSP body gets a new URI.
  assert.equal(attachmentReaderUri, 'ui://sundark/attachment-reader-v4.html');
  for (const old of ['ui://sundark/attachment-reader.html', 'ui://sundark/attachment-reader-v2.html', 'ui://sundark/attachment-reader-v3.html'])
    assert(attachmentReaderAliases.includes(old), `${old} still served`);
  assert(attachmentReaderHtml.includes('read_attachment_original'));
  assert(attachmentReaderHtml.startsWith('<!doctype html>'));
  // Self-contained: no external script, stylesheet, font or worker URL.
  assert(!/<script[^>]+src=|<link[^>]+href=|\/vendor\//.test(attachmentReaderHtml));
  assert.equal(attachmentReaderHtml.match(/<\/script/gi).length, 1, 'one inline script, nothing closes it early');
});

test('launcher shows first-use onboarding and stores nothing', async () => {
  const {page, frame, host, errors} = await open('openai=1');
  await host(o => window.testHost.result(o), attachmentLauncher());
  await frame.waitForFunction(() => !document.getElementById('onboarding').hidden && document.getElementById('launcher-prompt').textContent);
  assert.match(await text(frame, '#launcher-prompt'), /Attach a PDF/);
  assert(await frame.$eval('#layout', e => e.hidden));
  assert.deepEqual(errors, []);
  await page.close();
});

test('source paints before the original PDF, then the PDF renders with text layer and geometry', async () => {
  requests.length = 0;
  const {page, frame, host, errors} = await open('openai=1', undefined, {delay: 1500});
  await host(o => window.testHost.result(o), read1);
  await frame.waitForSelector('#segments li[role=option]');
  // The original is still on its way (1.5 s delay): sources and status are already on screen.
  assert(await frame.$eval('#stage', e => e.hidden), 'canvas not shown yet');
  assert.equal(await frame.$$eval('#segments li[role=option]', l => l.length), ids.length);
  assert.match(await text(frame, '#segments li[role=option] .src'), /SYNTHETIC IMPORT FIXTURE ONLY/);
  assert.match(await text(frame, '#segments li[role=option] .tr'), /아직 번역 전/);
  assert.match(await text(frame, '#progress-text'), new RegExp(`번역 0/${ids.length}문장 · 원문 1/2페이지`));
  await frame.waitForFunction(() => !document.getElementById('stage').hidden, null, {timeout: 15000});
  const px = await painted(frame);
  assert(px.w > 300 && px.h > 300 && px.dark > 200, `canvas has rendered text: ${JSON.stringify(px)}`);
  assert(await frame.$$eval('#text-layer span', s => s.some(x => x.textContent.includes('Plants use light'))), 'selectable text layer');
  // The first sentence is selected and highlighted at its geometry on the page.
  const boxes = await frame.$$eval('#hl div', d => d.map(x => x.getBoundingClientRect()).map(r => [r.width, r.height]));
  assert(boxes.length >= 1 && boxes.every(([w, h]) => w > 10 && h > 3), JSON.stringify(boxes));
  assert.equal(await text(frame, '#page-label'), '1 / 2');
  // Only the host page and the widget were requested: the file URL never, no Sundark API.
  assert.deepEqual([...new Set(requests)].sort(), ['/host.html', '/host.js', '/widget.html']);
  assert.deepEqual(await frame.evaluate(() => window.__csp), [], 'self-contained under connect-src none: nothing even tried the network');
  // One bridge call for this one-chunk file, with a fresh host URL and the server-read hash.
  const originals = await host(() => window.testHost.calls.originals.map(c => c.arguments));
  assert.equal(originals.length, 1);
  assert.deepEqual(Object.keys(originals[0]).sort(), ['file', 'offset', 'pdfSha256']);
  assert.deepEqual([originals[0].offset, originals[0].pdfSha256, originals[0].file.file_id], [0, pdfSha, 'file-TEST']);
  assert.equal(await frame.evaluate(() => window.openai.fileUrls), 1);
  assert.equal(await frame.evaluate(() => { try { return localStorage.length; } catch { return 0; } }), 0);
  assert.deepEqual(errors, []);
  await page.close();
});

test('translations show only as a contiguous prefix; state stays small; keyboard and IME', async () => {
  const {page, frame, host, errors} = await open('openai=1');
  await host(o => window.testHost.result(o), read1);
  await frame.waitForSelector('#segments li[role=option]');
  await host(o => window.testHost.result(o), await render(1));
  await frame.waitForFunction(() => document.querySelector('#segments li[role=option] .tr').textContent.includes('번역된 문장 1'));
  const trs = await frame.$$eval('#segments li[role=option] .tr', l => l.map(e => e.textContent));
  assert.equal(trs[0], '번역된 문장 1입니다.');
  assert(trs.slice(1).every(t => t.includes('아직 번역 전')), 'no later sentence, no source fallback');
  assert.match(await text(frame, '#progress-text'), new RegExp(`번역 1/${ids.length}문장`));
  await host(o => window.testHost.result(o), await render(ids.length));
  await frame.waitForFunction(n => [...document.querySelectorAll('#segments li[role=option] .tr')].filter(e => e.textContent.startsWith('번역된')).length === n, ids.length);

  // The source's language is unknown, so it claims none (lang="" overrides the page's ko).
  assert.equal(await frame.$eval('#segments li[role=option] .src', e => e.getAttribute('lang')), '');
  // Listbox keyboard: ArrowDown moves the active option. Single-character shortcuts are off
  // until the labelled toggle turns them on (WCAG 2.1.4); then J/K and ]/[ work.
  await frame.focus('#segments');
  await page.keyboard.press('ArrowDown');
  assert.equal(await frame.$eval('#segments', l => l.getAttribute('aria-activedescendant')), 'seg-' + ids[1]);
  await page.keyboard.press('k');
  assert.equal(await frame.$eval('#segments', l => l.getAttribute('aria-activedescendant')), 'seg-' + ids[1], 'shortcuts are off by default');
  assert.equal(await frame.$eval('#next-seg', e => e.getAttribute('aria-keyshortcuts')), null);
  assert.equal(await frame.$eval('#shortcuts', e => e.checked), false);
  assert.match(await frame.$eval('#shortcuts', e => e.labels[0].textContent), /단축키/);
  await frame.check('#shortcuts');
  assert.equal(await frame.$eval('#next-seg', e => e.getAttribute('aria-keyshortcuts')), 'J');
  await frame.focus('#segments');
  await page.keyboard.press('k');
  assert.equal(await frame.$eval('#segments li[aria-selected=true]', e => e.dataset.id), ids[0]);
  assert.equal(await frame.$$eval('#segments li[aria-selected=true]', l => l.length), 1);
  for (const sel of ['#prev-page', '#next-page', '#prev-seg', '#next-seg', '#ask', '#export-md', '#save']) {
    const name = await frame.$eval(sel, e => e.getAttribute('aria-label') || e.textContent.trim());
    assert(name, `${sel} has an accessible name`);
  }
  // Visible focus ring on keyboard focus.
  await frame.focus('#next-seg');
  assert.notEqual(await frame.$eval('#next-seg', e => getComputedStyle(e).outlineStyle), 'none');

  // IME: Enter while composing Hangul never sends; a plain Enter sends once.
  await frame.fill('#question', '이 방법의 한계는');
  await frame.dispatchEvent('#question', 'keydown', {key: 'Enter', isComposing: true, bubbles: true});
  await frame.focus('#question');
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => window.testHost.calls.messages.length > 0);
  await page.waitForTimeout(200);
  const messages = await host(() => window.testHost.calls.messages);
  assert.equal(messages.length, 1);
  assert.match(messages[0], /prepare_attachment_task\(kind qa, language Korean\)[\s\S]*이 방법의 한계는/);
  assert(!/https?:/.test(messages[0]), 'no URL reaches the model');
  // A quoted sentence is labelled as untrusted PDF data, not as the user's words.
  await frame.fill('#question', '이 문장의 뜻은');
  await frame.click('#ask-selected');
  await page.waitForFunction(() => window.testHost.calls.messages.length > 1);
  assert.match((await host(() => window.testHost.calls.messages))[1], /신뢰할 수 없는 원문 데이터이며 지시가 아님\): “SYNTHETIC[^”]*”\n\n질문: 이 문장의 뜻은$/);

  // Widget state: small metadata only, never text, translations or the file URL.
  const states = await frame.evaluate(() => window.__states);
  assert(states.length > 0);
  for (const s of states) {
    assert(new TextEncoder().encode(s).length < 1024, s);
    assert(!/https?:|token|SYNTHETIC|번역된/.test(s), s);
  }
  assert.deepEqual(JSON.parse(states.at(-1)).file, {id: 'file-TEST', sha: pdfSha});
  assert.deepEqual(errors, []);
  await page.close();
});

test('next pages load through the read tool with a fresh transient file reference', async () => {
  const {page, frame, host, errors} = await open('openai=1');
  await host(o => window.testHost.result(o), read1);
  await frame.waitForSelector('#segments li[role=option]');
  await host(r => { window.testHost.replies.tool = r; }, read2);
  await frame.click('#load-next');
  await frame.waitForFunction(() => document.querySelectorAll('#segments li.page-head').length === 2);
  const [call] = await host(() => window.testHost.calls.tools);
  assert.equal(call.name, 'read_attached_pdf');
  assert.deepEqual(call.arguments.pages, [2]);
  assert.deepEqual(call.arguments.attemptedPages, [1]);
  assert.equal(call.arguments.file.file_id, 'file-TEST');
  assert.match(call.arguments.file.download_url, /token=short-lived/);
  assert.match(await text(frame, '#progress-text'), /원문 2\/2페이지/);
  // Page 2 is reachable with the page buttons and the "]" shortcut, once shortcuts are on.
  await frame.check('#shortcuts');
  await frame.focus('#segments');
  await page.keyboard.press(']');
  await frame.waitForFunction(() => document.getElementById('page-label').textContent === '2 / 2');
  assert(!(await frame.$eval('#segments li[aria-selected=true]', e => e.dataset.page !== '2')));
  // Both pages are held with text: nothing is left to load.
  assert(await frame.$eval('#load-next', b => b.disabled));
  assert.deepEqual(errors, []);
  await page.close();
  // A failing tool shows its text without any URL.
  const failing = await open('openai=1');
  await failing.host(o => window.testHost.result(o), read1);
  await failing.frame.waitForSelector('#segments li[role=option]');
  await failing.frame.click('#load-next');
  await failing.frame.waitForFunction(() => !document.getElementById('error').hidden);
  assert(!(await text(failing.frame, '#error')).includes('example.invalid'), 'tool error text drops URLs');
  assert.deepEqual(failing.errors, []);
  await failing.page.close();
});

test('summary, analysis results, export and explicit save', async () => {
  const {page, frame, host, errors} = await open('openai=1');
  await host(o => window.testHost.result(o), read1);
  await host(o => window.testHost.result(o), await render(2));
  await frame.waitForSelector('#segments li[role=option]');
  await frame.click('#ask-summary');
  await frame.click('#ask-anatomy');
  await page.waitForFunction(() => window.testHost.calls.messages.length === 2);
  const [summary, anatomy] = await host(() => window.testHost.calls.messages);
  assert.match(summary, /prepare_attachment_task\(kind summary, language Korean\)[\s\S]*render_attached_reader analysis/);
  assert.match(anatomy, /kind anatomy/);
  // An analysis result as render_attached_reader returns it.
  await host(o => window.testHost.result(o), {...await render(2), analysis: {kind: 'summary', language: 'Korean', sourcePages: [1], sourceHash: 'x', content: {text: '식물이 빛으로 자란다는 합성 요약.', citations: []}}});
  await frame.waitForFunction(() => document.getElementById('results').textContent.includes('합성 요약'));

  await frame.click('#export-md');
  await frame.click('#export-json');
  await page.waitForFunction(() => window.testHost.calls.downloads.length === 2);
  const [md, json] = await host(() => window.testHost.calls.downloads);
  assert.equal(md.resource.mimeType, 'text/markdown');
  assert.equal(decodeURIComponent(md.resource.uri), 'file:///two_page_ fixture-sundark.md');
  assert.match(md.resource.text, /번역된 문장 2입니다[\s\S]*/);
  assert.match(md.resource.text, /합성 요약/);
  assert(!/token|https?:/.test(md.resource.text + json.resource.text), 'exports carry no URL');
  const exported = JSON.parse(json.resource.text);
  assert.equal(exported.format, 'sundark-ephemeral-reading');
  assert.equal(exported.translations.length, 2);
  assert.equal(exported.attachment.pdfSha256, pdfSha);

  // Save is two explicit steps with a disclosure; nothing is sent before confirming.
  const before = (await host(() => window.testHost.calls.messages)).length;
  await frame.click('#save');
  assert.match(await text(frame, '#save-confirm'), /R2[\s\S]*D1[\s\S]*삭제는 직접/);
  assert.equal((await host(() => window.testHost.calls.messages)).length, before);
  await frame.click('#save-no');
  assert(await frame.$eval('#save-confirm', e => e.hidden));
  await frame.click('#save');
  await frame.click('#save-yes');
  await page.waitForFunction(n => window.testHost.calls.messages.length === n, before + 1);
  await page.waitForTimeout(200);
  const all = await host(() => window.testHost.calls.messages);
  assert.equal(all.length, before + 1);
  assert.match(all.at(-1), /서재에 영구 저장/);
  assert.equal((await host(() => window.testHost.calls.tools)).length, 0, 'the reader never calls a save tool itself');
  assert.deepEqual(errors, []);

  // Restore the exported JSON into a fresh widget: sources and translations return.
  const fresh = await open('');
  await fresh.frame.setInputFiles('#restore-start', {name: 'x.json', mimeType: 'application/json', buffer: Buffer.from(json.resource.text)});
  await fresh.frame.waitForFunction(() => document.querySelectorAll('#segments li[role=option] .tr').length > 0);
  const restored = await fresh.frame.$$eval('#segments li[role=option] .tr', l => l.map(e => e.textContent));
  assert.deepEqual(restored.slice(0, 2), ['번역된 문장 1입니다.', '번역된 문장 2입니다.']);
  assert.match(await text(fresh.frame, '#original-msg'), /원문 PDF/);
  await fresh.frame.setInputFiles('#restore', {name: 'bad.json', mimeType: 'application/json', buffer: Buffer.from('{"format":"other"}')});
  await fresh.frame.waitForFunction(() => !document.getElementById('error').hidden);
  assert.match(await text(fresh.frame, '#error'), /Sundark/);
  await fresh.page.close();
  await page.close();
});

// Each fault is one way a host or server reply can be wrong. The view must stop, say so in the
// original pane, keep the sources readable and never show a canvas.
async function originalFails(original, data, pattern) {
  const v = await open('openai=1', undefined, original);
  await v.host(o => window.testHost.result(o), data);
  await v.frame.waitForFunction(() => document.getElementById('original-msg').classList.contains('error'), null, {timeout: 15000});
  const msg = await text(v.frame, '#original-msg');
  assert.match(msg, pattern, JSON.stringify(original));
  assert(!/https?:|token|example\.invalid/.test(msg), 'no URL in the error');
  assert(await v.frame.$eval('#stage', e => e.hidden), 'no original view');
  assert.equal(await v.frame.$eval('#text-layer', e => e.childElementCount), 0, 'no text layer drawn');
  assert(await v.frame.$$eval('#segments li[role=option]', l => l.length) > 0, 'sources still readable');
  assert.deepEqual(v.errors, []);
  return v;
}

test('the original arrives in chunks through the bridge and renders from the reassembled bytes', async () => {
  requests.length = 0;
  const bigFile = {...file, download_url: `${backendOrigin}/big.pdf`};
  const {page, frame, host, errors} = await open('openai=1', undefined, {source: 'big.pdf', delay: 700});
  await host(o => window.testHost.result(o), bigRead);
  // Progress is spoken: it lands in a live region while the second chunk is on its way.
  await frame.waitForFunction(() => /\(1\/2\)/.test(document.getElementById('original-msg').textContent), null, {timeout: 15000});
  assert(await frame.$eval('#original-msg', e => !!e.closest('[aria-live], [role=status], [role=alert]')), 'original-msg is announced to assistive technology');
  await frame.waitForFunction(() => !document.getElementById('stage').hidden, null, {timeout: 20000});
  const px = await painted(frame);
  assert(px.dark > 200, JSON.stringify(px));
  assert.equal(await frame.$eval('#canvas', e => e.getAttribute('aria-label')), '원문 PDF 1페이지');
  const originals = await host(() => window.testHost.calls.originals.map(c => c.arguments));
  assert.deepEqual(originals.map(a => a.offset), [0, ORIGINAL_CHUNK]);
  assert(originals.every(a => a.pdfSha256 === bigSha && a.file.file_id === 'file-TEST'));
  assert.equal(await frame.evaluate(() => window.openai.fileUrls), 2, 'a fresh host URL for every chunk');
  // The same chunks, taken straight from the server tool, rebuild the exact file.
  const chunks = [];
  for (const offset of [0, ORIGINAL_CHUNK]) chunks.push(await readAttachedOriginal({file: bigFile, pdfSha256: bigSha, offset}, deps));
  assert.deepEqual(chunks.map(c => [c.data.offset, c.data.length, c.data.total, c.data.done]), [[0, ORIGINAL_CHUNK, big.length, false], [ORIGINAL_CHUNK, big.length - ORIGINAL_CHUNK, big.length, true]]);
  assert(Buffer.concat(chunks.map(c => Buffer.from(c.meta['sundark/originalChunk'], 'base64'))).equals(big));
  // No outbound request to the file URL, no CSP violation, and the URL is nowhere on screen or in state.
  assert(!requests.includes('/file.pdf'));
  assert.deepEqual(await frame.evaluate(() => window.__csp), []);
  // The rendered DOM, without <script> elements: their source is code, not page content (the
  // fixture stub holds the URL it hands out, and KaTeX's lexer has `this._token=null`).
  const leaks = await frame.evaluate(() => {
    const dom = document.documentElement.cloneNode(true);
    dom.querySelectorAll('script').forEach(s => s.remove());
    return [dom.outerHTML, ...(window.__states || [])].filter(x => /file\.pdf|token=|short-lived/.test(x)).length;
  });
  assert.equal(leaks, 0, 'the file URL is in no DOM and no widget state');
  // A later render of the same bytes keeps the assembled PDF: no second download.
  await host(o => window.testHost.result(o), {...bigRead, translations: []});
  await page.waitForTimeout(500);
  assert.equal((await host(() => window.testHost.calls.originals)).length, 2);
  assert.deepEqual(errors, []);
  await page.close();
});

test('inconsistent, tampered or incomplete chunks stop the original view', async () => {
  // Hash of the whole file differs from the one read_attached_pdf returned: the REAL server
  // refuses with source_changed and sends no bytes.
  const changed = await originalFails({}, {...read1, attachment: {...read1.attachment, pdfSha256: 'a'.repeat(64)}}, /source_changed|달라요|바뀌/);
  assert.equal((await changed.host(() => window.testHost.calls.originals)).length, 1, 'no retry loop');
  await changed.page.close();
  // A chunk claiming another file's hash, a total that changes between chunks, or an offset
  // that does not follow the previous chunk.
  for (const fault of ['sha', 'total', 'offset']) {
    const v = await originalFails({source: fault === 'sha' ? 'file.pdf' : 'big.pdf', fault}, fault === 'sha' ? read1 : bigRead, /조각|맞지 않아요/);
    await v.page.close();
  }
  // Every chunk lines up but the bytes are altered: the reassembled hash is refused.
  await (await originalFails({source: 'big.pdf', fault: 'bytes'}, bigRead, /첨부 파일과 달라요/)).page.close();
  // A host that drops _meta: a clear capability error, not a blank pane or a substitute view.
  await (await originalFails({fault: 'meta'}, read1, /_meta/)).page.close();
});

// A failed load does not heal by asking again: the translation batches that follow (each one a
// tool result) must not start another download of the same file and digest.
test('a failed original load is not retried by later tool results of the same document', async () => {
  for (const [original, data, pattern] of [[{fault: 'meta'}, read1, /_meta/],
    [{}, {...read1, attachment: {...read1.attachment, pdfSha256: 'a'.repeat(64)}}, /source_changed|달라요|바뀌/]]) {
    const v = await originalFails(original, data, pattern);
    const failed = await text(v.frame, '#original-msg');
    for (const n of [1, 2, ids.length]) {
      const r = await render(n);
      await v.host(o => window.testHost.result(o), data === read1 ? r : {...r, attachment: data.attachment});
      await v.frame.waitForFunction(n => [...document.querySelectorAll('#segments li[role=option] .tr')].filter(e => e.textContent.startsWith('번역된')).length === n, n);
    }
    await v.page.waitForTimeout(500);
    assert.equal((await v.host(() => window.testHost.calls.originals)).length, 1, 'one original call, no retry per result');
    assert.equal(await v.frame.evaluate(() => window.openai.fileUrls), 1, 'no further file URL minted');
    assert.equal(await text(v.frame, '#original-msg'), failed, 'the error stays; no loading churn');
    assert.deepEqual(v.errors, []);
    await v.page.close();
  }
});

// Cancellation: once the document changes, no further chunk of the old file is requested,
// whether the change lands while the host mints a URL or while a chunk is on its way.
test('switching files stops the old load: no call after a URL wait, no chunk after a chunk wait', async () => {
  const other = {...read1, attachment: {...read1.attachment, fileId: 'file-OTHER', fileName: 'other.pdf', pdfSha256: 'c'.repeat(64)}};
  const urlWait = await open('openai=1&urldelay=1000');
  await urlWait.host(o => window.testHost.result(o), read1);
  await urlWait.page.waitForTimeout(200);
  await urlWait.host(o => window.testHost.result(o), other);
  await urlWait.page.waitForTimeout(1800);
  assert.equal((await urlWait.host(() => window.testHost.calls.originals)).length, 0, 'the URL minted for the old file was never used');
  assert(await urlWait.frame.$eval('#stage', e => e.hidden));
  assert.deepEqual(urlWait.errors, []);
  await urlWait.page.close();

  const chunkWait = await open('openai=1', undefined, {source: 'big.pdf', delay: 1000});
  await chunkWait.host(o => window.testHost.result(o), bigRead);
  await chunkWait.page.waitForFunction(() => window.testHost.calls.originals.length === 1);
  await chunkWait.host(o => window.testHost.result(o), other);
  await chunkWait.page.waitForTimeout(2800);
  assert.equal((await chunkWait.host(() => window.testHost.calls.originals)).length, 1, 'no second chunk of the old file');
  assert(await chunkWait.frame.$eval('#stage', e => e.hidden));
  assert.equal(await chunkWait.frame.$eval('#title', e => e.textContent), 'other.pdf');
  assert.deepEqual(chunkWait.errors, []);
  await chunkWait.page.close();
});

// A host that answers with tiny, self-consistent chunks must not drive an unbounded loop: the
// view caps its calls (a 20 MiB file is at most ten 2 MiB chunks) and says it stopped.
test('a load is bounded in calls even when every chunk is consistent', async () => {
  const v = await open('openai=1', undefined, {fault: 'tiny'});
  await v.host(o => window.testHost.result(o), bigRead);
  await v.frame.waitForFunction(() => document.getElementById('original-msg').classList.contains('error'), null, {timeout: 20000});
  const n = (await v.host(() => window.testHost.calls.originals)).length;
  assert(n <= Math.ceil((20 * 1024 * 1024) / ORIGINAL_CHUNK) + 1, `bounded: ${n} calls`);
  assert(await v.frame.$eval('#stage', e => e.hidden));
  assert.deepEqual(v.errors, []);
  await v.page.close();
});

// ChatGPT can hand the view its result as window.openai.toolOutput before the MCP Apps
// handshake answers. With server tools on the SDK bridge and no window.openai.callTool, the
// original must wait for the handshake, then load once, not be recorded as unsupported.
test('a result present before the host connects loads the original once the handshake settles', async () => {
  const {page, frame, host, errors} = await open('openai=1&output=1&initdelay=800');
  await frame.waitForSelector('#segments li[role=option]');
  assert.equal(await frame.evaluate(() => typeof window.openai.callTool), 'undefined', 'no legacy tool bridge');
  await frame.waitForFunction(() => !document.getElementById('stage').hidden, null, {timeout: 15000});
  const p = await painted(frame);
  assert(p.visible && p.w > 0 && p.dark > 50, JSON.stringify(p));
  assert(!(await frame.$eval('#original-msg', e => e.classList.contains('error'))));
  // Later results of the same document neither reload nor fail it.
  await host(o => window.testHost.result(o), await render(1));
  await page.waitForTimeout(300);
  assert.equal((await host(() => window.testHost.calls.originals)).length, 1, 'the original loads once');
  assert.equal(await frame.evaluate(() => window.openai.fileUrls), 1);
  assert.deepEqual(await frame.evaluate(() => window.__csp), []);
  assert(!requests.includes('/file.pdf'), 'the file URL is never fetched by the view');
  assert.deepEqual(errors, []);
  await page.close();
});

test('host gates fail visibly: missing file URL or tool bridge', async () => {
  const bare = await open('');
  await bare.host(o => window.testHost.result(o), read1);
  await bare.frame.waitForFunction(() => document.getElementById('original-msg').classList.contains('error'));
  assert.match(await text(bare.frame, '#original-msg'), /원문 PDF/);
  assert(await bare.frame.$eval('#stage', e => e.hidden), 'no fake original view');
  assert.equal((await bare.host(() => window.testHost.calls.originals)).length, 0, 'no call without a file URL to pass');
  // A persistent payload is refused, and the first error stays on screen.
  await bare.host(o => window.testHost.result(o), {...read1, persistent: true});
  await bare.host(o => window.testHost.result(o), 'not an object');
  await bare.frame.waitForFunction(() => !document.getElementById('error').hidden);
  assert.match(await text(bare.frame, '#error'), /ephemeral/);
  await bare.page.close();
});

test('desktop file entrypoint reads the resource blob and matches server geometry', async () => {
  const {page, frame, host, errors} = await open('resources=1');
  await host(b64 => { window.testHost.replies.resource = {contents: [{uri: 'file:///two.pdf', mimeType: 'application/pdf', blob: b64}]}; }, pdf.toString('base64'));
  await host(a => window.testHost.input(a), {file: {name: 'two.pdf', resourceUri: 'file:///two.pdf'}});
  await frame.waitForFunction(() => !document.getElementById('stage').hidden, null, {timeout: 15000});
  const [call] = await host(() => window.testHost.calls.resources);
  assert.equal(call.uri, 'file:///two.pdf');
  assert.equal(call._meta['openai/resource'].representation, 'blob');
  assert((await painted(frame)).dark > 200);
  // Client extraction runs the same atom/sentence code: ids and text equal the server's.
  const client = await frame.$$eval('#segments li[role=option]', l => l.map(e => [e.dataset.id, e.querySelector('.src').textContent]));
  const server = [...read1.pages[0].segments, ...read2.pages[0].segments].map(s => [s.id, s.text]);
  assert.deepEqual(client, server);
  assert.match(await text(frame, '#progress-text'), /번역 0\//);
  await frame.click('#translate-next');
  await page.waitForFunction(() => window.testHost.calls.messages.length === 1);
  assert.match((await host(() => window.testHost.calls.messages))[0], /read_attached_pdf/);
  assert.deepEqual(await frame.evaluate(() => window.__csp), []);
  // A later tool result for the same bytes reuses the open PDF and keeps the page.
  requests.length = 0;
  await host(o => window.testHost.result(o), await render(1));
  await frame.waitForFunction(() => document.querySelector('#segments li[role=option] .tr').textContent.startsWith('번역된'));
  assert(!(await frame.$eval('#stage', e => e.hidden)));
  assert(await frame.$eval('#original-msg', e => e.hidden), 'no download attempted or error shown');
  assert(!requests.includes('/file.pdf'));
  assert.deepEqual(errors, []);
  await page.close();
});

// Two file entrypoint opens overlap: whichever host read finishes first, the file the user
// asked for last is the one shown, with its own source text, original and text layer.
test('overlapping file entrypoint opens: the last requested file wins in either completion order', async () => {
  const blob = b => ({contents: [{uri: 'x', mimeType: 'application/pdf', blob: b.toString('base64')}]});
  for (const [first, last] of [[300, 1500], [1500, 300]]) {
    const {page, frame, host, errors} = await open('resources=1');
    await host(([a, b, da, db]) => { window.testHost.replies.resources = {'file:///two.pdf': {delay: da, reply: a}, 'file:///three.pdf': {delay: db, reply: b}}; },
      [blob(pdf), blob(manyPagePdf(3)), first, last]);
    await host(a => window.testHost.input(a), {file: {name: 'two.pdf', resourceUri: 'file:///two.pdf'}});
    await host(a => window.testHost.input(a), {file: {name: 'three.pdf', resourceUri: 'file:///three.pdf'}});
    await page.waitForFunction(() => window.testHost.calls.resources.length === 2);
    await frame.waitForFunction(() => !document.getElementById('stage').hidden, null, {timeout: 15000});
    await page.waitForTimeout(Math.max(first, last) + 1000);
    const view = await frame.evaluate(() => ({title: document.getElementById('title').textContent, pages: document.getElementById('page-label').textContent,
      source: document.getElementById('segments').textContent.includes('Synthetic page 1 of 3.'), old: document.body.innerText.includes('SYNTHETIC'),
      layer: document.getElementById('text-layer').textContent.includes('Synthetic page 1 of 3.'), error: document.getElementById('error').hidden,
      stage: !document.getElementById('stage').hidden}));
    assert.deepEqual(view, {title: 'three.pdf', pages: '1 / 3', source: true, old: false, layer: true, error: true, stage: true}, `delays ${first}/${last}`);
    assert.deepEqual(errors, []);
    await page.close();
  }
});

// Page 1's text layer is still streaming when page 2 is drawn into the same container: the
// canceled render must stop, and none of page 1's text may land after page 2 cleared it.
test('a canceled page draw cancels its text layer; no late text reaches the next page', async () => {
  const page = await browser.newPage({ignoreHTTPSErrors: true});
  const errors = [];
  page.on('pageerror', e => errors.push(String(e)));
  await page.goto(`${origin}/pdf-harness.html`);
  const result = await page.evaluate(async b64 => {
    const {drawPage, openPdfBytes} = window.harness;
    const doc = await openPdfBytes(Uint8Array.from(atob(b64), c => c.charCodeAt(0)));
    const p1 = await doc.getPage(1);
    const real = p1.streamTextContent.bind(p1);
    let release, started, canceled = false;
    const gate = new Promise(r => { release = r; }), begun = new Promise(r => { started = r; });
    p1.streamTextContent = (...args) => {
      const reader = real(...args).getReader();
      started();
      return new ReadableStream({
        async pull(c) { await gate; if (canceled) return; const {value, done} = await reader.read(); if (canceled) return; if (done) c.close(); else c.enqueue(value); },
        cancel(reason) { canceled = true; return reader.cancel(reason); },
      });
    };
    const canvas = document.getElementById('c'), layer = document.getElementById('t');
    const first = new AbortController();
    const old = drawPage(doc, 1, canvas, layer, 600, first.signal).then(() => 'resolved', e => e.name);
    await begun;
    first.abort();
    await drawPage(doc, 2, canvas, layer, 600, new AbortController().signal);
    release();
    const settled = await Promise.race([old, new Promise(r => setTimeout(() => r('pending'), 2000))]);
    await new Promise(r => setTimeout(r, 300));
    // Aborted before it starts: the container is not touched at all.
    const early = new AbortController(); early.abort();
    const before = layer.innerHTML;
    const skipped = await drawPage(doc, 1, canvas, layer, 600, early.signal).then(() => 'resolved', e => e.name);
    return {settled, canceled, text: layer.textContent, skipped, untouched: layer.innerHTML === before};
  }, pdf.toString('base64'));
  assert.equal(result.settled, 'AbortError', 'the obsolete draw ends as an abort');
  assert.equal(result.canceled, true, 'the text stream was canceled');
  assert.match(result.text, /Second synthetic page/);
  assert(!result.text.includes('SYNTHETIC IMPORT'), 'no page 1 text was appended after page 2');
  assert.deepEqual([result.skipped, result.untouched], ['AbortError', true]);
  assert.deepEqual(errors, []);
  await page.close();
});

test('phone width: one column, no horizontal scroll, controls reachable', async () => {
  const {page, host, errors} = await open('openai=1', {width: 390, height: 844});
  await page.evaluate(() => { document.querySelector('iframe').style.width = '390px'; });
  const frame = page.frames().find(f => f.url().includes('/widget.html'));
  await host(o => window.testHost.result(o), await render(2));
  await frame.waitForFunction(() => !document.getElementById('stage').hidden, null, {timeout: 15000});
  const layout = await frame.evaluate(() => ({scroll: document.documentElement.scrollWidth, width: innerWidth,
    columns: getComputedStyle(document.getElementById('layout')).gridTemplateColumns.split(' ').length,
    small: [...document.querySelectorAll('button')].filter(b => b.offsetParent && b.getBoundingClientRect().height < 32).length}));
  assert(layout.scroll <= layout.width, JSON.stringify(layout));
  assert.equal(layout.columns, 1);
  assert.equal(layout.small, 0, 'touch targets keep their size');
  assert((await painted(frame)).w > 200);
  assert.deepEqual(errors, []);
  await page.close();
});

test('read progress: cumulative echo, honest unread pages, no false complete', async () => {
  const {page, frame, host, errors} = await open('openai=1');
  // Page 1 came back without a text layer (as a scanned page does); the server lists it unread.
  const scanned = {...read1, pages: [{...read1.pages[0], segments: []}], needsOcrPages: [1], unreadPages: [1], nextPages: [2], complete: false};
  await host(o => window.testHost.result(o), scanned);
  await frame.waitForFunction(() => document.getElementById('pages-note').textContent.includes('OCR'));
  assert.match(await text(frame, '#progress-text'), /원문 0\/2페이지 읽음/, 'a scanned page is not counted as read');
  const reply = await readAttached({file, pages: [2], attemptedPages: [1], unreadPages: [1]}, deps);
  assert.equal(reply.complete, false, 'backend keeps page 1 unread');
  await host(r => { window.testHost.replies.tool = r; }, reply);
  await frame.click('#load-next');
  await frame.waitForFunction(() => document.querySelectorAll('#segments li.page-head').length === 2);
  const [call] = await host(() => window.testHost.calls.tools);
  assert.deepEqual(call.arguments.pages, [2]);
  assert.deepEqual(call.arguments.attemptedPages, [1], 'attempted pages echoed');
  assert.deepEqual(call.arguments.unreadPages, [1], 'unread pages echoed');
  assert.equal(call.arguments.language, 'Korean');
  assert.equal(await frame.$eval('#read-state', e => e.dataset.complete), 'false');
  assert.match(await text(frame, '#read-state'), /문서 전체를 읽지 못했어요/);
  assert.match(await text(frame, '#pages-note'), /OCR 필요\): 1/);
  assert(await frame.$eval('#load-next', b => b.disabled), 'nothing left that can be read');
  // A server that claims complete over an unread page is not believed.
  await host(o => window.testHost.result(o), {...reply, complete: true});
  await frame.waitForFunction(() => document.getElementById('read-state').dataset.complete === 'false');
  // A truncated document (beyond the page limit) is never complete either.
  await host(o => window.testHost.result(o), {...read1, attachment: {...read1.attachment, numPages: 250}, attemptedPages: Array.from({length: 200}, (_, i) => i + 1),
    unreadPages: [], nextPages: [], complete: true, pageLimit: 200, extractablePages: 200});
  await frame.waitForFunction(() => document.getElementById('pages-note').textContent.includes('200페이지 제한'));
  assert.equal(await frame.$eval('#read-state', e => e.dataset.complete), 'false');
  assert.match(await text(frame, '#pages-note'), /뒤의 50페이지는 읽지 않아요/);
  assert.deepEqual(errors, []);
  await page.close();
});

test('a fully read document shows complete, and a render keeps it', async () => {
  const {page, frame, host, errors} = await open('openai=1');
  await host(o => window.testHost.result(o), read1);
  await frame.waitForFunction(() => /아직 읽는 중/.test(document.getElementById('read-state').textContent));
  // read2 read only page 2; the backend reports page 1 as caller-reported. The reader holds
  // both pages with text for this PDF, so it may say the whole document was read.
  assert.deepEqual(read2.attemptedPages, [1, 2]);
  await host(r => { window.testHost.replies.tool = r; }, read2);
  await frame.click('#load-next');
  await frame.waitForFunction(() => document.getElementById('read-state').dataset.complete === 'true');
  assert.match(await text(frame, '#read-state'), /문서 전체의 원문을 읽었어요/);
  // render_attached_reader carries attemptedPages [] and complete false: progress stays.
  await host(o => window.testHost.result(o), await render(1));
  await frame.waitForFunction(() => document.querySelector('#segments li[role=option] .tr').textContent.startsWith('번역된'));
  assert.equal(await frame.$eval('#read-state', e => e.dataset.complete), 'true');
  assert(await frame.$eval('#load-next', b => b.disabled));
  // In a fresh view that never received page 1, the same result is only caller-reported.
  const fresh = await open('openai=1');
  await fresh.host(o => window.testHost.result(o), read2);
  await fresh.frame.waitForFunction(() => document.getElementById('read-state').textContent.length > 0);
  assert.equal(await fresh.frame.$eval('#read-state', e => e.dataset.complete), 'false');
  if (read2.reportedComplete) assert.match(await text(fresh.frame, '#read-state'), /이 화면이 받은 원문은 1\/2페이지/);
  await fresh.page.close();
  // The same complete reading restored from its exported JSON says the claim rests on that file.
  await frame.click('#export-json');
  await page.waitForFunction(() => window.testHost.calls.downloads.length > 0);
  const exported = (await host(() => window.testHost.calls.downloads)).at(-1).resource.text;
  const restoredView = await open('');
  await restoredView.frame.setInputFiles('#restore-start', {name: 'x.json', mimeType: 'application/json', buffer: Buffer.from(exported)});
  await restoredView.frame.waitForFunction(() => document.getElementById('read-state').textContent.length > 0);
  assert.equal(await restoredView.frame.$eval('#read-state', e => e.dataset.complete), 'true');
  assert.match(await text(restoredView.frame, '#read-state'), /불러온 JSON 파일[\s\S]*Sundark가 확인한 것은 아니에요/);
  assert.doesNotMatch(await text(restoredView.frame, '#read-state'), /문서 전체의 원문을 읽었어요/);
  await restoredView.page.close();
  assert.deepEqual(errors, []);
  await page.close();
});

test('a non-Korean translation keeps its language through render and requests', async () => {
  const readJa = await readAttached({file, pages: [1], language: 'Japanese'}, deps);
  assert.equal(readJa.translation.language, 'Japanese');
  assert(readJa.translation.batches.every(b => b.language === 'Japanese'));
  const renderJa = await renderAttached({file, page: 1, sourceHash: readJa.sourceHash, language: 'Japanese',
    translations: [{id: ids[0], text: 'これは翻訳された最初の文です。'}]}, deps);
  assert.equal(renderJa.translation.language, 'Japanese');
  const {page, frame, host, errors} = await open('openai=1');
  await host(o => window.testHost.result(o), readJa);
  await frame.waitForSelector('#segments li[role=option]');
  await host(o => window.testHost.result(o), renderJa);
  await frame.waitForFunction(() => document.querySelector('#segments li[role=option] .tr').textContent.includes('これは'));
  assert.match(await text(frame, '#translation-lang'), /Japanese/);
  assert.equal(await frame.$eval('#segments li[role=option] .tr', e => e.lang), 'ja', 'assistive technology reads it as Japanese');
  // Every request the reader sends keeps the language.
  await frame.click('#translate-next');
  await frame.click('#ask-summary');
  await page.waitForFunction(() => window.testHost.calls.messages.length === 2);
  const [next, summary] = await host(() => window.testHost.calls.messages);
  assert.match(next, /language Japanese/);
  assert.match(summary, /language Japanese/);
  await host(r => { window.testHost.replies.tool = r; }, read2);
  await frame.click('#load-next');
  await page.waitForFunction(() => window.testHost.calls.tools.length === 1);
  assert.equal((await host(() => window.testHost.calls.tools))[0].arguments.language, 'Japanese');
  // A later Korean result does not mix Korean after the Japanese prefix.
  await host(o => window.testHost.result(o), await render(ids.length));
  await frame.waitForFunction(() => document.getElementById('translation-lang').textContent.includes('Korean'));
  const trs = await frame.$$eval('#segments li[role=option] .tr', l => l.map(e => e.textContent));
  assert(!trs.some(t => t.includes('これは')), 'the Japanese translation was dropped, not mixed');
  assert.deepEqual(errors, []);
  await page.close();
});

// A page read is still out when the reading moves to Japanese. Its source-only reply (stamped
// Korean, the language it was asked in) adds page 2 but never switches the language back.
test('a read that returns after a switch to Japanese keeps the Japanese prefix and adds its page', async () => {
  const {page, frame, host, errors} = await open('openai=1');
  await host(o => window.testHost.result(o), read1);
  await frame.waitForSelector('#segments li[role=option]');
  await host(r => { window.testHost.replies.tool = r; window.testHost.replies.toolHold = new Promise(go => { window.releaseTool = go; }); }, read2);
  await frame.click('#load-next');
  await page.waitForFunction(() => window.testHost.calls.tools.length === 1);
  assert.equal((await host(() => window.testHost.calls.tools))[0].arguments.language, read2.translation.language);
  assert.notEqual(read2.translation.language, 'Japanese', 'the pending read carries the old language');
  const readJa = await readAttached({file, pages: [1], language: 'Japanese'}, deps);
  await host(o => window.testHost.result(o), await renderAttached({file, page: 1, sourceHash: readJa.sourceHash, language: 'Japanese',
    translations: [{id: ids[0], text: 'これは翻訳された最初の文です。'}]}, deps));
  await frame.waitForFunction(() => document.querySelector('#segments li[role=option] .tr')?.textContent.includes('これは'));
  await host(() => window.releaseTool());
  await frame.waitForFunction(() => document.querySelectorAll('#segments li.page-head').length === 2);
  assert.match(await text(frame, '#progress-text'), /원문 2\/2페이지/);
  assert.match(await text(frame, '#translation-lang'), /Japanese/, 'the late read did not switch the language back');
  assert.equal(await text(frame, '#segments li[role=option] .tr'), 'これは翻訳された最初の文です。', 'the Japanese prefix survived');
  await frame.click('#translate-next');
  await page.waitForFunction(() => window.testHost.calls.messages.length === 1);
  assert.match((await host(() => window.testHost.calls.messages))[0], /language Japanese/, 'the next read asks for Japanese');
  assert.deepEqual(errors, []);
  await page.close();
});

// The page read waits on a fresh file URL; another attachment arriving meanwhile means the
// old file is never read with it.
test('another attachment during the file URL wait stops the page read before its call', async () => {
  const {page, frame, host, errors} = await open('openai=1&urldelay=400');
  await host(o => window.testHost.result(o), read1);
  await frame.waitForSelector('#segments li[role=option]');
  await host(r => { window.testHost.replies.tool = r; }, read2);
  await frame.click('#load-next');
  await host(o => window.testHost.result(o), bigRead);
  await page.waitForTimeout(800);
  assert.deepEqual(await host(() => window.testHost.calls.tools), [], 'no read of the old file');
  assert.equal(await frame.$$eval('#segments li.page-head', l => l.length), 1);
  assert.deepEqual(errors, []);
  await page.close();
});

test('document-level analysis is labelled with its source pages beside any page', async () => {
  const task = await prepareAttachedTask({file, pages: [2], kind: 'summary'}, deps);
  const shown = await renderAttached({file, page: 1, sourceHash: read1.sourceHash,
    analysis: {kind: 'summary', language: 'Korean', sourcePages: [2], sourceHash: task.task.sourceHash, content: {text: '두 번째 페이지만 근거로 한 합성 요약.', citations: []}}}, deps);
  assert.equal(shown.analysis.coversShownPage, false);
  const {page, frame, host, errors} = await open('openai=1');
  await host(o => window.testHost.result(o), read1);
  await host(o => window.testHost.result(o), shown);
  await frame.waitForFunction(() => document.getElementById('results').textContent.includes('합성 요약'));
  const scope = () => frame.$eval('#results .scope', e => ({text: e.textContent, covers: e.dataset.covers}));
  let s = await scope();
  assert.equal(s.covers, 'false');
  assert.match(s.text, /근거 페이지: 2/);
  assert.match(s.text, /지금 보는 1페이지는 근거 밖이에요 \(문서 단위 결과로 유효해요\)/);
  assert(!(await frame.$eval('#results', e => e.hidden)), 'the analysis stays visible beside page 1');
  await frame.click('#next-page');
  await frame.waitForFunction(() => document.querySelector('#results .scope').dataset.covers === 'true');
  s = await scope();
  assert.match(s.text, /근거 페이지: 2 · 지금 보는 페이지 포함/);
  assert.deepEqual(errors, []);
  await page.close();
});

test('another attachment replaces the original view; a late download is never adopted', async () => {
  const {page, frame, host, errors} = await open('openai=1');
  await host(o => window.testHost.result(o), read1);
  await frame.waitForFunction(() => !document.getElementById('stage').hidden, null, {timeout: 15000});
  const other = {...read1, attachment: {...read1.attachment, fileId: 'file-OTHER', fileName: 'other.pdf', pdfSha256: 'c'.repeat(64)}};
  await host(o => window.testHost.result(o), other);
  await frame.waitForFunction(() => document.getElementById('original-msg').classList.contains('error'));
  const view = await frame.evaluate(() => ({stage: document.getElementById('stage').hidden, w: document.getElementById('canvas').width,
    text: document.getElementById('text-layer').childElementCount, title: document.getElementById('title').textContent}));
  assert.deepEqual(view, {stage: true, w: 0, text: 0, title: 'other.pdf'}, 'the old PDF is gone, not shown beside the new file');
  await frame.click('#next-page');
  await page.waitForTimeout(300);
  assert(await frame.$eval('#stage', e => e.hidden), 'navigation cannot bring the old PDF back');
  await page.close();

  // Slow chunks of file A; the attachment changes before they arrive.
  const slow = await open('openai=1', undefined, {delay: 1200});
  await slow.host(o => window.testHost.result(o), read1);
  await slow.page.waitForTimeout(200);
  await slow.host(o => window.testHost.result(o), other);
  await slow.page.waitForTimeout(2500);
  assert(await slow.frame.$eval('#stage', e => e.hidden), 'the late PDF of the old attachment is not adopted');
  assert.equal(await slow.frame.$eval('#title', e => e.textContent), 'other.pdf');
  assert.equal(await slow.frame.$eval('#canvas', c => c.width), 0, 'nothing of file A was drawn');
  assert.deepEqual(slow.errors, []);
  assert.deepEqual(errors, []);
  await slow.page.close();
});

// ChatGPT's window.openai bridge announces every global change, widget state included, through
// openai:set_globals; the stub's setWidgetState fires it the same way. A stale toolOutput must
// never fold back into the reading, and nothing repopulates the view after teardown.
test('openai:set_globals delivers only a changed toolOutput, never a stale one, and nothing after teardown', async () => {
  const {page, frame, host, errors} = await open('openai=1&globals=1');
  const announce = (out, full) => frame.evaluate(([o, f]) => {
    if (o) window.openai.toolOutput = o;
    const detail = f === 'none' ? undefined : {globals: f === 'all' ? {...window.openai} : {toolOutput: window.openai.toolOutput}};
    dispatchEvent(new CustomEvent('openai:set_globals', {detail}));
  }, [out, full]);
  await announce(read1);
  await frame.waitForSelector('#segments li[role=option]');
  // The reading then moves on through the MCP Apps bridge, into Japanese.
  const readJa = await readAttached({file, pages: [1], language: 'Japanese'}, deps);
  await host(o => window.testHost.result(o), readJa);
  await host(o => window.testHost.result(o), await renderAttached({file, page: 1, sourceHash: readJa.sourceHash, language: 'Japanese',
    translations: [{id: ids[0], text: '合成の翻訳文です。'}]}, deps));
  await frame.waitForFunction(() => document.querySelector('#segments li[role=option] .tr').textContent === '合成の翻訳文です。');
  // Selecting sentences sets widget state, which announces set_globals (widgetState only), and
  // hosts that resend every global or send no detail repeat the same initial toolOutput.
  await frame.click('#segments li[role=option]:nth-of-type(3)');
  await frame.click('#segments li[role=option]:nth-of-type(2)');
  await announce(null, 'all');
  await announce(null, 'none');
  await announce(null);
  await page.waitForTimeout(300);
  assert(JSON.parse((await frame.evaluate(() => window.__states)).at(-1)).seg, 'widget state was set through the globals bridge');
  assert.match(await text(frame, '#translation-lang'), /Japanese/, 'the stale Korean read did not switch the language back');
  assert.equal(await text(frame, '#segments li[role=option] .tr'), '合成の翻訳文です。', 'the stale read did not clear the translation');
  // A genuinely new toolOutput is still consumed.
  await announce(await render(1));
  await frame.waitForFunction(() => document.getElementById('translation-lang').textContent.includes('Korean'));
  await host(() => window.testHost.teardown());
  await frame.waitForFunction(() => document.getElementById('layout').hidden);
  await frame.evaluate(() => window.openai.setWidgetState({v: 1, page: 1}));
  await announce(null, 'all');
  await announce(null, 'none');
  await announce(read1);
  await page.waitForTimeout(300);
  const after = await frame.evaluate(() => ({options: document.querySelectorAll('#segments li').length, layout: document.getElementById('layout').hidden,
    text: document.body.innerText.includes('SYNTHETIC')}));
  assert.deepEqual(after, {options: 0, layout: true, text: false});
  assert.deepEqual(errors, []);
  await page.close();
});

test('teardown clears the document and late work does not bring it back', async () => {
  const {page, frame, host, errors} = await open('openai=1', undefined, {delay: 1200});
  await host(o => window.testHost.result(o), read1);
  await frame.waitForSelector('#segments li[role=option]');
  await host(() => window.testHost.teardown());
  const cleared = await frame.evaluate(() => ({options: document.querySelectorAll('#segments li').length, layout: document.getElementById('layout').hidden,
    stage: document.getElementById('stage').hidden, w: document.getElementById('canvas').width}));
  assert.deepEqual(cleared, {options: 0, layout: true, stage: true, w: 0});
  // The chunk requested before teardown arrives now; nothing is resurrected.
  await page.waitForTimeout(2500);
  const after = await frame.evaluate(() => ({options: document.querySelectorAll('#segments li').length, stage: document.getElementById('stage').hidden,
    text: document.body.innerText.includes('SYNTHETIC')}));
  assert.deepEqual(after, {options: 0, stage: true, text: false});
  assert.deepEqual(errors, []);
  await page.close();
});
