// Visual capture of the attachment reader under the test MCP Apps host (no assertions).
// `node tests/reader-visual.capture.mjs <sample.pdf> <outdir>` after `node scripts/build-attachment-reader.mjs`.
// Translations are the local e2e fixture's text, so the local and widget captures show the same reading.
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import http from 'node:http';
import https from 'node:https';
import {mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {register} from 'node:module';
import {build} from 'esbuild';
import {chromium} from 'playwright';

register('./fixtures/worker-loader.mjs', import.meta.url);
globalThis.__workerEnv = new Proxy({}, {get(t, key) { if (key === 'DB' || key === 'BUCKET') throw new Error('storage access'); return t[key]; }});
const {readAttached, readAttachedOriginal, renderAttached} = await import('../lib/attachment.ts');
const {attachmentReaderHtml} = await import('../lib/attachment-reader.ts');

const [pdfPath, outDir] = process.argv.slice(2);
const pdf = readFileSync(pdfPath);
mkdirSync(outDir, {recursive: true});
const TR = '연구 결과를 설명한다';

const backend = http.createServer((req, res) => { res.writeHead(200, {'Content-Type': 'application/pdf'}); res.end(pdf); });
await new Promise(r => backend.listen(0, '127.0.0.1', r));
const backendOrigin = `http://127.0.0.1:${backend.address().port}`;
const deps = {policy: {hosts: [], devOrigin: backendOrigin}};
const file = {download_url: `${backendOrigin}/file.pdf`, file_id: 'file-TEST', file_name: 'browser-study.pdf'};
const read1 = await readAttached({file, pages: [1]}, deps);
const ids = read1.pages[0].segments.map(s => s.id);
const rendered = await renderAttached({file, page: 1, sourceHash: read1.sourceHash, translations: ids.map(id => ({id, text: TR}))}, deps);
const analysed = {...rendered, analysis: {kind: 'summary', language: 'Korean', sourcePages: [1], sourceHash: read1.sourceHash,
  content: {text: '두 방법을 비교하고 재현 가능한 근거를 제시한다.\n\n핵심: 번역의 신뢰도를 측정한다.', citations: []}}};

const certDir = mkdtempSync(join(tmpdir(), 'sundark-visual-'));
execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=127.0.0.1',
  '-addext', 'subjectAltName=IP:127.0.0.1', '-keyout', join(certDir, 'key.pem'), '-out', join(certDir, 'cert.pem')], {stdio: 'ignore'});
const tls = {key: readFileSync(join(certDir, 'key.pem')), cert: readFileSync(join(certDir, 'cert.pem'))};
rmSync(certDir, {recursive: true, force: true});
const hostJs = (await build({entryPoints: [new URL('./fixtures/attachment-host.mjs', import.meta.url).pathname], bundle: true, write: false, format: 'iife', platform: 'browser', logLevel: 'silent'})).outputFiles[0].text;
const server = https.createServer(tls, (req, res) => {
  const url = new URL(req.url, 'https://x');
  if (url.pathname === '/host.html') { res.writeHead(200, {'Content-Type': 'text/html'}); return res.end('<!doctype html><meta charset="utf-8"><style>body{margin:0}</style><body><script src="/host.js"></script>'); }
  if (url.pathname === '/host.js') { res.writeHead(200, {'Content-Type': 'text/javascript'}); return res.end(hostJs); }
  if (url.pathname === '/widget.html') {
    res.writeHead(200, {'Content-Type': 'text/html', 'Content-Security-Policy': "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data: blob:; connect-src 'none'"});
    const stub = `<script>window.openai={widgetState:null,setWidgetState(s){this.widgetState=s},getFileDownloadUrl:async()=>({downloadUrl:location.origin+'/file.pdf?token=visual'})};</script>`;
    return res.end(attachmentReaderHtml.replace('<script>', () => stub + '<script>'));
  }
  res.writeHead(404); res.end();
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const origin = `https://127.0.0.1:${server.address().port}`;

const browser = await chromium.launch();
const shots = [];
async function capture(name, {width, height, scheme, modes = 'inline,fullscreen', mode = 'inline', data = rendered, tab}) {
  const page = await browser.newPage({viewport: {width, height}, colorScheme: scheme, ignoreHTTPSErrors: true});
  const errors = [];
  page.on('pageerror', e => errors.push(String(e)));
  await page.exposeFunction('serveOriginal', async args => {
    const r = await readAttachedOriginal({...args, file: {...args.file, download_url: `${backendOrigin}/file.pdf`}}, deps);
    return {content: [{type: 'text', text: JSON.stringify(r.data)}], structuredContent: {...r.data}, _meta: {...r.meta}};
  });
  await page.goto(`${origin}/host.html?openai=1&modes=${modes}&mode=${mode}`);
  await page.waitForFunction(() => window.testHost);
  await page.evaluate(() => window.testHost.ready());
  await page.evaluate(theme => window.testHost.context({theme}), scheme);
  await page.evaluate(w => { const f = document.querySelector('iframe'); f.style.width = w + 'px'; }, width);
  const frame = page.frames().find(f => f.url().includes('/widget.html'));
  await page.evaluate(o => window.testHost.result(o), data);
  await frame.waitForFunction(() => !document.getElementById('stage').hidden, null, {timeout: 15000});
  // The second sentence is selected, as a reader would pin it.
  await frame.evaluate(id => document.getElementById('seg-' + id)?.click(), ids[1]);
  if (tab) await frame.evaluate(t => document.getElementById(t)?.click(), tab);
  await page.waitForTimeout(300);
  // Auto-resize as a host would: the frame takes its content height (fullscreen keeps the viewport).
  const h = mode === 'fullscreen' ? height : await frame.evaluate(() => document.documentElement.scrollHeight);
  await page.evaluate(h => { document.querySelector('iframe').style.height = h + 'px'; }, h);
  await page.waitForTimeout(400);
  const path = join(outDir, `widget-${name}.png`);
  await (await page.$('iframe')).screenshot({path});
  shots.push({name, width, height: h, scheme, mode, errors});
  await page.close();
}
const variants = process.env.VARIANTS ? JSON.parse(process.env.VARIANTS) : {};
for (const scheme of ['light', 'dark']) {
  await capture(`fullscreen-1280-${scheme}`, {width: 1280, height: 800, scheme, mode: 'fullscreen'});
  await capture(`inline-760-${scheme}`, {width: 760, height: 800, scheme});
  await capture(`phone-390-${scheme}`, {width: 390, height: 844, scheme});
  await capture(`analysis-1280-${scheme}`, {width: 1280, height: 800, scheme, mode: 'fullscreen', data: analysed, tab: variants.analysisTab});
}
writeFileSync(join(outDir, 'widget-shots.json'), JSON.stringify(shots, null, 1));
console.log(JSON.stringify(shots.map(s => [s.name, s.height, s.errors.length])));
await browser.close();
for (const s of [server, backend]) { s.closeAllConnections(); s.close(); }
