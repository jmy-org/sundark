/**
 * Browser client for the owner's local Sundark core, run as the opt-in Site companion:
 * `python -m app.mcp_server --http --site-origin <this Site's origin>` on the owner's machine.
 *
 * The core does the work (layout model, prompts, the AI Backend the owner chose locally,
 * including Sign in with ChatGPT); this module only moves the Site's PDF there and reads the
 * results back. It talks to 127.0.0.1 only, on a port the owner gives, with the pairing token
 * the companion printed. The token lives in this object's private field and nowhere else: it
 * is never written to storage, a cookie, a URL or the Site's server, and close() forgets it.
 * Results are returned to the caller; this module saves nothing.
 */

export const LOCAL_CORE_HOST = '127.0.0.1';
export const DEFAULT_LOCAL_CORE_PORT = 8744;
/** The companion's tools (app/mcp_server.py SITE_TOOLS); nothing else is ever called. */
export const LOCAL_CORE_TOOLS = [
  'begin_upload',
  'upload_chunk',
  'finish_upload',
  'cancel_upload',
  'layout_status',
  'page_layout',
  'summarize',
  'anatomy',
  'translate_page',
] as const;
export type LocalCoreTool = (typeof LOCAL_CORE_TOOLS)[number];

/** The Site's language codes as the core names them (app/settings.py OUTPUT_LANGUAGES). */
const CORE_LANGUAGES: Record<string, string> = {
  ko: 'Korean',
  en: 'English',
  ja: 'Japanese',
  zh: 'Chinese',
  es: 'Spanish',
  fr: 'French',
  de: 'German',
};
/** The core's name for a Site language; undefined leaves the owner's local setting. */
export function coreLanguage(code: string): string | undefined {
  return Object.hasOwn(CORE_LANGUAGES, code) ? CORE_LANGUAGES[code] : undefined;
}

const PROTOCOL_VERSION = '2025-11-25';
/** The core accepts at most 1 MiB of decoded bytes per chunk and 20 MiB per PDF. */
export const UPLOAD_CHUNK = 1024 * 1024;
export const UPLOAD_MAX = 20 * 1024 * 1024;
/** A reply larger than this is refused rather than parsed. */
export const RESPONSE_MAX = 16 * 1024 * 1024;
const DOC_ID = /^[0-9a-f]{16}$/;
const TOKEN = /^[A-Za-z0-9_-]{16,512}$/;

export type LocalCoreErrorKind =
  | 'invalid'
  | 'unreachable'
  | 'unauthorized'
  | 'refused'
  | 'protocol'
  | 'tool'
  | 'closed';

export class LocalCoreError extends Error {
  readonly kind: LocalCoreErrorKind;
  readonly status: number | null;
  readonly rateLimited: boolean;
  constructor(kind: LocalCoreErrorKind, message: string, status: number | null = null, rateLimited = false) {
    super(message);
    this.name = 'LocalCoreError';
    this.kind = kind;
    this.status = status;
    this.rateLimited = rateLimited;
  }
}

/** The companion's endpoint for a port: always loopback, never a URL the caller supplies. */
export function localCoreEndpoint(port: unknown): string {
  if (typeof port !== 'number' || !Number.isInteger(port) || port < 1024 || port > 65535) {
    throw new LocalCoreError('invalid', '포트는 1024–65535 사이의 정수여야 합니다.');
  }
  return `http://${LOCAL_CORE_HOST}:${port}/mcp`;
}

export function checkPairingToken(token: unknown): string {
  if (typeof token !== 'string' || !TOKEN.test(token)) {
    throw new LocalCoreError('invalid', '로컬 Sundark가 출력한 연결 토큰을 그대로 붙여 넣어 주세요.');
  }
  return token;
}

function checkDocId(docId: unknown): string {
  if (typeof docId !== 'string' || !DOC_ID.test(docId)) throw new LocalCoreError('invalid', '잘못된 문서 ID입니다.');
  return docId;
}

function checkPage(page: unknown): number {
  if (typeof page !== 'number' || !Number.isInteger(page) || page < 0) throw new LocalCoreError('invalid', '잘못된 페이지입니다.');
  return page;
}

/** The core's File Fingerprint: the first 16 hex digits of the PDF's SHA-256 (app/store.py). */
export async function fileFingerprint(bytes: Uint8Array): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes as BufferSource));
  return Array.from(digest.slice(0, 8), (b) => b.toString(16).padStart(2, '0')).join('');
}

function base64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

type RpcMessage = { jsonrpc?: string; id?: number | string | null; result?: unknown; error?: { code?: number; message?: string } };

