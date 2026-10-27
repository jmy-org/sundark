/** Ephemeral ChatGPT attachment reader (MCP Apps view): original PDF beside its
 * translation. Self-contained; built by scripts/build-attachment-reader.mjs. */
import { html } from './generated/attachment-reader-html';
// Hosts cache a template by its URI, so a changed HTML body gets a new URI. The URIs earlier
// tool results named stay readable (same body), so existing chats keep their reader.
// v4 has an empty CSP (the CSP is part of the cached template) and reads the original in-band.
export const attachmentReaderUri = 'ui://sundark/attachment-reader-v4.html';
// Earlier URIs serve the current body and CSP, unadvertised. v3 was the failed widget-domain experiment.
export const attachmentReaderAliases: readonly string[] = ['ui://sundark/attachment-reader.html', 'ui://sundark/attachment-reader-v2.html', 'ui://sundark/attachment-reader-v3.html'];
export const attachmentReaderHtml: string = html;
