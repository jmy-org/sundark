import type { PDFDocumentProxy } from 'pdfjs-dist';
export type { PDFDocumentProxy } from 'pdfjs-dist';
import { buildSentenceSegments, normalizedBox as normalized, pdfTextAtoms, type SourceAtom, type SourceSegment } from './source-geometry';
export type { BBox } from './source-geometry';
export type Segment = SourceSegment;
export interface PageExtraction { width: number; height: number; segments: Segment[]; method: 'text' | 'ocr'; confidence: number }
const MAX_PIXELS = 2_000_000;
let pdfModule: Promise<typeof import('pdfjs-dist')> | undefined;
function browserPdf() {
  if (typeof window === 'undefined') throw new Error('PDF reading is available only in the browser.');
  return pdfModule ??= import('pdfjs-dist').then(pdf => {
    pdf.GlobalWorkerOptions.workerSrc = '/vendor/pdf/pdf.worker.min.mjs';
    return pdf;
  });
}
export async function openPdf(url: string): Promise<PDFDocumentProxy> {
  const target = new URL(url, window.location.href);
  if (target.origin !== window.location.origin) throw new Error('PDFs must use a protected same-origin URL.');
  const pdf = await browserPdf();
  // Do not intercept password exceptions: the reader must show the actual error.
  // PDF.js 6 removed the former isEvalSupported option and eval-based compiler.
  // We never instantiate PDFScriptingManager or execute document actions.
  const task = pdf.getDocument({ url: target.href, withCredentials: true,
    cMapUrl: '/vendor/pdf/cmaps/', cMapPacked: true,
    standardFontDataUrl: '/vendor/pdf/standard_fonts/', wasmUrl: '/vendor/pdf/wasm/',
    enableXfa: false,
  });
  try { return await task.promise; }
  catch (error) { await task.destroy(); throw error; }
}
export async function renderPage(doc: PDFDocumentProxy, number: number, canvas: HTMLCanvasElement, zoom = 1, signal?: AbortSignal) {
  const page = await doc.getPage(number);
  if (signal?.aborted) throw new DOMException('Rendering cancelled.', 'AbortError');
  const original = page.getViewport({ scale: 1 });
  if (!(original.width > 0 && original.height > 0)) throw new Error('Invalid PDF page dimensions.');
  const scale = Math.min(Math.max(0.1, Number.isFinite(zoom) ? zoom : 1), Math.sqrt(MAX_PIXELS / (original.width * original.height)), 4096 / Math.max(original.width, original.height));
  const viewport = page.getViewport({ scale });
  canvas.width = Math.max(1, Math.floor(viewport.width));
  canvas.height = Math.max(1, Math.floor(viewport.height));
  const task = page.render({ canvas, viewport, background: '#ffffff', annotationMode: 0 });
  const cancel = () => task.cancel();
  signal?.addEventListener('abort', cancel, { once: true });
  try { await task.promise; }
  finally { signal?.removeEventListener('abort', cancel); }
  return { width: canvas.width, height: canvas.height };
}
export async function extractPage(doc: PDFDocumentProxy, number: number): Promise<PageExtraction> {
  const [pdf, page] = await Promise.all([browserPdf(), doc.getPage(number)]);
  const viewport = page.getViewport({ scale: 1 });
  const content = await page.getTextContent();
  const atoms = pdfTextAtoms(content, viewport, pdf.Util.transform, number);
  const segments = buildSentenceSegments(atoms, number, 'text');
  return { width: viewport.width, height: viewport.height, segments, method: 'text', confidence: 100 };
}
interface OcrBox { x0: number; y0: number; x1: number; y1: number }
interface OcrWord { text: string; confidence: number; bbox: OcrBox }
interface OcrLine extends OcrWord { words: OcrWord[]; block: number; paragraph: number; line: number }
export async function runOcr(doc: PDFDocumentProxy, number: number,
  progress: (progress: number, status?: string) => void = () => {}, signal?: AbortSignal): Promise<PageExtraction> {
  if (signal?.aborted) throw new DOMException('OCR cancelled.', 'AbortError');
  const canvas = document.createElement('canvas');
  let worker: Worker | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let abort: (() => void) | undefined;
  let stopped = false;
  const rendering = new AbortController();
  const interruption = new Promise<never>((_, reject) => {
    const stop = (error: Error) => { stopped = true; rendering.abort(); worker?.terminate(); reject(error); };
    abort = () => stop(new DOMException('OCR cancelled.', 'AbortError'));
    signal?.addEventListener('abort', abort, { once: true });
    timer = setTimeout(() => stop(new Error('OCR exceeded the 120-second page limit.')), 120_000);
  });
  const work = async (): Promise<PageExtraction> => {
    progress(0, 'Rendering page');
    const size = await renderPage(doc, number, canvas, 2, rendering.signal);
    if (stopped) throw new DOMException('OCR cancelled.', 'AbortError');
    const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob(value => value ? resolve(value) : reject(new Error('Could not rasterize page for OCR.')), 'image/png'));
    if (stopped) throw new DOMException('OCR cancelled.', 'AbortError');
    worker = new Worker('/vendor/ocr/host.js');
    return new Promise<PageExtraction>((resolve, reject) => {
      worker!.onerror = event => reject(new Error(event.message || 'OCR worker failed to load.'));
      worker!.onmessage = ({ data }) => {
        try {
        if (data.type === 'progress') progress(Number.isFinite(data.progress) ? data.progress : 0, data.status);
        else if (data.type === 'error') reject(new Error(data.message));
        else if (data.type === 'result') {
          const box = (b: OcrBox) => normalized(b.x0,b.y0,b.x1-b.x0,b.y1-b.y0,size.width,size.height);
          const atoms: SourceAtom[] = [];
          for (const line of data.lines as OcrLine[]) {
            for (const word of line.words) atoms.push({
              id: `p${number}-ow${atoms.length}`, text: word.text, bbox: box(word.bbox),
              para: `p${number}-ocr${line.block}-${line.paragraph}`,
            });
          }
          const segments = buildSentenceSegments(atoms, number, 'ocr');
          progress(1, 'Complete');
          resolve({ ...size, segments, method: 'ocr', confidence: data.confidence });
        }
        } catch (error) { reject(error); }
      };
      worker!.postMessage({ image: blob });
    });
  };
  try { return await Promise.race([work(), interruption]); }
  finally {
    stopped = true;
    rendering.abort();
    if (timer) clearTimeout(timer);
    if (abort) signal?.removeEventListener('abort', abort);
    worker?.terminate();
    canvas.width = canvas.height = 0;
  }
}