/** One JSON-RPC reply, sent either as JSON or as server-sent events. */
export function parseRpcReply(body: string, contentType: string, id: number): RpcMessage {
  const messages: unknown[] = [];
  if (contentType.includes('text/event-stream')) {
    for (const event of body.split(/\r?\n\r?\n/)) {
      const data = event
        .split(/\r?\n/)
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).replace(/^ /, ''))
        .join('\n');
      if (!data) continue;
      try {
        messages.push(JSON.parse(data));
      } catch {
        throw new LocalCoreError('protocol', '로컬 Sundark의 응답을 읽지 못했습니다.');
      }
    }
  } else {
    try {
      const parsed = JSON.parse(body);
      messages.push(...(Array.isArray(parsed) ? parsed : [parsed]));
    } catch {
      throw new LocalCoreError('protocol', '로컬 Sundark의 응답을 읽지 못했습니다.');
    }
  }
  const reply = messages.find((m): m is RpcMessage => !!m && typeof m === 'object' && (m as RpcMessage).id === id);
  if (!reply) throw new LocalCoreError('protocol', '로컬 Sundark의 응답이 요청과 맞지 않습니다.');
  return reply;
}

/** The reply body as text, read in chunks and cancelled once it passes RESPONSE_MAX bytes.
 * Content-Length only refuses early; a missing or wrong one cannot raise the limit. */
async function readBounded(response: Response): Promise<string> {
  const tooLarge = () => new LocalCoreError('protocol', '로컬 Sundark의 응답이 너무 큽니다.');
  if (Number(response.headers.get('content-length') || 0) > RESPONSE_MAX) {
    await response.body?.cancel().catch(() => undefined);
    throw tooLarge();
  }
  if (!response.body) return '';
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let size = 0;
  let text = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > RESPONSE_MAX) {
      await reader.cancel().catch(() => undefined);
      throw tooLarge();
    }
    text += decoder.decode(value, { stream: true });
  }
  return text + decoder.decode();
}

type ToolResult ={ isError?: boolean; structuredContent?: Record<string, unknown>; content?: { type: string; text?: string }[] };

export type LocalCoreOptions = { port?: number; token: string; fetch?: typeof fetch };

export class LocalCore {
  readonly endpoint: string;
  #token: string;
  #session: string | null = null;
  #fetch: typeof fetch;
  #nextId = 1;

  constructor(options: LocalCoreOptions) {
    this.endpoint = localCoreEndpoint(options.port ?? DEFAULT_LOCAL_CORE_PORT);
    this.#token = checkPairingToken(options.token);
    this.#fetch = options.fetch ?? globalThis.fetch.bind(globalThis);
  }

  get connected(): boolean {
    return this.#session !== null;
  }

