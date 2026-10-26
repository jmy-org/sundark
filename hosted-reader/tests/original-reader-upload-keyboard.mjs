// The upload control is the native file input inside the visible "PDF 추가" label. It must stay in
// the Tab order (a `hidden` or display:none input is skipped, so the label could not be reached
// from the keyboard), stay out of sight, and show the label's focus ring while it has keyboard
// focus. This checks markup and styles only; native Enter/Space activation needs a real browser.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
const read=p=>readFileSync(new URL(p,import.meta.url),'utf8');
const html=(await import(new URL('../lib/original-html.ts',import.meta.url))).originalHtml;
const css=read('../public/sundark-original/styles.css');
const label=html.match(/<label class="upload-btn">([\s\S]*?)<\/label>/);
assert(label,'upload label');
assert.match(label[1],/PDF 추가/,'visible label text');
const input=label[1].match(/<input id="file"[^>]*>/)?.[0];
assert(input,'file input inside the label');
assert.match(input,/type="file"/);
assert.match(input,/accept="application\/pdf"/);
assert.doesNotMatch(input,/\shidden[\s/>]/,'a hidden input is skipped by Tab');
assert.doesNotMatch(input,/tabindex|role=/,'native control, no tabindex or role');
const rule=css.match(/\.upload-btn input\s*\{([^}]*)\}/)?.[1];
assert(rule,'the file input is styled');
assert.doesNotMatch(rule,/display\s*:\s*none|visibility\s*:\s*hidden/,'display:none or visibility:hidden drops it from Tab');
assert.match(rule,/position\s*:\s*absolute/,'kept out of the layout');
assert.match(css,/\.upload-btn:has\(input:focus-visible\)\s*\{[^}]*outline\s*:\s*2px solid var\(--accent\)/,'visible keyboard focus on the label');
console.log('original reader upload keyboard: ok');
