// Attachment import: download policy and server/browser extraction parity. Synthetic data only.
import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';
import {MAX_PDF, PdfFileError, checkFileUrl, downloadPdf, fileHosts, isPdf, pdfName} from '../lib/pdf-file.ts';
import {buildSentenceSegments, pdfTextAtoms} from '../lib/source-geometry.ts';
import {twoPagePdf, scannedPdf, TWO_PAGE_LINES} from './fixtures/synthetic-pdf.mjs';

const policy = {hosts: ['files.oaiusercontent.com']};
const rejects = (raw, p = policy) => assert.throws(() => checkFileUrl(raw, p), PdfFileError, String(raw));

test('download URL policy is exact-host https only', () => {
  assert.equal(checkFileUrl('https://files.oaiusercontent.com/file-abc?sig=x', policy).hostname, 'files.oaiusercontent.com');
  for (const raw of ['http://files.oaiusercontent.com/f', 'https://evil.files.oaiusercontent.com/f', 'https://files.oaiusercontent.com.evil.example/f',
    'https://user:pw@files.oaiusercontent.com/f', 'https://files.oaiusercontent.com:8443/f', 'https://127.0.0.1/f', 'https://[::1]/f',
    'https://10.0.0.1/f', 'https://sundark.blob.core.windows.net/f', 'file:///etc/passwd', 'javascript:alert(1)', 'not a url', '', 42, null])
    rejects(raw);
});

test('local fixture origin is exact and only honored when supplied', () => {
  const local = {...policy, devOrigin: 'http://127.0.0.1:5199'};
  assert.equal(checkFileUrl('http://127.0.0.1:5199/two-page.pdf', local).port, '5199');
  rejects('http://127.0.0.1:5199/two-page.pdf');
  rejects('http://127.0.0.1:5198/two-page.pdf', local);
  rejects('http://localhost:5199/two-page.pdf', local);
});

test('host allowlist parsing keeps exact hostnames and drops wildcards, IPs and URLs', () => {
  assert.deepEqual(fileHosts(undefined), [], 'the namespace rule covers files.oaiusercontent.com; extras are exact hosts only');
  assert.deepEqual(fileHosts(' A.example.com ,*.blob.core.windows.net,10.0.0.1,https://x.example/,b.example '), ['a.example.com', 'b.example']);
  assert.deepEqual(fileHosts(''), []);
});

// Regional ChatGPT file hosts observed live (read on one, render on the other). Only these two
// exact hosts are asserted under the default policy; the final host policy is still open.
const REGIONAL = ['sdmntprindiasocentral.oaiusercontent.com', 'sdmntprwestus2.oaiusercontent.com'];
const defaults = {hosts: fileHosts(undefined)};

test('default policy accepts the two observed regional file hosts', () => {
  for (const host of REGIONAL)
    assert.equal(checkFileUrl(`https://${host}/files/SYNTHETIC/raw?se=2026&sig=x`, defaults).hostname, host);
});

test('regional host boundaries stay blocked under the default policy', () => {
  for (const host of REGIONAL) {
    for (const raw of ['https://oaiusercontent.com/f', `https://x.${host}/f`, `https://${host}.evil.example/f`,
      `http://${host}/f`, `https://user:pw@${host}/f`, `https://${host}:8443/f`, `ftp://${host}/f`,
      'https://127.0.0.1/f', 'https://[::1]/f', 'https://10.0.0.1/f', 'https://20.0.0.1/f'])
      rejects(raw, defaults);
  }
});

test('a regional download does not follow a redirect, even to the other regional host', async () => {
  const calls = [];
  const fetcher = async (href, init) => {
    calls.push({href, redirect: init.redirect});
    return new Response(null, {status: 302, headers: {Location: `https://${REGIONAL[1]}/files/SYNTHETIC/raw?sig=SECRET-TOKEN`}});
  };
  const url = new URL(`https://${REGIONAL[0]}/files/SYNTHETIC/raw?sig=SECRET-TOKEN`);
  await assert.rejects(downloadPdf(url, {fetcher}), e => e instanceof PdfFileError && e.status === 502 && !e.message.includes('SECRET') && !e.message.includes('oaiusercontent'));
  assert.deepEqual(calls, [{href: url.href, redirect: 'manual'}]);
});

