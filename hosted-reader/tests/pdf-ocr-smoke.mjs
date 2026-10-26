// Real local-model Node OCR smoke test. This does NOT assert browser integration.
import assert from 'node:assert/strict';
import { createCanvas } from '@napi-rs/canvas';
import { createWorker } from 'tesseract.js';
import { resolve } from 'node:path';
const canvas = createCanvas(1200, 360);
const ctx = canvas.getContext('2d');
ctx.fillStyle = 'white'; ctx.fillRect(0, 0, canvas.width, canvas.height);
ctx.fillStyle = 'black'; ctx.font = '52px sans-serif';
ctx.fillText('SUNDARK RESEARCH LIBRARY', 55, 110);
ctx.fillText('Optical character recognition 2026', 55, 215);
const worker = await createWorker('eng', 1, {
  langPath: resolve('public/vendor/ocr'), cacheMethod: 'none',
});
try {
  const { data } = await worker.recognize(canvas.toBuffer('image/png'), {}, { text: true, blocks: true });
  assert.match(data.text, /SUNDARK RESEARCH LIBRARY/);
  assert.match(data.text, /Optical character recognition 2026/);
  const lines = data.blocks.flatMap(b => b.paragraphs.flatMap(p => p.lines));
  assert.ok(lines.length >= 2);
  assert.ok(lines.every(l => l.bbox.x1 > l.bbox.x0 && l.bbox.y1 > l.bbox.y0));
  assert.ok(lines.some(l => l.words.length > 2));
  console.log(JSON.stringify({ test: 'real-node-tesseract-local-english-model', text: data.text.trim(), confidence: data.confidence, lines: lines.length, wordCount: lines.reduce((n,l) => n + l.words.length, 0), browserQA: false }, null, 2));
} finally { await worker.terminate(); }
