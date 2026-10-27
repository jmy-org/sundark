/**
 * Markdown + LaTeX for AI text, which is untrusted (it is built from PDF text). The same
 * pipeline as the original reader's mdMath()/renderMath() in public/sundark-original/app.js:
 * marked, then DOMPurify with forms, media and inline styles forbidden, then KaTeX with
 * trust off (no \href, \url or \htmlClass).
 */
import DOMPurify from "dompurify";
import { marked } from "marked";
import renderMathInElement from "katex/contrib/auto-render";

// marked treats "\(" as an escaped "(" and "_x_" as emphasis, which destroys math before KaTeX
// sees it. Shield math spans with placeholders, run marked, then put the math back
// (HTML-escaped) for KaTeX to typeset. "$...$" is shielded too (renderMarkdown enables it): one
// line, "$$" first, and an escaped "\$" neither opens it (marked's literal dollar) nor closes it
// (KaTeX skips escaped characters).
/** Sanitized HTML, or null where DOMPurify cannot run (it would return its input unchanged). */
export function markdownHtml(text: string): string | null {
  if (!DOMPurify.isSupported) return null;
  const spans: string[] = [];
  const shielded = (text || "").replace(/\\\[[\s\S]+?\\\]|\\\([\s\S]+?\\\)|\$\$[\s\S]+?\$\$|(?<!\\)\$(?:\\[^\n]|[^\\$\n])+?\$/g, (m) => {
    spans.push(m);
    return "@@MATH" + (spans.length - 1) + "@@";
  });
  const escape = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const html = marked.parse(shielded, { async: false }).replace(/@@MATH(\d+)@@/g, (_, k) => escape(spans[Number(k)] || ""));
  return DOMPurify.sanitize(html, {
    USE_PROFILES: { html: true },
    FORBID_TAGS: ["img", "style", "form", "input", "button", "iframe", "object", "embed"],
    FORBID_ATTR: ["style", "srcset"],
  });
}

/** Renders text into el; falls back to plain text where it cannot be sanitized. */
export function renderMarkdown(el: HTMLElement, text: string) {
  const html = markdownHtml(text);
  if (html === null) {
    el.textContent = text;
    return;
  }
  el.innerHTML = html;
  try {
    renderMathInElement(el, {
      delimiters: [
        { left: "\\[", right: "\\]", display: true },
        { left: "\\(", right: "\\)", display: false },
        { left: "$$", right: "$$", display: true },
        { left: "$", right: "$", display: false },
      ],
      throwOnError: false, trust: false, maxExpand: 1000, maxSize: 20,
    });
  } catch {
    /* leave raw TeX if KaTeX fails */
  }
}
