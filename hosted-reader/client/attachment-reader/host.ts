/** Host bridge. MCP Apps (the official App SDK) is primary; ChatGPT's window.openai is
 * used for what it alone offers (fresh file URLs, widget state), for messages when its own
 * follow-up helper is there, or as a fallback. Every capability is feature-detected;
 * nothing is assumed to exist. */
import './zod-jitless';
import { App, type McpUiDisplayMode } from '@modelcontextprotocol/ext-apps';
import { McpError } from '@modelcontextprotocol/sdk/types.js';
import { OpenAIExtensions, OpenAIFileEntrypointInputSchema } from '@openai/mcp-extensions/app';

interface OpenAiGlobals {
  theme?: unknown;
  toolInput?: unknown; toolOutput?: unknown; widgetState?: unknown;
  setWidgetState?: (state: unknown) => unknown;
  getFileDownloadUrl?: (args: { fileId: string }) => Promise<{ downloadUrl?: string }>;
  sendFollowUpMessage?: (args: { prompt: string; scrollToBottom?: boolean }) => Promise<unknown>;
  callTool?: (name: string, args: Record<string, unknown>) => Promise<unknown>;
}
const openai = () => (globalThis as { openai?: OpenAiGlobals }).openai;

/** How long a message or download request may stay unanswered on screen. */
const REQUEST_TIMEOUT_MS = 15_000;
/** Delivery is unknown: no answer in time, a lost connection, a failed send, or an answer that
 * cannot be read. The request may still have been delivered, so it is never sent again or
 * through another path; the user is asked to check instead. */
export class Unconfirmed extends Error { name = 'Unconfirmed'; }
const MESSAGE_UNCONFIRMED = '요청이 대화에 전달됐는지 확인하지 못했어요. 대화에 새 메시지가 보이는지 확인하고, 보이지 않을 때만 다시 요청해 주세요.';
const MESSAGE_NOT_SENT = '호스트가 이 요청을 대화에 보내지 않았어요. 대화창에 직접 요청해 주세요.';
const DOWNLOAD_UNCONFIRMED = '호스트가 내보내기 요청에 답하지 않았어요. 파일이 내려받아졌는지 확인하고, 없으면 “Markdown 복사”를 써 주세요.';
const DISPLAY_UNCONFIRMED = '호스트가 화면 전환 요청에 답하지 않았어요. 화면이 바뀌었는지 확인해 주세요.';
const DISPLAY_FAILED = '호스트가 화면 전환을 처리하지 못했어요.';
/** The display modes this view supports, declared to the host (MCP Apps requires it). ChatGPT
 * supports inline and fullscreen, not pip, so pip is never declared or requested. */
export const DISPLAY_MODES: readonly McpUiDisplayMode[] = ['inline', 'fullscreen'];
export type DisplayMode = McpUiDisplayMode;
/** MCP SDK error code for a request that ran past its timeout. */
const REQUEST_TIMEOUT_CODE = -32001;
const timedOut = (error: unknown) => (error as { code?: unknown })?.code === REQUEST_TIMEOUT_CODE;
/** True only when the host itself answered with an error: a definite refusal. The SDK closes a
 * lost connection with its own -32000 (the code a host also refuses ui/message with) after it
 * has dropped the transport, so a refusal is told apart by the transport still being there. */
const hostRefused = (app: App, error: unknown) =>
  error instanceof McpError && error.code !== REQUEST_TIMEOUT_CODE && app.transport !== undefined;

/** Settles with the promise, or rejects with Unconfirmed after ms. A late settle is ignored. */
function bounded<T>(promise: Promise<T>, ms: number, unconfirmed: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Unconfirmed(unconfirmed)), ms); });
  return Promise.race([promise, late]).finally(() => clearTimeout(timer));
}

export interface FileEntry { name: string; resourceUri: string }
export interface HostEvents {
  output(data: unknown): void;
  fileEntry(file: FileEntry): void;
  input(args: unknown): void;
  /** The host's display mode, or the modes it offers, changed. */
  display(): void;
  teardown(): void;
}