// The ChatGPT file namespace: exactly one DNS label under oaiusercontent.com, with no extra host
// listed. It proves the namespace only, not that the file is the user's (see lib/pdf-file.ts).
const none = {hosts: []};
test('namespace rule: any single label under oaiusercontent.com, nothing else', () => {
  for (const host of ['files.oaiusercontent.com', 'sdmntprwestus2.oaiusercontent.com', 'zz9q.oaiusercontent.com', 'a.oaiusercontent.com', `${'a'.repeat(63)}.oaiusercontent.com`, 'x-1.oaiusercontent.com'])
    assert.equal(checkFileUrl(`https://${host}/files/SYNTHETIC/raw?sig=x`, none).hostname, host);
  for (const raw of ['https://oaiusercontent.com/f', 'https://a.b.oaiusercontent.com/f', 'https://xoaiusercontent.com/f', 'https://x.xoaiusercontent.com/f',
    'https://oaiusercontent.com.evil.example/f', 'https://x.oaiusercontent.com.evil.example/f', 'https://-x.oaiusercontent.com/f', 'https://x-.oaiusercontent.com/f',
    `https://${'a'.repeat(64)}.oaiusercontent.com/f`, 'https://x.oaiusercontent.com./f', 'https://x_y.oaiusercontent.com/f',
    'http://x.oaiusercontent.com/f', 'https://x.oaiusercontent.com:443x/f', 'https://x.oaiusercontent.com:8443/f', 'https://u:p@x.oaiusercontent.com/f',
    'https://evil.example\\@x.oaiusercontent.com/f', 'https://evil.example#@x.oaiusercontent.com/f', 'https://127.0.0.1/f', 'https://[::1]/f', 'https://10.0.0.1/f',
    'file:///x.oaiusercontent.com/f', 'javascript:alert(1)//x.oaiusercontent.com', 'ftp://x.oaiusercontent.com/f'])
    rejects(raw, none);
  // Unsupported vs unsafe: a plain https name outside the namespace is a configuration refusal.
  assert.throws(() => checkFileUrl('https://a.b.oaiusercontent.com/f', none), e => e.reason === 'unsupported_host' && /exact/.test(e.message));
  assert.throws(() => checkFileUrl('https://x.oaiusercontent.com:8443/f', none), e => e.reason === 'unsafe_url');
});

test('namespace rule: WHATWG normalization is what the gate sees', () => {
  // Uppercase is lowercased; the default port is dropped; a percent-encoded dot is decoded into a second label.
  assert.equal(checkFileUrl('https://FILES.OaiUserContent.COM/f', none).hostname, 'files.oaiusercontent.com');
  assert.equal(checkFileUrl('https://x.oaiusercontent.com:443/f', none).hostname, 'x.oaiusercontent.com');
  assert.equal(new URL('https://a%2Eb.oaiusercontent.com/f').hostname, 'a.b.oaiusercontent.com');
  rejects('https://a%2Eb.oaiusercontent.com/f', none);
  // A backslash ends the authority for https, so the host is the namespace label and the rest is path.
  assert.equal(new URL('https://x.oaiusercontent.com\\@evil.example/f').hostname, 'x.oaiusercontent.com');
  assert.equal(checkFileUrl('https://x.oaiusercontent.com\\@evil.example/f', none).hostname, 'x.oaiusercontent.com');
});

test('an exact extra host passes only when it is listed', () => {
  const extra = 'sundarkfiles.blob.core.windows.net';
  rejects(`https://${extra}/f`, none);
  assert.equal(checkFileUrl(`https://${extra}/f`, {hosts: fileHosts(extra)}).hostname, extra);
  rejects(`https://x.${extra}/f`, {hosts: fileHosts(extra)});
  rejects('https://other.blob.core.windows.net/f', {hosts: fileHosts(extra)});
});

