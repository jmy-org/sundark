// The presentation shared with the local reader: a generated copy whose header hash must match,
// inlined into the attachment reader and the saved-paper view with no external reference.
// Run after `node scripts/build-attachment-reader.mjs` (lib/generated/).
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { register } from 'node:module';
import { test } from 'node:test';
import { sharedCssBody, sharedCssPath } from '../scripts/shared-css.mjs';

register('./fixtures/worker-loader.mjs', import.meta.url);
const copy = readFileSync(sharedCssPath, 'utf8');

test('the copy matches its header hash, and one changed byte is refused', () => {
  const body = sharedCssBody(copy);
  assert.match(copy, new RegExp(`sha256:${createHash('sha256').update(body).digest('hex')}`));
  const at = copy.length - 2;
  assert.throws(() => sharedCssBody(copy.slice(0, at) + (copy[at] === 'a' ? 'b' : 'a') + copy.slice(at + 1)), /sha256/);
  assert.throws(() => sharedCssBody(body), /header missing/);
  const header = copy.slice(0, copy.indexOf('\n') + 1), bad = body + '\n.x{background:url(https://example.invalid/a.png)}\n';
  assert.throws(() => sharedCssBody(header.replace(/sha256:[0-9a-f]{64}/, `sha256:${createHash('sha256').update(bad).digest('hex')}`) + bad), /external/);
});

test('both widgets inline it; nothing is linked or fetched', async () => {
  const body = sharedCssBody(copy);
  const { attachmentReaderHtml } = await import('../lib/attachment-reader.ts');
  const { readerHtml } = await import('../lib/reader-resource.ts');
  for (const html of [attachmentReaderHtml, readerHtml]) {
    assert(html.includes(body), 'shared CSS inlined');
    // No stylesheet link, and no style that imports or fetches (pdf.js's own runtime code may name @font-face).
    assert(!/<link[^>]+href=/i.test(html));
    const styles = [...html.matchAll(/<style>([\s\S]*?)<\/style>/g)].map(m => m[1]).join('\n');
    assert(styles.includes(body));
    assert(!/@import|@font-face|url\(/i.test(styles));
  }
  // The shared rules come first; each widget's own layout follows and may override them.
  assert(attachmentReaderHtml.indexOf(body) < attachmentReaderHtml.indexOf('Attachment reader layout'));
});
