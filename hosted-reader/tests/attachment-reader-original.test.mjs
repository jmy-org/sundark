// The reader's in-band original PDF loop (client/attachment-reader/original.ts) against a fake
// host bridge: chunk assembly, _meta-only bytes, chunk consistency, cancellation and deadlines.
// Synthetic data only; the browser fetches nothing, so there is no network here at all.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {register} from 'node:module';
import test from 'node:test';

register('./fixtures/worker-loader.mjs', import.meta.url);
const O = await import('../client/attachment-reader/original.ts');

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const CHUNK = 512 * 1024;
const BYTES = Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(2 * CHUNK + 5000, 7)]);
const SHA = sha(BYTES);
const file = {fileId: 'file-SYNTHETIC', fileName: 'synthetic.pdf', pdfSha256: SHA};
const SIGNED = 'https://sdmntprwestus2.oaiusercontent.com/files/SYNTHETIC/raw?sig=SECRET';

/** A host bridge serving BYTES in CHUNK slices; tweak(result, args, n) may change a result. */
function bridge({tweak = r => r, call: override} = {}) {
  const urls = [], calls = [];
  return {urls, calls, fileUrl: async id => { urls.push(id); return `${SIGNED}&n=${urls.length}`; },
    call: override ?? (async (args, options) => {
      calls.push({args, options});
      const {offset} = args, slice = BYTES.subarray(offset, offset + CHUNK);
      const data = {fileId: args.file.file_id, pdfSha256: args.pdfSha256, offset, length: slice.length, total: BYTES.length, done: offset + slice.length === BYTES.length};
      return tweak({structuredContent: data, meta: {[O.ORIGINAL_META]: slice.toString('base64')}}, args, calls.length);
    })};
}
const run = (b, signal = new AbortController().signal, progress, limits) => O.loadOriginalBytes(b, file, signal, progress, limits);

test('assembles aligned chunks, a fresh URL per call, bytes only from _meta', async () => {
  const b = bridge(), seen = [];
  const bytes = await run(b, undefined, (n, total) => seen.push([n, total]));
  assert(Buffer.from(bytes).equals(BYTES));
  assert.deepEqual(b.calls.map(c => c.args.offset), [0, CHUNK, 2 * CHUNK]);
  assert.deepEqual(seen, [[1, 3], [2, 3]]);
  assert.equal(new Set(b.calls.map(c => c.args.file.download_url)).size, 3, 'a fresh URL for every call');
  for (const {args, options} of b.calls) {
    assert.deepEqual(Object.keys(args).sort(), ['file', 'offset', 'pdfSha256']);
    assert.deepEqual(args.file, {file_id: file.fileId, download_url: args.file.download_url, file_name: file.fileName});
    assert.equal(args.pdfSha256, SHA);
    assert(options.signal instanceof AbortSignal, 'the bridge gets the abort signal');
    assert(options.timeout > 0 && options.timeout <= O.ORIGINAL_CALL_MS);
  }
  assert.equal(O.ORIGINAL_TOOL, 'read_attachment_original');
});

test('no _meta is a missing capability: never a structuredContent fallback', async () => {
  const b = bridge({tweak: r => ({structuredContent: {...r.structuredContent, chunk: r.meta[O.ORIGINAL_META]}})});
  await assert.rejects(run(b), /_meta/);
  assert.equal(b.calls.length, 1, 'no further chunk');
  const empty = bridge({tweak: r => ({...r, meta: {}})});
  await assert.rejects(run(empty), /_meta/);
});

