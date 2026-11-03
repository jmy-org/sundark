// The reader presentation shared with the local Sundark reader. client/shared/reader-ui.css is a
// generated copy of jmy-org/sundark web/reader-ui.css (scripts/sync_reader_ui.py there): one header
// line with the sha256 of the body below it. A hand edit breaks that hash, and every consumer
// (the attachment reader, the saved-paper view, /original) refuses the file instead of drifting.
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const sharedCssPath = resolve(fileURLToPath(new URL('..', import.meta.url)), 'client/shared/reader-ui.css');
const HEADER = /^\/\* Generated from jmy-org\/sundark web\/reader-ui\.css by scripts\/sync_reader_ui\.py\. sha256:([0-9a-f]{64})\. Do not edit\. \*\/\n/;

/** The verified body of a generated copy. Throws when the header is missing or its hash differs. */
export function sharedCssBody(copy) {
  const head = HEADER.exec(copy);
  if (!head) throw new Error('client/shared/reader-ui.css: generated header missing; run scripts/sync_reader_ui.py in sundark.');
  const body = copy.slice(head[0].length);
  if (createHash('sha256').update(body, 'utf8').digest('hex') !== head[1])
    throw new Error('client/shared/reader-ui.css: body does not match its sha256 header; it was edited by hand. Sync it from sundark.');
  // Inlined into <style> elements and a JS string: it must hold no closing tag or external reference.
  if (/<\/|@import|@font-face|url\(|https?:\/\//i.test(body)) throw new Error('client/shared/reader-ui.css: holds a closing tag or external reference.');
  return body;
}

export async function readSharedCss() { return sharedCssBody(await readFile(sharedCssPath, 'utf8')); }