export class Host {
  readonly app = new App({ name: 'sundark-attachment-reader', version: '1.0.0' }, { availableDisplayModes: [...DISPLAY_MODES] }, { autoResize: true });
  readonly ext = new OpenAIExtensions(this.app);
  connected = false;
  connectError = '';
  /** Set by teardown: nothing the host answers afterwards reaches the view. */
  private closed = false;
  /** The mode the host last reported, by a request's answer or a context change, whichever
   * came last. The host decides; a request never paints the mode it asked for. */
  private mode: DisplayMode | undefined;
  private settle!: () => void;
  /** Settles once connect() has succeeded or failed (the SDK bounds its handshake):
   * host capabilities are unknown before it, not absent. */
  readonly ready = new Promise<void>(resolve => { this.settle = resolve; });

  /** Listeners go on before connect() so the initial tool input/result is not missed. */
  async start(events: HostEvents) {
    // openai:set_globals fires for every global change (widget state too) and repeats the
    // same toolOutput: only a toolOutput that differs from the last one seen there is new.
    // A result is delivered once, whichever bridge brought it, and nothing after teardown,
    // so a stale result never folds back into the reading.
    let last = '', lastGlobal = '';
    const output = (data: unknown, key = JSON.stringify(data)) => {
      if (this.closed || key === last) return;
      last = key; events.output(data);
    };
    this.app.addEventListener('toolinput', ({ arguments: args }) => {
      if (this.closed) return;
      const file = OpenAIFileEntrypointInputSchema.safeParse(args);
      if (file.success) events.fileEntry(file.data.file);
      else events.input(args);
    });
    this.app.addEventListener('toolresult', result => {
      if (!result.isError && result.structuredContent) output(result.structuredContent);
    });
    this.app.onteardown = async () => { this.closed = true; events.teardown(); return {}; };
    // The SDK merges the partial context into getHostContext() before listeners run.
    this.app.addEventListener('hostcontextchanged', change => {
      if (!this.closed && 'theme' in change) this.applyTheme();
      if (this.closed || !('displayMode' in change || 'availableDisplayModes' in change)) return;
      if (change.displayMode) this.mode = change.displayMode;
      events.display();
    });
    const fromGlobals = (event?: Event) => {
      // A detail names only the globals that changed; without one, the dedupe above decides.
      const changed = (event as CustomEvent<{ globals?: Record<string, unknown> }> | undefined)?.detail?.globals;
      if (!changed || 'theme' in changed) this.applyTheme();
      if (changed && !('toolOutput' in changed)) return;
      const o = openai()?.toolOutput;
      if (!o) return;
      const key = JSON.stringify(o);
      if (key === lastGlobal) return;
      lastGlobal = key; output(o, key);
    };
    globalThis.addEventListener?.('openai:set_globals', fromGlobals);
    fromGlobals();
    try { await this.app.connect(); this.connected = true; this.mode = this.app.getHostContext()?.displayMode; this.applyTheme(); }
    catch (error) { this.connectError = error instanceof Error ? error.message : String(error); }
    finally { this.settle(); }
  }

  /** The host's theme on the root (data-theme), which the shared presentation follows. A host
   * that names none leaves the system theme in charge (data-theme-auto in the template). */
  private applyTheme() {
    const theme = (this.connected ? this.app.getHostContext()?.theme : undefined) ?? openai()?.theme;
    const root = globalThis.document?.documentElement;
    if (!root) return;
    if (theme === 'light' || theme === 'dark') root.dataset.theme = theme;
    else delete root.dataset.theme;
  }

  private caps() { return this.connected ? this.app.getHostCapabilities() : undefined; }
  get canReadFileResource() { return !!this.ext.resources; }
  get canFetchFileUrl() { return typeof openai()?.getFileDownloadUrl === 'function'; }
  /** The one sender a message goes through: ChatGPT's own follow-up helper when it is there,
   * else the standard ui/message when the host advertises it. Feature-detected, never by brand. */
  private messageSender(): 'openai' | 'mcp' | undefined {
    if (typeof openai()?.sendFollowUpMessage === 'function') return 'openai';
    return this.caps()?.message ? 'mcp' : undefined;
  }
  get canMessage() { return !!this.messageSender(); }
  get canCallTool() { return !!this.caps()?.serverTools || typeof openai()?.callTool === 'function'; }
  /** The original PDF arrives in-band: a fresh file URL for the server, and a tool call back. */
  get canLoadOriginal() { return this.canCallTool && this.canFetchFileUrl; }
  get canDownload() { return !!this.caps()?.downloadFile; }