// ChatGPT's Azure file accounts: oaisdmntpr<suffix>.blob.core.windows.net, a whole Azure account
// name (3-24 lowercase letters and digits). Observed compatibility, not proof of OpenAI ownership.
test('Azure file account family: observed and future region accounts, no extra host listed', () => {
  for (const account of ['oaisdmntprwestus2', 'oaisdmntprindiasocentral', 'oaisdmntprkoreacentral', 'oaisdmntprbrazilsouth', 'oaisdmntpre', `oaisdmntpr${'9'.repeat(14)}`])
    assert.equal(checkFileUrl(`https://${account}.blob.core.windows.net/files/SYNTHETIC/raw?se=2026&sig=x`, none).hostname, `${account}.blob.core.windows.net`);
  assert.equal(checkFileUrl('https://OaiSdmntprWestUS2.Blob.Core.Windows.Net:443/f', none).hostname, 'oaisdmntprwestus2.blob.core.windows.net');
  const refused = ['oaisdmntpr.blob.core.windows.net', `oaisdmntpr${'9'.repeat(15)}.blob.core.windows.net`, 'oaisdmntpr-westus2.blob.core.windows.net',
    'oaisdmntpr_westus2.blob.core.windows.net', 'oaisdmntprwestus2-eat02prdstrz08a.blob.core.windows.net', 'x.oaisdmntprwestus2.blob.core.windows.net',
    'oaisdmntprwestus2.privatelink.blob.core.windows.net', 'oaisdmntprwestus2.blob.core.windows.net.evil.example', 'oaisdmntprwestus2.blob.core.windows.net.',
    'oaisdmntprwestus2.web.core.windows.net', 'oaisdmntprwestus2.file.core.windows.net', 'oaisdmntprwestus2.z12.blob.storage.azure.net',
    'oaisdmntprwestus2.blob.core.windows.com', 'oaisdmntprwestus2.blob.core.chinacloudapi.cn', 'xoaisdmntprwestus2.blob.core.windows.net',
    'sdmntprwestus2.blob.core.windows.net', 'evil.blob.core.windows.net', 'blob.core.windows.net', 'oaisdmntprwestus2.windows.net', 'oaisdmntprwestus2.oaiusercontent.com.evil.example'];
  for (const host of refused)
    assert.throws(() => checkFileUrl(`https://${host}/f`, none), e => e instanceof PdfFileError && ['unsupported_host', 'unsafe_url'].includes(e.reason), host);
  assert.throws(() => checkFileUrl('https://evil.blob.core.windows.net/f', none), e => e.reason === 'unsupported_host' && e.host === 'evil.blob.core.windows.net' && /oaisdmntpr/.test(e.message));
  rejects('https://a%2Eoaisdmntprwestus2.blob.core.windows.net/f', none);
  for (const raw of ['http://oaisdmntprwestus2.blob.core.windows.net/f', 'https://u:p@oaisdmntprwestus2.blob.core.windows.net/f',
    'https://oaisdmntprwestus2.blob.core.windows.net:8443/f', 'ftp://oaisdmntprwestus2.blob.core.windows.net/f', 'https://evil.example\\@oaisdmntprwestus2.blob.core.windows.net/f'])
    rejects(raw, none);
});

test('an Azure family download does not follow a redirect, even within the family', async () => {
  const calls = [];
  const fetcher = async (href, init) => {
    calls.push({href, redirect: init.redirect});
    return new Response(null, {status: 302, headers: {Location: 'https://oaisdmntprindiasocentral.blob.core.windows.net/files/SYNTHETIC/raw?sig=SECRET-TOKEN'}});
  };
  const url = checkFileUrl('https://oaisdmntprwestus2.blob.core.windows.net/files/SYNTHETIC/raw?sig=SECRET-TOKEN', none);
  await assert.rejects(downloadPdf(url, {fetcher}), e => e instanceof PdfFileError && e.status === 502 && !e.message.includes('SECRET') && !e.message.includes('windows.net'));
  assert.deepEqual(calls, [{href: url.href, redirect: 'manual'}]);
});

test('PDF signature and stored name', () => {
  assert(isPdf(twoPagePdf()));
  assert(!isPdf(new TextEncoder().encode('<html>no</html>')));
  assert(!isPdf(new TextEncoder().encode('%PDF-')));
  assert.equal(pdfName('a/b\\c\u0001.PDF'), 'a_b_c_.PDF');
  assert.equal(pdfName('notes'), 'notes.pdf');
  assert.equal(pdfName(undefined), 'paper.pdf');
});

async function fixtureServer(handler) {
  const server = http.createServer(handler);
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const origin = `http://127.0.0.1:${server.address().port}`;
  return {origin, url: path => new URL(origin + path), close: () => new Promise(r => { server.closeAllConnections(); server.close(r); })};
}

