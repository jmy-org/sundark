// Test-only MCP Apps host page for the attachment reader, bundled by the browser test.
// It uses the official AppBridge, so the widget talks the real protocol. No real data.
import { AppBridge, PostMessageTransport } from '@modelcontextprotocol/ext-apps/app-bridge';

const params = new URLSearchParams(location.search);
// nomessage / nodownload leave that capability unadvertised.
const capabilities = { ...(params.get('nomessage') ? {} : { message: { text: {} } }), serverTools: {}, ...(params.get('nodownload') ? {} : { downloadFile: {} }),
  ...(params.get('resources') ? { experimental: { 'openai/resource': {} } } : {}) };
const calls = { messages: [], tools: [], originals: [], downloads: [], resources: [], displayModes: [] };
// modes=inline,fullscreen puts availableDisplayModes in the host context (absent: the host lists
// none), and mode=<m> is the mode the view starts in.
let hostContext = params.get('modes') ? { displayMode: params.get('mode') || 'inline', availableDisplayModes: params.get('modes').split(',') } : {};
// resources: per-uri {delay, reply}, so a test can make one file read finish after another.
// toolHold: a promise the next tool reply waits on, so a test can land results while a read is out.
// message / download: undefined answers at once; 'hang' never answers; 'deny' refuses the way
// the MCP Apps spec says (-32000 for ui/message, isError for a download), with host text the view
// must not show; 'manual' waits until the test calls settle.message/settle.download.
// display: undefined grants the requested mode; 'refuse' keeps the current mode and returns it,
// as the spec says a host should; 'hang', 'deny' and 'manual' (settle.display) as above.
const replies = { tool: null, toolHold: null, resource: null, resources: {}, message: undefined, download: undefined, display: undefined };
const settle = { message: [], download: [], display: [] };
const answer = (mode, kind, refuse) => {
  if (mode === 'hang') return new Promise(() => {});
  if (mode === 'deny') return refuse();
  if (mode === 'manual') return new Promise(resolve => settle[kind].push(value => resolve(value ?? {})));
  return {};
};
const iframe = document.createElement('iframe');
// An opaque-origin sandbox like the real host's: the widget reaches nothing same-origin.
iframe.setAttribute('sandbox', 'allow-scripts');
iframe.title = 'Sundark reader';
iframe.style.cssText = 'width:1280px;height:900px;border:0';
const ready = new Promise(resolve => {
  const bridge = new AppBridge(null, { name: 'sundark-test-host', version: '1.0.0' }, capabilities, { hostContext });
  bridge.onrequestdisplaymode = async ({ mode }) => {
    calls.displayModes.push(mode);
    if (replies.display === 'refuse') return { mode: hostContext.displayMode || 'inline' };
    // Granted: the host's own state changes, but no context notification is sent, so only the
    // returned mode can tell the view.
    if (replies.display === undefined) { hostContext = { ...hostContext, displayMode: mode }; return { mode }; }
    return answer(replies.display, 'display', () => { throw Object.assign(new Error('Display mode denied https://example.invalid/secret'), { code: -32000 }); });
  };
  bridge.onmessage = async p => {
    calls.messages.push(p.content.map(c => c.text).join('\n'));
    return answer(replies.message, 'message', () => { throw Object.assign(new Error('Message sending denied https://example.invalid/secret'), { code: -32000 }); });
  };
  // read_attachment_original goes to the test's server side (window.serveOriginal, exposed by
  // Playwright), which answers with the full result envelope, _meta included.
  bridge.oncalltool = async p => {
    if (p.name === 'read_attachment_original') {
      calls.originals.push(p);
      return window.serveOriginal ? window.serveOriginal(p.arguments) : { content: [{ type: 'text', text: 'no original https://example.invalid/secret' }], isError: true };
    }
    calls.tools.push(p); if (replies.toolHold) await replies.toolHold; return replies.tool ? { content: [], structuredContent: replies.tool } : { content: [{ type: 'text', text: 'no reply https://example.invalid/secret' }], isError: true };
  };
  bridge.ondownloadfile = async p => { calls.downloads.push(p.contents[0]); return answer(replies.download, 'download', () => ({ isError: true })); };
  bridge.onreadresource = async p => {
    calls.resources.push(p);
    const r = replies.resources[p.uri];
    if (!r) return replies.resource;
    await new Promise(resolve => setTimeout(resolve, r.delay));
    return r.reply;
  };
  bridge.oninitialized = () => resolve(bridge);
  // Listen before the view loads, as a real host does, so its ui/initialize is not missed.
  document.body.appendChild(iframe);
  const transport = new PostMessageTransport(iframe.contentWindow, iframe.contentWindow);
  // initdelay holds back only the answer to the view's ui/initialize, so its connect() settles late.
  const initDelay = Number(params.get('initdelay')) || 0;
  if (initDelay) {
    const send = transport.send.bind(transport);
    transport.send = (m, o) => m?.result?.hostCapabilities ? new Promise(r => setTimeout(r, initDelay)).then(() => send(m, o)) : send(m, o);
  }
  bridge.connect(transport).then(() => { iframe.src = '/widget.html' + location.search; });
});
window.testHost = {
  calls, replies,
  settle: (kind, value) => settle[kind].shift()?.(value),
  appCapabilities: async () => (await ready).getAppCapabilities(),
  // A host-side change (the user left fullscreen through host chrome, or the host stopped
  // offering a mode): the bridge sends only the changed fields.
  context: async change => { hostContext = { ...hostContext, ...change }; (await ready).setHostContext(hostContext); },
  ready: () => ready.then(() => true),
  result: async structuredContent => (await ready).sendToolResult({ content: [], structuredContent }),
  input: async args => (await ready).sendToolInput({ arguments: args }),
  teardown: async () => (await ready).teardownResource({}),
};