  /** The current mode as the host reported it; inline (the MCP Apps default) when it said nothing. */
  get displayMode(): DisplayMode { return this.mode ?? 'inline'; }
  /** The mode a toggle would request: only one this view declared and the host lists in its
   * context. Undefined when the host lists none, has no connection, or the view is closed. */
  get displayTarget(): DisplayMode | undefined {
    if (!this.connected || this.closed) return undefined;
    const target: DisplayMode = this.displayMode === 'fullscreen' ? 'inline' : 'fullscreen';
    const offered = this.app.getHostContext()?.availableDisplayModes ?? [];
    return offered.includes(target) && DISPLAY_MODES.includes(target) ? target : undefined;
  }
  /** One ui/request-display-mode, bounded and never retried. Resolves with the mode the host
   * returned, which may differ from the one asked for; undefined once the view has closed.
   * Only a definite refusal is a failure; anything else may still have switched the view. */
  async requestDisplayMode(mode: DisplayMode): Promise<DisplayMode | undefined> {
    if (this.displayTarget !== mode) throw new Error('이 호스트는 이 화면 모드를 지원하지 않아요.');
    let result;
    try { result = await this.app.requestDisplayMode({ mode }, { timeout: REQUEST_TIMEOUT_MS }); }
    catch (error) { if (this.closed) return undefined; throw hostRefused(this.app, error) ? new Error(DISPLAY_FAILED) : new Unconfirmed(DISPLAY_UNCONFIRMED); }
    if (this.closed) return undefined;
    this.mode = result.mode;
    return result.mode;
  }

  async readFileResource(uri: string): Promise<string> {
    const resources = this.ext.resources;
    if (!resources) throw new Error('이 호스트는 앱이 연 파일을 읽도록 허용하지 않아요.');
    const result = await resources.read({ uri, representation: 'blob' });
    const content = result.contents[0];
    if (!content || !('blob' in content) || typeof content.blob !== 'string') throw new Error('호스트가 파일 내용 없이 응답했어요.');
    return content.blob;
  }

