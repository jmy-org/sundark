/** Host bridge. MCP Apps (the official App SDK) is primary; ChatGPT's window.openai is
 * used only for what it alone offers (fresh file URLs, widget state) or as a fallback.
 * Every capability is feature-detected; nothing is assumed to exist. */
import './zod-jitless';
import { App } from '@modelcontextprotocol/ext-apps';
import { OpenAIExtensions, OpenAIFileEntrypointInputSchema } from '@openai/mcp-extensions/app';

interface OpenAiGlobals {
  toolInput?: unknown; toolOutput?: unknown; widgetState?: unknown;
  setWidgetState?: (state: unknown) => unknown;
  getFileDownloadUrl?: (args: { fileId: string }) => Promise<{ downloadUrl?: string }>;
  sendFollowUpMessage?: (args: { prompt: string; scrollToBottom?: boolean }) => Promise<unknown>;
  callTool?: (name: string, args: Record<string, unknown>) => Promise<unknown>;
}
const openai = () => (globalThis as { openai?: OpenAiGlobals }).openai;

export interface FileEntry { name: string; resourceUri: string }
export interface HostEvents {
  output(data: unknown): void;
  fileEntry(file: FileEntry): void;
  input(args: unknown): void;
  teardown(): void;
}

export class Host {
  readonly app = new App({ name: 'sundark-attachment-reader', version: '1.0.0' }, {}, { autoResize: true });
  readonly ext = new OpenAIExtensions(this.app);
  connected = false;
  connectError = '';
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
    let closed = false, last = '', lastGlobal = '';
    const output = (data: unknown, key = JSON.stringify(data)) => {
      if (closed || key === last) return;
      last = key; events.output(data);
    };
    this.app.addEventListener('toolinput', ({ arguments: args }) => {
      if (closed) return;
      const file = OpenAIFileEntrypointInputSchema.safeParse(args);
      if (file.success) events.fileEntry(file.data.file);
      else events.input(args);
    });
    this.app.addEventListener('toolresult', result => {
      if (!result.isError && result.structuredContent) output(result.structuredContent);
    });
    this.app.onteardown = async () => { closed = true; events.teardown(); return {}; };
    const fromGlobals = (event?: Event) => {
      // A detail names only the globals that changed; without one, the dedupe above decides.
      const changed = (event as CustomEvent<{ globals?: Record<string, unknown> }> | undefined)?.detail?.globals;
      if (changed && !('toolOutput' in changed)) return;
      const o = openai()?.toolOutput;
      if (!o) return;
      const key = JSON.stringify(o);
      if (key === lastGlobal) return;
      lastGlobal = key; output(o, key);
    };
    globalThis.addEventListener?.('openai:set_globals', fromGlobals);
    fromGlobals();
    try { await this.app.connect(); this.connected = true; }
    catch (error) { this.connectError = error instanceof Error ? error.message : String(error); }
    finally { this.settle(); }
  }

  private caps() { return this.connected ? this.app.getHostCapabilities() : undefined; }
  get canReadFileResource() { return !!this.ext.resources; }
  get canFetchFileUrl() { return typeof openai()?.getFileDownloadUrl === 'function'; }
  get canMessage() { return !!this.caps()?.message || typeof openai()?.sendFollowUpMessage === 'function'; }
  get canCallTool() { return !!this.caps()?.serverTools || typeof openai()?.callTool === 'function'; }
  /** The original PDF arrives in-band: a fresh file URL for the server, and a tool call back. */
  get canLoadOriginal() { return this.canCallTool && this.canFetchFileUrl; }
  get canDownload() { return !!this.caps()?.downloadFile; }

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
    const result = await get({ fileId });
    if (!result || typeof result.downloadUrl !== 'string' || !/^https:\/\//.test(result.downloadUrl)) throw new Error('호스트가 쓸 수 있는 다운로드 링크를 주지 않았어요.');
    return result.downloadUrl;
  }

  async message(prompt: string) {
    if (this.caps()?.message) {
      const result = await this.app.sendMessage({ role: 'user', content: [{ type: 'text', text: prompt }] });
      if (result.isError) throw new Error('호스트가 메시지를 받지 않았어요.');
      return;
    }
    const send = openai()?.sendFollowUpMessage;
    if (typeof send !== 'function') throw new Error('이 호스트에서는 리더가 메시지를 보낼 수 없어요. 대화창에 직접 요청해 주세요.');
    await send({ prompt, scrollToBottom: true });
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
    if (this.caps()?.serverTools) {
      const result = await this.app.callServerTool({ name, arguments: args });
      if (result.isError) throw new Error(toolErrorText(result.content));
      return result.structuredContent;
    }
    const call = openai()?.callTool;
    if (typeof call !== 'function') throw new Error('이 호스트에서는 리더가 Sundark 도구를 실행할 수 없어요.');
    const result = await call(name, args) as { structuredContent?: unknown; isError?: boolean; content?: unknown } | undefined;
    if (result?.isError) throw new Error(toolErrorText(result.content));
    return result?.structuredContent;
  }

  /** callTool with the full result envelope: _meta carries what only the view may see
   * (the original PDF's bytes); the model sees neither it nor any byte in structuredContent.
   * options cancel and bound the MCP Apps request; window.openai.callTool takes neither. */
  async callToolResult(name: string, args: Record<string, unknown>, options?: { signal?: AbortSignal; timeout?: number }): Promise<{ structuredContent?: unknown; meta?: Record<string, unknown> }> {
    const meta = (m: unknown) => m && typeof m === 'object' && !Array.isArray(m) ? m as Record<string, unknown> : undefined;
    if (this.caps()?.serverTools) {
      const result = await this.app.callServerTool({ name, arguments: args }, options);
      if (result.isError) throw new Error(toolErrorText(result.content));
      return { structuredContent: result.structuredContent, meta: meta(result._meta) };
    }
    const call = openai()?.callTool;
    if (typeof call !== 'function') throw new Error('이 호스트에서는 리더가 Sundark 도구를 실행할 수 없어요.');
    const result = await call(name, args) as { structuredContent?: unknown; isError?: boolean; content?: unknown; _meta?: unknown } | undefined;
    if (result?.isError) throw new Error(toolErrorText(result.content));
    return { structuredContent: result?.structuredContent, meta: meta(result?._meta) };
  }

  async download(name: string, mimeType: string, text: string) {
    if (!this.caps()?.downloadFile) throw new Error('이 호스트는 앱의 파일 내려받기를 지원하지 않아요.');
    const result = await this.app.downloadFile({ contents: [{ type: 'resource', resource: { uri: 'file:///' + encodeURIComponent(name), mimeType, text } }] });
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
