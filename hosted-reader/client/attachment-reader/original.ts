/** The original PDF, in-band: the browser fetches nothing. Each chunk call hands the server a
 * fresh host file URL (used once, never stored) and the pdfSha256 the server read; the server
 * returns bytes only for that exact file, in the result _meta. DOM-free, so tests run it under
 * plain Node. The digest proves the chunks are the bytes the translation came from, not where
 * those bytes came from. */
import { MAX_PDF } from '../../lib/pdf-file';

/** App-only: one chunk of the original PDF per call, its bytes in the result _meta only. */
export const ORIGINAL_TOOL = 'read_attachment_original';
export const ORIGINAL_META = 'sundark/originalChunk';
/** Per call: the server's own download is bounded to 20 s, plus the host bridge. */
export const ORIGINAL_CALL_MS = 45_000;
/** Whole load, across every chunk. */
export const ORIGINAL_LOAD_MS = 300_000;
/** The server sends 2 MiB; it may lower that to 512 KiB if a host limits result size. A smaller
 * chunk (other than the last) is refused, so a load never takes more than 40 calls. */
export const ORIGINAL_MIN_CHUNK = 512 * 1024;
export const ORIGINAL_MAX_CALLS = Math.ceil(MAX_PDF / ORIGINAL_MIN_CHUNK);

export interface OriginalFile { fileId: string; fileName: string; pdfSha256: string }
export interface OriginalBridge {
  fileUrl(fileId: string): Promise<string>;
  call(args: Record<string, unknown>, options: { signal: AbortSignal; timeout: number }): Promise<{ structuredContent?: unknown; meta?: Record<string, unknown> }>;
}
export interface OriginalLimits { callMs?: number; loadMs?: number; maxCalls?: number }
/** The load was cancelled (a newer document, teardown): not an error to show. */
export class OriginalStopped extends Error { name = 'AbortError'; }

interface Chunk { fileId: string; pdfSha256: string; offset: number; length: number; total: number; done: boolean }
function chunkInfo(raw: unknown): Chunk | null {
  const c = raw as Partial<Chunk> | null | undefined;
  if (!c || typeof c !== 'object' || typeof c.fileId !== 'string' || typeof c.pdfSha256 !== 'string' || typeof c.done !== 'boolean') return null;
  return [c.offset, c.length, c.total].every(Number.isInteger) ? c as Chunk : null;
}

/** Decodes one base64 chunk into target at offset. Bounded by target; the PDF check runs
 * once on the assembled bytes, since a later chunk has no PDF header. */
export function base64Into(target: Uint8Array, offset: number, base64: string) {
  const binary = atob(base64);
  if (offset < 0 || offset + binary.length > target.length) throw new Error('원문 PDF 조각이 파일 크기와 맞지 않아요.');
  for (let i = 0; i < binary.length; i++) target[offset + i] = binary.charCodeAt(i);
  return binary.length;
}

const slow = () => new Error('원문 PDF를 받는 데 시간이 너무 오래 걸렸어요.');
const broken = () => new Error('원문 PDF 조각이 서로 맞지 않아요. 원문 보기를 멈췄어요.');
/** Stops waiting on timeout or cancellation. The awaited work itself may go on (see inflight). */
function within<T>(work: Promise<T>, signal: AbortSignal, ms: number) {
  return new Promise<T>((resolve, reject) => {
    if (signal.aborted) { reject(new OriginalStopped('stopped')); return; }
    const timer = setTimeout(() => reject(slow()), ms);
    const stop = () => reject(new OriginalStopped('stopped'));
    signal.addEventListener('abort', stop, { once: true });
    work.then(resolve, reject).finally(() => { clearTimeout(timer); signal.removeEventListener('abort', stop); });
  });
}

/** The last chunk call, settled or not. Cancelling rejects an MCP Apps call at once and tells
 * the host (notifications/cancelled), but the server request may still run to its own 20 s,
 * 20 MiB bound; the view cannot see that. A call that does not settle (window.openai.callTool
 * takes no signal) holds up the next call for up to one call's time, so unsettled calls never
 * pile up beyond one. */
let inflight: Promise<unknown> = Promise.resolve();

/** Calls the tool chunk by chunk until done. Chunks must line up exactly; nothing after a
 * cancellation, a timeout or an inconsistent chunk is requested. */
export async function loadOriginalBytes(bridge: OriginalBridge, file: OriginalFile, signal: AbortSignal,
  progress: (calls: number, expected: number) => void = () => {}, limits: OriginalLimits = {}) {
  const { callMs = ORIGINAL_CALL_MS, loadMs = ORIGINAL_LOAD_MS, maxCalls = ORIGINAL_MAX_CALLS } = limits;
  const until = Date.now() + loadMs;
  const left = () => { const ms = Math.min(callMs, until - Date.now()); if (ms <= 0) throw slow(); return ms; };
  let bytes: Uint8Array | null = null, offset = 0, calls = 0, size = 0;
  for (;;) {
    if (calls >= maxCalls) throw broken();
    // A still-running earlier call delays this one, within one call's time; then it goes ahead.
    await within(inflight, signal, left()).catch(error => { if (error instanceof OriginalStopped) throw error; });
    const url = await within(bridge.fileUrl(file.fileId), signal, left());
    const call = bridge.call({ file: { file_id: file.fileId, download_url: url, file_name: file.fileName }, pdfSha256: file.pdfSha256, offset },
      { signal, timeout: left() });
    inflight = call.catch(() => {});
    const result = await within(call, signal, left());
    calls++;
    const data = result.meta?.[ORIGINAL_META];
    // Never read bytes from structuredContent: the model may inspect it.
    if (typeof data !== 'string') throw new Error('호스트가 원문 PDF 조각을 앱에 전달하지 않았어요(_meta 없음). 이 호스트에서는 원문 페이지를 볼 수 없어요.');
    const c = chunkInfo(result.structuredContent);
    if (!c || c.fileId !== file.fileId || c.pdfSha256 !== file.pdfSha256 || c.offset !== offset || c.total < 1 || c.total > MAX_PDF
      || (bytes && c.total !== bytes.length) || c.length < 1 || c.offset + c.length > c.total || c.done !== (c.offset + c.length === c.total)
      || (!c.done && (c.length < ORIGINAL_MIN_CHUNK || (size && c.length !== size)))) throw broken();
    bytes ??= new Uint8Array(c.total);
    if (base64Into(bytes, offset, data) !== c.length) throw broken();
    size ||= c.length;
    offset += c.length;
    if (c.done) return bytes;
    progress(calls, Math.ceil(c.total / size));
  }
}
