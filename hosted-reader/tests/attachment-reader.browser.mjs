// Ephemeral attachment reader in real Chromium: a fake MCP Apps host (official AppBridge)
// drives the built widget with REAL read_attached_pdf/render_attached_reader results for a
// synthetic PDF, inside an opaque-origin sandbox with a strict CSP. Synthetic data only.
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
import {twoPagePdf} from './fixtures/synthetic-pdf.mjs';

register('./fixtures/worker-loader.mjs', import.meta.url);
globalThis.__workerEnv = new Proxy({}, {get(t, key) { if (key === 'DB' || key === 'BUCKET') throw new Error('storage access'); return t[key]; }});
const {readAttached, renderAttached, prepareAttachedTask, attachmentLauncher} = await import('../lib/attachment.ts');
const {attachmentReaderHtml, attachmentReaderUri} = await import('../lib/attachment-reader.ts');

const pdf = twoPagePdf();
const pdfSha = createHash('sha256').update(pdf).digest('hex');
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
  if (url.pathname === '/file.pdf') {
    if (url.searchParams.get('delay')) await new Promise(r => setTimeout(r, Number(url.searchParams.get('delay'))));
    res.writeHead(200, {'Content-Type': 'application/pdf', 'Access-Control-Allow-Origin': '*'});
    return res.end(pdf);
  }
  if (url.pathname === '/host.html') {
    res.writeHead(200, {'Content-Type': 'text/html'});
    return res.end('<!doctype html><meta charset="utf-8"><title>host</title><body><script src="/host.js"></script>');
  }
  if (url.pathname === '/host.js') { res.writeHead(200, {'Content-Type': 'text/javascript'}); return res.end(hostJs); }
  if (url.pathname === '/widget.html') {
    const q = url.searchParams;
    const fileUrl = `${origin}/file.pdf?token=short-lived${q.get('delay') ? '&delay=' + q.get('delay') : ''}`;
    const stub = `<script>window.__csp=[];document.addEventListener('securitypolicyviolation',e=>window.__csp.push(e.violatedDirective+' '+e.blockedURI+' '+e.lineNumber+':'+e.columnNumber));` +
      (q.get('openai') ? `window.__states=[];window.openai={widgetState:${q.get('state') || 'null'},setWidgetState(s){this.widgetState=s;window.__states.push(JSON.stringify(s));${q.get('globals') ? "dispatchEvent(new CustomEvent('openai:set_globals',{detail:{globals:{widgetState:s}}}))" : ''}},getFileDownloadUrl:async({fileId})=>fileId==='file-TEST'?{downloadUrl:${JSON.stringify(fileUrl)}}:Promise.reject(new Error('unknown file'))};` : '') +
      '</script>';
    res.writeHead(200, {'Content-Type': 'text/html',
      // As strict as a host sandbox: inline code only, and fetch only to the file host.
      'Content-Security-Policy': `default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data: blob:; connect-src ${q.get('csp') === 'block' ? "'none'" : origin}`});
    return res.end(attachmentReaderHtml.replace('<script>', () => stub + '<script>'));
  }
  res.writeHead(404); res.end();
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const origin = `https://127.0.0.1:${server.address().port}`;
const hostJs = (await build({entryPoints: [new URL('./fixtures/attachment-host.mjs', import.meta.url).pathname], bundle: true, write: false, format: 'iife', platform: 'browser', logLevel: 'silent'})).outputFiles[0].text;

// The server tools read the same bytes from a plain-http dev origin (the only kind their
// download gate allows besides the real file host).
const backend = http.createServer((req, res) => { res.writeHead(200, {'Content-Type': 'application/pdf'}); res.end(pdf); });
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

let browser;
before(async () => { browser = await chromium.launch(); });
after(async () => { await browser?.close(); for (const s of [server, backend]) { s.closeAllConnections(); s.close(); } });

