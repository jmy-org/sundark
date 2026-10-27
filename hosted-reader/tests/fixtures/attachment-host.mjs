// Test-only MCP Apps host page for the attachment reader, bundled by the browser test.
// It uses the official AppBridge, so the widget talks the real protocol. No real data.
import { AppBridge, PostMessageTransport } from '@modelcontextprotocol/ext-apps/app-bridge';

const params = new URLSearchParams(location.search);
const capabilities = { message: { text: {} }, serverTools: {}, downloadFile: {}, ...(params.get('resources') ? { experimental: { 'openai/resource': {} } } : {}) };
const calls = { messages: [], tools: [], originals: [], downloads: [], resources: [] };
// resources: per-uri {delay, reply}, so a test can make one file read finish after another.
const replies = { tool: null, resource: null, resources: {} };
const iframe = document.createElement('iframe');
// An opaque-origin sandbox like the real host's: the widget reaches nothing same-origin.
iframe.setAttribute('sandbox', 'allow-scripts');
iframe.title = 'Sundark reader';
iframe.style.cssText = 'width:1280px;height:900px;border:0';
const ready = new Promise(resolve => {
  const bridge = new AppBridge(null, { name: 'sundark-test-host', version: '1.0.0' }, capabilities);
  bridge.onmessage = async p => { calls.messages.push(p.content.map(c => c.text).join('\n')); return {}; };
  // read_attachment_original goes to the test's server side (window.serveOriginal, exposed by
  // Playwright), which answers with the full result envelope, _meta included.
  bridge.oncalltool = async p => {
    if (p.name === 'read_attachment_original') {
      calls.originals.push(p);
      return window.serveOriginal ? window.serveOriginal(p.arguments) : { content: [{ type: 'text', text: 'no original https://example.invalid/secret' }], isError: true };
    }
    calls.tools.push(p); return replies.tool ? { content: [], structuredContent: replies.tool } : { content: [{ type: 'text', text: 'no reply https://example.invalid/secret' }], isError: true };
  };
  bridge.ondownloadfile = async p => { calls.downloads.push(p.contents[0]); return {}; };
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
  ready: () => ready.then(() => true),
  result: async structuredContent => (await ready).sendToolResult({ content: [], structuredContent }),
  input: async args => (await ready).sendToolInput({ arguments: args }),
  teardown: async () => (await ready).teardownResource({}),
};