  /** A fresh, short-lived URL for an authorized file id. Returned to the caller only;
   * never stored in widget state or sent to the model. */
  async fileUrl(fileId: string): Promise<string> {
    const get = openai()?.getFileDownloadUrl;
    if (typeof get !== 'function') throw new Error('이 호스트는 앱에 첨부 파일 다운로드 링크를 주지 않아서 원문 PDF를 여기서 보여줄 수 없어요.');
    let result;
    try { result = await get({ fileId }); }
    catch { throw new Error('호스트에서 첨부 파일의 다운로드 주소를 받지 못했어요.'); }
    if (!result || typeof result.downloadUrl !== 'string' || !/^https:\/\//.test(result.downloadUrl)) throw new Error('호스트가 쓸 수 있는 다운로드 링크를 주지 않았어요.');
    return result.downloadUrl;
  }

  /** One request through one sender, never retried or switched. Only a definite refusal says it
   * was not sent; anything else may still be delivered and is Unconfirmed. Errors carry fixed
   * text only, never the host's own text or the prompt. */
  async message(prompt: string) {
    const sender = this.messageSender();
    if (!sender) throw new Error('이 호스트에서는 리더가 메시지를 보낼 수 없어요. 대화창에 직접 요청해 주세요.');
    if (sender === 'openai') {
      const send = openai()!.sendFollowUpMessage!;
      // Called within the click, so the host sees the user's gesture.
      const sent = (async () => send({ prompt, scrollToBottom: true }))();
      // The helper has no refusal signal: a rejection may come after the host took the request.
      try { await bounded(sent, REQUEST_TIMEOUT_MS, MESSAGE_UNCONFIRMED); }
      catch { throw new Unconfirmed(MESSAGE_UNCONFIRMED); }
      return;
    }
    let result;
    try { result = await this.app.sendMessage({ role: 'user', content: [{ type: 'text', text: prompt }] }, { timeout: REQUEST_TIMEOUT_MS }); }
    catch (error) { throw hostRefused(this.app, error) ? new Error(MESSAGE_NOT_SENT) : new Unconfirmed(MESSAGE_UNCONFIRMED); }
    if (result.isError) throw new Error(MESSAGE_NOT_SENT);
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
    if (this.caps()?.serverTools) {
      let result;
      try { result = await this.app.callServerTool({ name, arguments: args }); }
      catch { throw new Error('호스트에서 Sundark 도구의 응답을 받지 못했어요.'); }
      if (result.isError) throw new Error(toolErrorText(result.content));
      return result.structuredContent;
    }
    const call = openai()?.callTool;
    if (typeof call !== 'function') throw new Error('이 호스트에서는 리더가 Sundark 도구를 실행할 수 없어요.');
    let result;
    try { result = await call(name, args) as { structuredContent?: unknown; isError?: boolean; content?: unknown } | undefined; }
    catch { throw new Error('호스트에서 Sundark 도구의 응답을 받지 못했어요.'); }
    if (result?.isError) throw new Error(toolErrorText(result.content));
    return result?.structuredContent;
  }

  /** callTool with the full result envelope: _meta carries what only the view may see
   * (the original PDF's bytes); the model sees neither it nor any byte in structuredContent.
   * options cancel and bound the MCP Apps request; window.openai.callTool takes neither. */
  async callToolResult(name: string, args: Record<string, unknown>, options?: { signal?: AbortSignal; timeout?: number }): Promise<{ structuredContent?: unknown; meta?: Record<string, unknown> }> {
    const meta = (m: unknown) => m && typeof m === 'object' && !Array.isArray(m) ? m as Record<string, unknown> : undefined;
    if (this.caps()?.serverTools) {
      let result;
      try { result = await this.app.callServerTool({ name, arguments: args }, options); }
      catch { throw new Error('호스트에서 Sundark 도구의 응답을 받지 못했어요.'); }
      if (result.isError) throw new Error(toolErrorText(result.content));
      return { structuredContent: result.structuredContent, meta: meta(result._meta) };
    }
    const call = openai()?.callTool;
    if (typeof call !== 'function') throw new Error('이 호스트에서는 리더가 Sundark 도구를 실행할 수 없어요.');
    let result;
    try { result = await call(name, args) as { structuredContent?: unknown; isError?: boolean; content?: unknown; _meta?: unknown } | undefined; }
    catch { throw new Error('호스트에서 Sundark 도구의 응답을 받지 못했어요.'); }
    if (result?.isError) throw new Error(toolErrorText(result.content));
    return { structuredContent: result?.structuredContent, meta: meta(result?._meta) };
  }

  async download(name: string, mimeType: string, text: string) {
    if (!this.caps()?.downloadFile) throw new Error('이 호스트는 앱의 파일 내려받기를 지원하지 않아요.');
    let result;
    try { result = await this.app.downloadFile({ contents: [{ type: 'resource', resource: { uri: 'file:///' + encodeURIComponent(name), mimeType, text } }] }, { timeout: REQUEST_TIMEOUT_MS }); }
    catch (error) { throw timedOut(error) ? new Unconfirmed(DOWNLOAD_UNCONFIRMED) : new Error('호스트가 내보내기를 처리하지 못했어요.'); }
    if (result.isError) throw new Error('내려받기가 취소되었거나 호스트가 거절했어요.');
  }

  get widgetState(): unknown { return openai()?.widgetState; }
  saveWidgetState(state: unknown) {
    const set = openai()?.setWidgetState;
    if (typeof set === 'function') { try { set(state); } catch { /* host refused; state is optional */ } }
  }
}

/** Tool errors are shown as text only and are cut short; they never carry URLs. */
export function toolErrorText(content: unknown) {
  const first = Array.isArray(content) ? content.find(c => c && typeof c === 'object' && (c as { type?: unknown }).type === 'text') as { text?: unknown } | undefined : undefined;
  const text = typeof first?.text === 'string' ? first.text : 'Sundark 도구 실행에 실패했어요.';
  return text.replace(/https?:\/\/\S+/g, '[link]').slice(0, 300);
}
