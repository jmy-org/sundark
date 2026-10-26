/** Ephemeral ChatGPT attachment reader (MCP Apps view): original PDF beside its
 * translation. Self-contained; built by scripts/build-attachment-reader.mjs. */
import { html } from './generated/attachment-reader-html';
// Hosts cache a template by its URI, so a changed HTML body gets a new URI. The URIs earlier
// tool results named stay readable (same body), so existing chats keep their reader.
export const attachmentReaderUri = 'ui://sundark/attachment-reader-v2.html';
export const attachmentReaderAliases: readonly string[] = ['ui://sundark/attachment-reader.html'];
export const attachmentReaderHtml: string = html;
