// Test-only MCP Apps host page for the attachment reader, bundled by the browser test.
// It uses the official AppBridge, so the widget talks the real protocol. No real data.
import { AppBridge, PostMessageTransport } from '@modelcontextprotocol/ext-apps/app-bridge';

const params = new URLSearchParams(location.search);
const capabilities = { message: { text: {} }, serverTools: {}, downloadFile: {}, ...(params.get('resources') ? { experimental: { 'openai/resource': {} } } : {}) };
const calls = { messages: [], tools: [], downloads: [], resources: [] };
const replies = { tool: null, resource: null };
const iframe = document.createElement('iframe');
// An opaque-origin sandbox like the real host's: the widget reaches nothing same-origin.
iframe.setAttribute('sandbox', 'allow-scripts');
iframe.title = 'Sundark reader';
iframe.style.cssText = 'width:1280px;height:900px;border:0';
const ready = new Promise(resolve => {
  const bridge = new AppBridge(null, { name: 'sundark-test-host', version: '1.0.0' }, capabilities);
  bridge.onmessage = async p => { calls.messages.push(p.content.map(c => c.text).join('\n')); return {}; };
  bridge.oncalltool = async p => { calls.tools.push(p); return replies.tool ? { content: [], structuredContent: replies.tool } : { content: [{ type: 'text', text: 'no reply https://example.invalid/secret' }], isError: true }; };
  bridge.ondownloadfile = async p => { calls.downloads.push(p.contents[0]); return {}; };
  bridge.onreadresource = async p => { calls.resources.push(p); return replies.resource; };
  bridge.oninitialized = () => resolve(bridge);
  // Listen before the view loads, as a real host does, so its ui/initialize is not missed.
  document.body.appendChild(iframe);
  bridge.connect(new PostMessageTransport(iframe.contentWindow, iframe.contentWindow)).then(() => { iframe.src = '/widget.html' + location.search; });
});
window.testHost = {
  calls, replies,
  ready: () => ready.then(() => true),
  result: async structuredContent => (await ready).sendToolResult({ content: [], structuredContent }),
  input: async args => (await ready).sendToolInput({ arguments: args }),
  teardown: async () => (await ready).teardownResource({}),
};
