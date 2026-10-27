/** In-widget PDF.js. The widget has no same-origin /vendor path, so the worker is
 * bundled and run on the main thread (PDF.js's "fake worker"), with no CDN or blob URL. */
import * as pdfjs from 'pdfjs-dist';
import * as worker from 'pdfjs-dist/build/pdf.worker.mjs';
import { renderPage } from '../../lib/pdf-engine';
import { buildSentenceSegments, pdfTextAtoms } from '../../lib/source-geometry';
import type { PageSource } from './state';

(globalThis as { pdfjsWorker?: unknown }).pdfjsWorker = worker;

export type PdfDoc = pdfjs.PDFDocumentProxy;
export const MAX_PDF_BYTES = 20 * 1024 * 1024;

export async function sha256Hex(bytes: Uint8Array) {
  const digest = await crypto.subtle.digest('SHA-256', bytes as BufferSource);
  return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('');
}

export function isPdf(bytes: Uint8Array) {
  return bytes.length > 4 && String.fromCharCode(...bytes.subarray(0, Math.min(1024, bytes.length))).includes('%PDF-');
}

export function checked(bytes: Uint8Array) {
  if (bytes.length > MAX_PDF_BYTES) throw new Error('PDF가 20MB보다 커요.');
  if (!isPdf(bytes)) throw new Error('받은 파일이 PDF가 아니에요.');
  return bytes;
}

export function base64Bytes(base64: string) {
  const binary = atob(base64);
  if (binary.length > MAX_PDF_BYTES) throw new Error('PDF가 20MB보다 커요.');
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return checked(bytes);
}

export async function openPdfBytes(bytes: Uint8Array): Promise<PdfDoc> {
  // PDF.js transfers (detaches) the buffer it is given, so hand it a copy.
  // No cmap/font/wasm URLs: nothing outside this document may be fetched. Embedded fonts
  // render exactly; a non-embedded standard font falls back to a system font. WebAssembly
  // is off because host CSPs refuse to compile it; PDF.js then uses its JS paths, and an
  // image format that only has a wasm decoder (JPEG 2000) is left blank, not faked.
  const task = pdfjs.getDocument({ data: bytes.slice(), enableXfa: false, useSystemFonts: true, useWasm: false });
  try { return await task.promise; }
  catch (error) { await task.destroy(); throw error; }
}

export interface Rendered { width: number; height: number; cssWidth: number; cssHeight: number; textLayer?: pdfjs.TextLayer }

/** Renders one page at the given CSS width (bounded pixels via the shared renderer) and
 * builds its selectable text layer. */
export async function drawPage(doc: PdfDoc, number: number, canvas: HTMLCanvasElement, textLayer: HTMLElement, cssWidth: number, signal?: AbortSignal): Promise<Rendered> {
  const page = await doc.getPage(number);
  const base = page.getViewport({ scale: 1 });
  const cssScale = cssWidth / base.width;
  const ratio = Math.min(globalThis.devicePixelRatio || 1, 3);
  const size = await renderPage(doc, number, canvas, cssScale * ratio, signal);
  // A newer draw owns the shared text container now: leave it alone.
  if (signal?.aborted) throw new DOMException('Rendering cancelled.', 'AbortError');
  const cssHeight = base.height * cssScale;
  canvas.style.width = cssWidth + 'px';
  canvas.style.height = cssHeight + 'px';
  textLayer.replaceChildren();
  textLayer.style.setProperty('--total-scale-factor', String(cssScale));
  textLayer.style.setProperty('--scale-round-x', '1px');
  textLayer.style.setProperty('--scale-round-y', '1px');
  const layer = new pdfjs.TextLayer({ textContentSource: page.streamTextContent(), container: textLayer, viewport: page.getViewport({ scale: cssScale }) });
  // TextLayer appends spans as its text stream arrives; cancel() stops the stream, so an
  // obsolete page adds nothing after a newer draw cleared the container.
  const cancel = () => layer.cancel();
  signal?.addEventListener('abort', cancel, { once: true });
  try { await layer.render(); }
  catch (error) { if (signal?.aborted) throw new DOMException('Rendering cancelled.', 'AbortError'); throw error; }
  finally { signal?.removeEventListener('abort', cancel); }
  return { ...size, cssWidth, cssHeight, textLayer: layer };
}

/** Client-side extraction with the same atom/sentence code the server uses, so segment
 * ids and geometry agree with server pages for the same file. */
export async function extractPage(doc: PdfDoc, number: number): Promise<PageSource> {
  const page = await doc.getPage(number);
  const viewport = page.getViewport({ scale: 1 });
  const content = await page.getTextContent();
  const atoms = pdfTextAtoms(content as unknown as Parameters<typeof pdfTextAtoms>[0], viewport, pdfjs.Util.transform, number);
  return { page: number, width: viewport.width, height: viewport.height, segments: buildSentenceSegments(atoms, number, 'text') };
}
