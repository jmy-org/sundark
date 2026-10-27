/** Ephemeral ChatGPT attachment reader (MCP Apps view): original PDF beside its
 * translation. Self-contained; built by scripts/build-attachment-reader.mjs. */
import { html } from './generated/attachment-reader-html';
// Hosts cache a template by its URI, so a changed HTML body gets a new URI. The URIs earlier
// tool results named stay readable (same body), so existing chats keep their reader.
export const attachmentReaderUri = 'ui://sundark/attachment-reader-v2.html';
// v3 was the failed widget-domain experiment: it now serves the restored v2 body, unadvertised.
export const attachmentReaderAliases: readonly string[] = ['ui://sundark/attachment-reader.html', 'ui://sundark/attachment-reader-v3.html'];
export const attachmentReaderHtml: string = html;
