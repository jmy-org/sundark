import { cp, mkdir, readdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const assets = resolve(root, 'public/vendor');
await mkdir(`${assets}/pdf`, { recursive: true });
await mkdir(`${assets}/ocr/core`, { recursive: true });
await cp(`${root}/node_modules/pdfjs-dist/build/pdf.worker.min.mjs`, `${assets}/pdf/pdf.worker.min.mjs`);
for (const dir of ['cmaps', 'standard_fonts', 'wasm']) {
  await cp(`${root}/node_modules/pdfjs-dist/${dir}`, `${assets}/pdf/${dir}`, { recursive: true });
}
for (const file of ['worker.min.js', 'tesseract.min.js']) {
  await cp(`${root}/node_modules/tesseract.js/dist/${file}`, `${assets}/ocr/${file}`);
}
for (const file of await readdir(`${root}/node_modules/tesseract.js-core`)) {
  if (/\.wasm(?:\.js)?$/.test(file)) await cp(`${root}/node_modules/tesseract.js-core/${file}`, `${assets}/ocr/core/${file}`);
}
await cp(`${root}/node_modules/@tesseract.js-data/eng/4.0.0/eng.traineddata.gz`, `${assets}/ocr/eng.traineddata.gz`);
// An owned outer worker makes cancellation possible even while createWorker is
// loading the model. Terminating it also terminates its nested OCR worker.
await writeFile(`${assets}/ocr/host.js`, `
importScripts('/vendor/ocr/tesseract.min.js');
let busy = false;
self.onmessage = async ({ data }) => {
  if (busy) return;
  busy = true;
  let worker;
  try {
    const base = self.location.origin + '/vendor/ocr';
    worker = await Tesseract.createWorker('eng', 1, {
      workerPath: base + '/worker.min.js',
      corePath: base + '/core',
      langPath: base,
      workerBlobURL: false,
      cacheMethod: 'none',
      logger: (m) => self.postMessage({ type: 'progress', status: m.status, progress: m.progress }),
    });
    const image = new Uint8Array(await data.image.arrayBuffer());
    const result = await worker.recognize(image, {}, { text: true, blocks: true });
    // Return only plain geometry/text, not the cyclic hierarchy or raster.
    const lines = (result.data.blocks || []).flatMap((b, bi) => b.paragraphs.flatMap((p, pi) => p.lines.map((l, li) => ({
      text: l.text, confidence: l.confidence, bbox: l.bbox, block: bi, paragraph: pi, line: li,
      words: l.words.map(w => ({ text: w.text, confidence: w.confidence, bbox: w.bbox }))
    }))));
    self.postMessage({ type: 'result', confidence: result.data.confidence, lines });
  } catch (error) {
    self.postMessage({ type: 'error', message: error instanceof Error ? error.message : String(error) });
  } finally {
    if (worker) await worker.terminate();
    self.close();
  }
};
`);
console.log('Prepared local PDF.js worker/fonts and Tesseract English OCR worker/core/model.');
// Original Sundark reader dependencies are vendored, never fetched from a CDN.
await cp(`${root}/node_modules/pdfjs-dist/build/pdf.mjs`, `${assets}/pdf/pdf.mjs`);
for (const dir of ['marked','katex','dompurify','sundark']) await mkdir(`${assets}/${dir}`,{recursive:true});
await cp(`${root}/node_modules/marked/lib/marked.umd.js`,`${assets}/marked/marked.umd.js`);
await cp(`${root}/node_modules/dompurify/dist/purify.min.js`,`${assets}/dompurify/purify.min.js`);
for (const file of ['katex.min.css','katex.min.js']) await cp(`${root}/node_modules/katex/dist/${file}`,`${assets}/katex/${file}`);
for (const file of ['auto-render.min.js','copy-tex.min.js']) await cp(`${root}/node_modules/katex/dist/contrib/${file}`,`${assets}/katex/${file}`);
await cp(`${root}/node_modules/katex/dist/fonts`,`${assets}/katex/fonts`,{recursive:true});
for (const name of ['marked','katex','dompurify']) {try{await cp(`${root}/node_modules/${name}/LICENSE`,`${assets}/${name}/LICENSE`)}catch{}}
const {build}=await import('esbuild');
await build({entryPoints:[`${root}/lib/pdf-engine.ts`],outfile:`${assets}/sundark/pdf-engine.js`,bundle:true,format:'esm',platform:'browser',target:'es2022',alias:{'pdfjs-dist':'/vendor/pdf/pdf.mjs'},external:['/vendor/pdf/pdf.mjs'],minify:true});