  async #post(message: Record<string, unknown>): Promise<Response> {
    if (!this.#token) throw new LocalCoreError('closed', '로컬 Sundark 연결이 종료되었습니다.');
    const headers: Record<string, string> = {
      Accept: 'application/json, text/event-stream',
      'Content-Type': 'application/json',
      Authorization: `Bearer ${this.#token}`,
    };
    if (this.#session) {
      headers['Mcp-Session-Id'] = this.#session;
      headers['Mcp-Protocol-Version'] = PROTOCOL_VERSION;
    }
    let response: Response;
    try {
      response = await this.#fetch(this.endpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify({ jsonrpc: '2.0', ...message }),
        mode: 'cors',
        credentials: 'omit',
        cache: 'no-store',
        referrerPolicy: 'no-referrer',
        redirect: 'error',
      });
    } catch {
      throw new LocalCoreError(
        'unreachable',
        `로컬 Sundark(${this.endpoint})에 연결하지 못했습니다. 컴패니언이 실행 중인지, 브라우저가 로컬 네트워크 접근을 허용했는지 확인해 주세요.`,
      );
    }
    if (response.status === 401) throw new LocalCoreError('unauthorized', '연결 토큰이 맞지 않습니다.', 401);
    if (response.status === 403 || response.status === 421) {
      throw new LocalCoreError('refused', '로컬 Sundark가 이 사이트의 요청을 거부했습니다. --site-origin 값을 확인해 주세요.', response.status);
    }
    if (response.status === 404 && this.#session) {
      this.#session = null;
      throw new LocalCoreError('closed', '로컬 Sundark 세션이 만료되었습니다. 다시 연결해 주세요.', 404);
    }
    return response;
  }

  async #request(method: string, params: Record<string, unknown>): Promise<unknown> {
    const id = this.#nextId++;
    const response = await this.#post({ id, method, params });
    if (!response.ok) throw new LocalCoreError('protocol', `로컬 Sundark 오류 (${response.status})`, response.status);
    const body = await readBounded(response);
    const reply = parseRpcReply(body, response.headers.get('content-type') || '', id);
    if (method === 'initialize') this.#session = response.headers.get('mcp-session-id');
    if (reply.error) throw new LocalCoreError('protocol', reply.error.message || '로컬 Sundark 요청이 실패했습니다.');
    return reply.result;
  }

  async connect(): Promise<void> {
    if (this.#session) return;
    await this.#request('initialize', {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: 'sundark-site', version: '1' },
    });
    if (!this.#session) throw new LocalCoreError('protocol', '로컬 Sundark가 세션을 열지 않았습니다.');
    const response = await this.#post({ method: 'notifications/initialized' });
    if (!response.ok) throw new LocalCoreError('protocol', `로컬 Sundark 오류 (${response.status})`, response.status);
  }

  async call(name: LocalCoreTool, args: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (!(LOCAL_CORE_TOOLS as readonly string[]).includes(name)) {
      throw new LocalCoreError('invalid', `허용되지 않은 로컬 기능입니다: ${String(name)}`);
    }
    await this.connect();
    const result = (await this.#request('tools/call', { name, arguments: args })) as ToolResult | undefined;
    const data = result?.structuredContent;
    if (result?.isError) {
      const detail = typeof data?.detail === 'string' ? data.detail : result.content?.find((c) => c.type === 'text')?.text;
      throw new LocalCoreError(
        'tool',
        detail || '로컬 Sundark 작업이 실패했습니다.',
        typeof data?.status === 'number' ? data.status : null,
        data?.rate_limited === true,
      );
    }
    if (!data || typeof data !== 'object') throw new LocalCoreError('protocol', '로컬 Sundark의 결과 형식이 올바르지 않습니다.');
    return data;
  }

  /** Send the PDF in bounded chunks; returns the core's paper metadata (doc_id, num_pages, ...).
   * The doc_id must be the fingerprint of exactly these bytes. */
  async uploadPdf(
    bytes: Uint8Array,
    filename = 'paper.pdf',
    onProgress?: (sent: number, total: number) => void,
  ): Promise<Record<string, unknown> & { doc_id: string }> {
    if (!bytes.length || bytes.length > UPLOAD_MAX) throw new LocalCoreError('invalid', 'PDF는 1바이트 이상 20 MiB 이하여야 합니다.');
    const name = (filename.split(/[\\/]/).pop() || 'paper.pdf').slice(0, 200);
    const begun = await this.call('begin_upload', { filename: name.toLowerCase().endsWith('.pdf') ? name : `${name}.pdf`, size: bytes.length });
    const uploadId = String(begun.upload_id);
    try {
      for (let offset = 0; offset < bytes.length; offset += UPLOAD_CHUNK) {
        const chunk = bytes.subarray(offset, offset + UPLOAD_CHUNK);
        await this.call('upload_chunk', { upload_id: uploadId, offset, data_base64: base64(chunk) });
        onProgress?.(offset + chunk.length, bytes.length);
      }
    } catch (e) {
      await this.call('cancel_upload', { upload_id: uploadId }).catch(() => undefined);
      throw e;
    }
    const meta = await this.call('finish_upload', { upload_id: uploadId });
    const expected = await fileFingerprint(bytes);
    if (meta.doc_id !== expected) throw new LocalCoreError('protocol', '로컬 Sundark가 받은 PDF가 보낸 파일과 다릅니다.');
    return meta as Record<string, unknown> & { doc_id: string };
  }

  async layoutStatus(docId: string) {
    return this.call('layout_status', { doc_id: checkDocId(docId) });
  }

  async pageLayout(docId: string, page: number) {
    return this.call('page_layout', { doc_id: checkDocId(docId), page: checkPage(page) });
  }

  async summarize(docId: string, outputLanguage?: string) {
    return this.call('summarize', { doc_id: checkDocId(docId), ...(outputLanguage ? { output_language: outputLanguage } : {}) });
  }

  async anatomy(docId: string, outputLanguage?: string) {
    return this.call('anatomy', { doc_id: checkDocId(docId), ...(outputLanguage ? { output_language: outputLanguage } : {}) });
  }

  async translatePage(docId: string, page: number, targetLang?: string, segments?: string[]) {
    return this.call('translate_page', {
      doc_id: checkDocId(docId),
      page: checkPage(page),
      ...(targetLang ? { target_lang: targetLang } : {}),
      ...(segments ? { segments } : {}),
    });
  }

  /** End the session and forget the token; this object cannot be used again. */
  async close(): Promise<void> {
    const session = this.#session;
    const token = this.#token;
    this.#session = null;
    this.#token = '';
    if (!session || !token) return;
    try {
      await this.#fetch(this.endpoint, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}`, 'Mcp-Session-Id': session, 'Mcp-Protocol-Version': PROTOCOL_VERSION },
        mode: 'cors',
        credentials: 'omit',
        cache: 'no-store',
        referrerPolicy: 'no-referrer',
        redirect: 'error',
      });
    } catch {
      // The companion may already be gone; the session ends with it.
    }
  }
}