async function open(query = 'openai=1', viewport = {width: 1320, height: 960}) {
  const page = await browser.newPage({viewport, ignoreHTTPSErrors: true});
  const errors = [];
  page.on('pageerror', e => errors.push(String(e)));
  await page.goto(`${origin}/host.html?${query}`);
  await page.waitForFunction(() => window.testHost);
  await page.evaluate(() => window.testHost.ready());
  const frame = () => page.frames().find(f => f.url().includes('/widget.html'));
  return {page, errors, frame: frame(), host: (fn, arg) => page.evaluate(fn, arg)};
}
const text = (frame, sel) => frame.$eval(sel, e => e.textContent);
const painted = frame => frame.$eval('#canvas', c => {
  const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
  let dark = 0; for (let i = 0; i < d.length; i += 4) if (d[i] < 128) dark++;
  return {w: c.width, h: c.height, dark, visible: !c.closest('#stage').hidden};
});

test('exports the resource the backend registers', () => {
  assert.equal(attachmentReaderUri, 'ui://sundark/attachment-reader.html');
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
  const {page, frame, host, errors} = await open('openai=1&delay=1500');
  await host(o => window.testHost.result(o), read1);
  await frame.waitForSelector('#segments li[role=option]');
  // The PDF is still downloading (1.5 s delay): sources and status are already on screen.
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
  // Only the widget and the host-issued file URL were requested; nothing else, no Sundark API.
  assert.deepEqual([...new Set(requests)].sort(), ['/file.pdf', '/host.html', '/host.js', '/widget.html']);
  assert.deepEqual(await frame.evaluate(() => window.__csp), [], 'self-contained under a strict CSP');
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

test('host gates fail visibly: CSP-blocked download and missing file URL API', async () => {
  const blocked = await open('openai=1&csp=block');
  await blocked.host(o => window.testHost.result(o), read1);
  await blocked.frame.waitForFunction(() => document.getElementById('original-msg').classList.contains('error'), null, {timeout: 15000});
  assert.match(await text(blocked.frame, '#original-msg'), /CSP|CORS/);
  assert(await blocked.frame.$eval('#stage', e => e.hidden), 'no fake original view');
  assert.equal(await blocked.frame.$$eval('#segments li[role=option]', l => l.length), ids.length, 'sources still readable');
  await blocked.page.close();

  const bare = await open('');
  await bare.host(o => window.testHost.result(o), read1);
  await bare.frame.waitForFunction(() => document.getElementById('original-msg').classList.contains('error'));
  assert.match(await text(bare.frame, '#original-msg'), /다운로드 링크/);
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

  // Slow download of file A; the attachment changes before it arrives.
  const slow = await open('openai=1&delay=1200');
  await slow.host(o => window.testHost.result(o), read1);
  await slow.page.waitForTimeout(200);
  await slow.host(o => window.testHost.result(o), other);
  await slow.page.waitForTimeout(2500);
  assert(await slow.frame.$eval('#stage', e => e.hidden), 'the late PDF of the old attachment is not adopted');
  assert.equal(await slow.frame.$eval('#title', e => e.textContent), 'other.pdf');
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
  const {page, frame, host, errors} = await open('openai=1&delay=1200');
  await host(o => window.testHost.result(o), read1);
  await frame.waitForSelector('#segments li[role=option]');
  await host(() => window.testHost.teardown());
  const cleared = await frame.evaluate(() => ({options: document.querySelectorAll('#segments li').length, layout: document.getElementById('layout').hidden,
    stage: document.getElementById('stage').hidden, w: document.getElementById('canvas').width}));
  assert.deepEqual(cleared, {options: 0, layout: true, stage: true, w: 0});
  // The download started before teardown finishes now; nothing is resurrected.
  await page.waitForTimeout(2500);
  const after = await frame.evaluate(() => ({options: document.querySelectorAll('#segments li').length, stage: document.getElementById('stage').hidden,
    text: document.body.innerText.includes('SYNTHETIC')}));
  assert.deepEqual(after, {options: 0, stage: true, text: false});
  assert.deepEqual(errors, []);
  await page.close();
});