test('an inconsistent chunk aborts the load and asks for nothing more', async () => {
  const cases = {
    total: (r, a, n) => n === 2 ? {...r, structuredContent: {...r.structuredContent, total: BYTES.length + 1}} : r,
    offset: r => ({...r, structuredContent: {...r.structuredContent, offset: r.structuredContent.offset + 1}}),
    sha: r => ({...r, structuredContent: {...r.structuredContent, pdfSha256: 'f'.repeat(64)}}),
    fileId: r => ({...r, structuredContent: {...r.structuredContent, fileId: 'file-OTHER'}}),
    done: r => ({...r, structuredContent: {...r.structuredContent, done: true}}),
    length: r => ({...r, structuredContent: {...r.structuredContent, length: r.structuredContent.length - 1}}),
    tiny: r => ({structuredContent: {...r.structuredContent, length: 1, done: false}, meta: {[O.ORIGINAL_META]: Buffer.alloc(1).toString('base64')}}),
    short: (r, a, n) => n === 2 ? {structuredContent: {...r.structuredContent, length: 100, done: false}, meta: {[O.ORIGINAL_META]: Buffer.alloc(100).toString('base64')}} : r,
    tooLarge: r => ({...r, structuredContent: {...r.structuredContent, total: 20 * 1024 * 1024 + 1}}),
    shape: r => ({...r, structuredContent: {...r.structuredContent, offset: '0'}}),
  };
  for (const [name, tweak] of Object.entries(cases)) {
    const b = bridge({tweak});
    await assert.rejects(run(b), /맞지 않아요/, name);
    assert(b.calls.length <= 2, `${name}: stopped at the bad chunk`);
  }
});

test('cancel while the call runs: the signal reaches the bridge and no chunk follows', async () => {
  const controller = new AbortController();
  let seen;
  // Like ext-apps callServerTool: an aborted request rejects at once (and the host is told).
  const b = bridge({call: (args, options) => { seen = options.signal;
    const p = new Promise((_, reject) => options.signal.addEventListener('abort', () => reject(new Error('AbortError')), {once: true}));
    controller.abort(); return p; }});
  await assert.rejects(run(b, controller.signal), e => e instanceof O.OriginalStopped && e.name === 'AbortError');
  assert.equal(seen.aborted, true);
  // The cancelled call settled, so the next document's load does not wait for it.
  const started = Date.now();
  await run(bridge(), undefined, undefined, {callMs: 5000});
  assert(Date.now() - started < 1000);
});

test('cancel while the file URL is fetched: no tool call at all', async () => {
  const controller = new AbortController();
  const b = bridge();
  let called = 0;
  b.fileUrl = () => { controller.abort(); return new Promise(r => setTimeout(() => r(SIGNED), 5)); };
  const call = b.call; b.call = (...x) => { called++; return call(...x); };
  await assert.rejects(run(b, controller.signal), O.OriginalStopped);
  await new Promise(r => setTimeout(r, 10));
  assert.equal(called, 0);
  const already = new AbortController(); already.abort();
  await assert.rejects(run(bridge(), already.signal), O.OriginalStopped);
});

test('a call that never answers times out; the next load waits for it, within one call', async () => {
  let release;
  const hung = bridge({call: () => new Promise(r => { release = r; })});
  await assert.rejects(run(hung, undefined, undefined, {callMs: 20}), /오래/);
  // The abandoned call is still pending: a new load waits for it (bounded), then goes ahead.
  const next = bridge();
  const started = Date.now();
  const bytes = await run(next, undefined, undefined, {callMs: 30});
  assert(Date.now() - started >= 25, 'waited for the earlier call');
  assert(Buffer.from(bytes).equals(BYTES));
  release?.({});
  // Once it settles, nothing waits.
  const quick = Date.now();
  await run(bridge(), undefined, undefined, {callMs: 1000});
  assert(Date.now() - quick < 500);
});

test('a whole-load deadline and a call cap bound every load', async () => {
  const slow = bridge();
  const call = slow.call;
  slow.call = (...x) => new Promise(r => setTimeout(() => r(call(...x)), 15));
  await assert.rejects(run(slow, undefined, undefined, {loadMs: 25}), /오래/);
  assert(slow.calls.length < 3, 'stopped before the last chunk');
  const capped = bridge();
  await assert.rejects(run(capped, undefined, undefined, {maxCalls: 2}), /맞지 않아요/);
  assert.equal(capped.calls.length, 2);
  assert.equal(O.ORIGINAL_MAX_CALLS, 40, '20 MiB in 512 KiB chunks');
  assert.equal(O.ORIGINAL_MIN_CHUNK, 512 * 1024);
});

test('base64Into is bounded by the target', () => {
  const target = new Uint8Array(4);
  assert.equal(O.base64Into(target, 1, Buffer.from([1, 2, 3]).toString('base64')), 3);
  assert.deepEqual([...target], [0, 1, 2, 3]);
  assert.throws(() => O.base64Into(target, 2, Buffer.from([1, 2, 3]).toString('base64')));
  assert.throws(() => O.base64Into(target, -1, ''));
});
