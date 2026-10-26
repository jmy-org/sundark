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
  assert.deepEqual(fileHosts(undefined), ['files.oaiusercontent.com']);
  assert.deepEqual(fileHosts(' A.example.com ,*.blob.core.windows.net,10.0.0.1,https://x.example/,b.example '), ['a.example.com', 'b.example']);
  assert.deepEqual(fileHosts(''), []);
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
