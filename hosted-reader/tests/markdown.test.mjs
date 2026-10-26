// Markdown rendering of untrusted AI text. The browser half runs lib/markdown.ts in headless
// Chrome (no new dependencies): CHROME=<path> overrides the default macOS install.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { stripTypeScriptTypes } from 'node:module';
import test from 'node:test';
import { markdownHtml } from '../lib/markdown.ts';

const root = new URL('../', import.meta.url);
const chrome = process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

test('without a DOM, markdownHtml refuses instead of passing HTML through', () => {
  // DOMPurify returns its input unchanged where it cannot run (server render).
  assert.equal(markdownHtml('<img src=x onerror="alert(1)"> **b**'), null);
});

const page = `<!doctype html><meta charset="utf-8"><script type="importmap">${JSON.stringify({ imports: {
  dompurify: '/node_modules/dompurify/dist/purify.es.mjs',
  marked: '/node_modules/marked/lib/marked.esm.js',
  'katex/contrib/auto-render': '/node_modules/katex/dist/contrib/auto-render.mjs',
} })}</script><body><script type="module">
import { renderMarkdown } from '/lib/markdown.ts';
const out = {};
const box = text => { const el = document.createElement('div'); document.body.append(el); renderMarkdown(el, text); return el; };
const md = box('## 배경과 문제\\n\\n**핵심**은 _x_가 아니라 \\\\(x_1^2\\\\)이다.\\n\\n- 항목\\n\\n\\\\[ \\\\sum_i a_i \\\\]');
out.h2 = md.querySelector('h2')?.textContent;
out.strong = md.querySelector('strong')?.textContent;
out.li = md.querySelector('li')?.textContent;
out.inline = md.querySelectorAll('.katex').length;
out.display = md.querySelectorAll('.katex-display').length;
out.literal = /##|\\*\\*/.test(md.textContent);
// "$...$" is a KaTeX delimiter: marked must not unescape "\\{" or read "_" as emphasis in it.
const dollar = box('$A = \\\\{x_1,\\\\ldots,x_n\\\\}$ and $\\\\hat{y}_t = \\\\sum_{j} w_j$ with _em_ text, costs \\\\$5.');
out.dollarTex = [...dollar.querySelectorAll('.katex annotation')].map(a => a.textContent);
out.dollarEm = [...dollar.querySelectorAll('em')].map(e => e.textContent);
out.currency = dollar.textContent.trim().endsWith('costs $5.');
const bad = box([
  '<img src=x onerror="window.pwned=1">', '<script>window.pwned=1<\\/script>', '<iframe src="javascript:window.pwned=1"></iframe>',
  '[link](javascript:window.pwned=1)', '<a href="javascript:window.pwned=1">a</a>', '<form><input><button>b</button></form>',
  '<div style="position:fixed" onclick="window.pwned=1">d</div>', '<svg><script>window.pwned=1<\\/script></svg>',
  '\\\\(<img src=x onerror="window.pwned=1">\\\\)', '\\\\(\\\\href{javascript:window.pwned=1}{x}\\\\)',
].join('\\n\\n'));
out.forbidden = [...bad.querySelectorAll('img,script,iframe,form,input,button,object,embed,style')].map(n => n.tagName);
// KaTeX sizes its own spans with inline styles; any other style came from the input.
out.handlers = [...bad.querySelectorAll('*')].flatMap(n => [...n.attributes].map(a => a.name).filter(a => /^on/.test(a) || (a === 'style' && !n.closest('.katex'))));
out.jsLinks = [...bad.querySelectorAll('[href],[src]')].map(n => n.getAttribute('href') || n.getAttribute('src')).filter(u => /^\\s*javascript:/i.test(u));
setTimeout(() => { out.pwned = window.pwned ?? null; document.body.textContent = 'RESULT:' + JSON.stringify(out); }, 200);
</script>`;

const types = { '.mjs': 'text/javascript', '.js': 'text/javascript', '.ts': 'text/javascript' };

test('in a browser, Markdown renders and untrusted HTML does not', { skip: !existsSync(chrome) && `no Chrome at ${chrome}` }, async () => {
  const server = createServer((req, res) => {
    const path = new URL(req.url, 'http://x').pathname;
    if (path === '/') return res.writeHead(200, { 'content-type': 'text/html' }).end(page);
    const ext = path.slice(path.lastIndexOf('.'));
    if (!types[ext] || !/^\/(lib|node_modules)\//.test(path) || path.includes('..')) return res.writeHead(404).end();
    let body = readFileSync(new URL('.' + path, root), 'utf8');
    if (ext === '.ts') body = stripTypeScriptTypes(body);
    res.writeHead(200, { 'content-type': types[ext] }).end(body);
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  try {
    const url = `http://127.0.0.1:${server.address().port}/`;
    const proc = spawn(chrome, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
      `--user-data-dir=${process.env.TMPDIR || '/tmp'}/sundark-md-test-${process.pid}`, '--virtual-time-budget=5000', '--enable-logging=stderr', '--v=0', '--dump-dom', url]);
    proc.stderr.on('data', d => { if (/CONSOLE/.test(d)) process.stderr.write(d); });
    let dom = '';
    proc.stdout.on('data', d => { dom += d; });
    await new Promise((resolve, reject) => { proc.on('error', reject); proc.on('close', resolve); });
    const match = dom.match(/RESULT:(\{.*\})/);
    assert.ok(match, `no result in page: ${dom.slice(0, 500)}`);
    const out = JSON.parse(match[1].replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&'));
    assert.equal(out.h2, '배경과 문제');
    assert.equal(out.strong, '핵심');
    assert.equal(out.li, '항목');
    assert.equal(out.literal, false);
    assert.ok(out.inline >= 2, 'inline and display math typeset');
    assert.equal(out.display, 1);
    assert.deepEqual(out.dollarTex, ['A = \\{x_1,\\ldots,x_n\\}', '\\hat{y}_t = \\sum_{j} w_j']);
    assert.deepEqual(out.dollarEm, ['em']);
    assert.equal(out.currency, true);
    assert.deepEqual(out.forbidden, []);
    assert.deepEqual(out.handlers, []);
    assert.deepEqual(out.jsLinks, []);
    assert.equal(out.pwned, null);
  } finally {
    server.close();
  }
});