test('bounded download: exact bytes, no redirect, caps, timeout, no URL in errors', async () => {
  const pdf = twoPagePdf();
  let seen;
  const s = await fixtureServer((req, res) => {
    seen = req.headers;
    if (req.url.startsWith('/ok')) { res.writeHead(200, {'Content-Type': 'application/pdf'}); res.end(pdf); }
    else if (req.url.startsWith('/redirect')) { res.writeHead(302, {Location: '/ok'}); res.end(); }
    else if (req.url.startsWith('/declared')) { res.writeHead(200, {'Content-Length': String(MAX_PDF + 1)}); res.write('%PDF-1.4'); }
    else if (req.url.startsWith('/stream')) { res.writeHead(200); const chunk = Buffer.alloc(1024 * 1024, 32); let n = 0; const push = () => { while (n++ < 22) if (!res.write(chunk)) return res.once('drain', push); res.end(); }; push(); }
    else if (req.url.startsWith('/slow')) { res.writeHead(200); res.write('%PDF-1.4'); }
    else if (req.url.startsWith('/missing')) { res.writeHead(404); res.end('gone'); }
  });
  try {
    const bytes = await downloadPdf(s.url('/ok?sig=SECRET-TOKEN'));
    assert.deepEqual(Buffer.from(bytes), pdf);
    assert.equal(seen.cookie, undefined); assert.equal(seen.authorization, undefined);
    for (const [path, status] of [['/redirect?sig=SECRET-TOKEN', 502], ['/declared?sig=SECRET-TOKEN', 413], ['/stream?sig=SECRET-TOKEN', 413], ['/missing?sig=SECRET-TOKEN', 502]]) {
      await assert.rejects(downloadPdf(s.url(path)), e => e instanceof PdfFileError && e.status === status && !e.message.includes('SECRET') && !e.message.includes('127.0.0.1'), path);
    }
    await assert.rejects(downloadPdf(s.url('/slow?sig=SECRET-TOKEN'), {timeoutMs: 300}), e => e instanceof PdfFileError && e.status === 504 && !e.message.includes('SECRET'));
  } finally { await s.close(); }
});

// The browser build calls Uint8Array#toHex, which browsers ship and Node 24 does not yet.
Uint8Array.prototype.toHex ??= function () { return Buffer.from(this).toString('hex'); };
async function pdfSegments(build, bytes) {
  const pdf = await import(`pdfjs-dist/${build}/pdf.mjs`);
  globalThis.pdfjsWorker ??= await import(`pdfjs-dist/${build}/pdf.worker.mjs`);
  const task = pdf.getDocument({data: new Uint8Array(bytes), useWorkerFetch: false, isEvalSupported: false, disableFontFace: true});
  const doc = await task.promise;
  const pages = [];
  for (let n = 1; n <= doc.numPages; n++) {
    const page = await doc.getPage(n);
    const viewport = page.getViewport({scale: 1});
    const atoms = pdfTextAtoms(await page.getTextContent(), viewport, pdf.Util.transform, n);
    pages.push({width: viewport.width, height: viewport.height, segments: buildSentenceSegments(atoms, n, 'text')});
  }
  await task.destroy();
  return pages;
}

test('legacy (server) and browser pdf.js builds yield identical source segments', async () => {
  const pdf = twoPagePdf();
  const browser = await pdfSegments('build', pdf);
  const server = await pdfSegments('legacy/build', pdf);
  assert.deepEqual(server, browser);
  assert.equal(server.length, 2);
  const text = server.map(p => p.segments.map(s => s.text).join(' '));
  assert(text[0].includes('Plants use light to grow.'));
  assert(text[0].includes('This synthetic sentence wraps across two lines for geometry checks.'));
  assert(text[1].includes(TWO_PAGE_LINES[1][0]));
  for (const page of server) for (const s of page.segments) assert(s.bbox[2] > 0 && s.bbox[3] > 0 && s.geometryPrecision === 'pdf-item');
  const wrapped = server[0].segments.find(s => s.text.startsWith('This synthetic'));
  assert.equal(wrapped.rects.length, 2);
});

test('image-only PDF yields no invented source', async () => {
  const [page] = await pdfSegments('legacy/build', scannedPdf());
  assert.deepEqual(page.segments, []);
});
