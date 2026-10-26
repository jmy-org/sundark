/** Pure, DOM-free state for the ephemeral attachment reader. Everything here lives in
 * the widget's memory only: host tool results are transient, and nothing is written to
 * Sundark storage. Shared with tests under plain Node. */
import { normalizeSegments, type SourceSegment } from '../../lib/source-geometry';

export type Segment = SourceSegment & { tex?: string };
export interface Attachment { fileId: string; fileName: string; pdfSha256: string; numPages: number }
export interface PageSource { page: number; width: number; height: number; segments: Segment[]; sourceHash?: string }
/** One prepare_attachment_task result as render_attached_reader returned it (already
 * checked by the server), flattened to readable text for the sidebar and exports. */
export interface AnalysisItem { kind: string; language: string; sourcePages: number[]; title: string; text: string; coversShownPage?: boolean }
export interface Batch { page: number; language: string; segmentIds: string[] }
export interface ReaderOutput {
  attachment: Attachment | null; page: number | null; sourceHash: string | null;
  pages: PageSource[]; translations: { id: string; text: string }[];
  nextPages: number[]; needsOcrPages: number[]; failedPages: number[]; deferredPages: number[];
  /** Read progress the caller echoes back. attemptedPages is empty on every result that
   * did not read pages (render, prepare, launcher); unreadPages is null when the server
   * did not send it. complete is the server's verified claim (one call read every page);
   * reportedComplete only restates the caller's echoed lists. Both are checked in merge(). */
  attemptedPages: number[]; unreadPages: number[] | null; complete: boolean; reportedComplete: boolean;
  pageLimit: number | null; extractablePages: number | null;
  language: string; batches: Batch[];
  storageNotice: string; prompt: string; analysis: AnalysisItem[];
}

const MAX_TRANSLATION = 20000;
const MAX_TRANSLATIONS = 3000;
const MAX_NOTE = 2000;
const MAX_ANALYSIS = 60000;

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const count = (v: unknown) => Number.isInteger(v) && (v as number) >= 0 && (v as number) <= 100000 ? v as number : null;
const str = (v: unknown, max: number) => typeof v === 'string' ? v.slice(0, max) : '';
function pageList(v: unknown): number[] {
  if (!Array.isArray(v)) return [];
  return [...new Set(v.filter((n): n is number => Number.isInteger(n) && n >= 1 && n <= 10000))].sort((a, b) => a - b).slice(0, 500);
}
function attachment(v: unknown): Attachment | null {
  if (!isObject(v)) return null;
  const fileId = str(v.fileId, 200), fileName = str(v.fileName, 255), pdfSha256 = str(v.pdfSha256, 64);
  if (!fileId && !pdfSha256) return null;
  if (pdfSha256 && !/^[a-f0-9]{64}$/.test(pdfSha256)) throw new Error('PDF 지문 형식이 올바르지 않아요.');
  const numPages = Number.isInteger(v.numPages) && (v.numPages as number) > 0 ? v.numPages as number : 0;
  return { fileId, fileName: fileName || 'document.pdf', pdfSha256, numPages };
}
function pageSource(v: unknown): PageSource {
  if (!isObject(v) || !Number.isInteger(v.page)) throw new Error('원문 페이지 형식이 올바르지 않아요.');
  const page = v.page as number;
  const width = Number(v.width), height = Number(v.height);
  if (!(width > 0 && height > 0 && width < 20000 && height < 20000)) throw new Error('페이지 크기가 올바르지 않아요.');
  const raw = Array.isArray(v.segments) ? v.segments : [];
  const segments: Segment[] = normalizeSegments(raw.map(s => {
    if (!isObject(s)) return s;
    const { tex: _tex, ...rest } = s;
    void _tex;
    return rest;
  }), page);
  raw.forEach((s, i) => { if (isObject(s) && typeof s.tex === 'string' && s.tex.length <= 20000) segments[i].tex = s.tex; });
  return { page, width, height, segments, ...(typeof v.sourceHash === 'string' ? { sourceHash: v.sourceHash.slice(0, 128) } : {}) };
}
const KIND_TITLES: Record<string, string> = { summary: '요약', anatomy: '연구 구조', qa: '질문과 답', explanation: '설명',
  equation: '수식', glossary: '용어집', review: '리뷰 노트' };
const CARD_TITLES: Record<string, string> = { problem: '문제', gap: '공백', claim: '주장', method: '방법', dataset_test: '데이터·실험',
  metric: '지표', baseline: '비교 대상', ablation: '절제 실험', limitations: '한계' };
const text = (v: unknown) => typeof v === 'string' ? v : '';
function card(name: string, v: unknown): string[] {
  if (!isObject(v)) return [];
  const title = CARD_TITLES[name] ?? name;
  if (v.status === 'not_present') return [`${title}: 논문에 없음`];
  const points = Array.isArray(v.points) ? v.points.filter(isObject).map(p => '- ' + text(p.text)).filter(l => l.length > 2) : [];
  return points.length ? [title, ...points] : [];
}
/** Flattens a server-checked analysis content object; an unknown shape becomes nothing
 * rather than a guess. */
export function analysisText(kind: string, c: unknown): string {
  if (!isObject(c)) return '';
  switch (kind) {
    case 'summary': case 'explanation': return text(c.text);
    case 'qa': return text(c.answer) ? `Q. ${text(c.question)}\n\n${text(c.answer)}` : '';
    case 'equation': return [text(c.latex) && `\\[ ${text(c.latex)} \\]`, text(c.explanation)].filter(Boolean).join('\n\n');
    case 'glossary': return [text(c.field) && `분야: ${text(c.field)}`,
      ...(Array.isArray(c.abbreviations) ? c.abbreviations.filter(isObject).map(a => `- ${text(a.term)}: ${text(a.meaning)}`) : []),
      ...(Array.isArray(c.terms) ? c.terms.filter(isObject).map(t => `- ${text(t.term)} → ${text(t.translation)}`) : [])].filter(Boolean).join('\n');
    case 'anatomy': {
      const evidence = isObject(c.evidence) ? c.evidence : {};
      return [...card('problem', c.problem), ...card('gap', c.gap), ...card('claim', c.claim), ...card('method', c.method),
        ...['dataset_test', 'metric', 'baseline', 'ablation'].flatMap(k => card(k, evidence[k])), ...card('limitations', c.limitations)].join('\n');
    }
    case 'review': return [text(c.summary), ...(Array.isArray(c.sections) ? c.sections.filter(isObject).map(x => `${text(x.heading)}\n${text(x.text)}`) : [])].filter(Boolean).join('\n\n');
    default: return '';
  }
}
function analysis(v: unknown): AnalysisItem[] {
  if (!isObject(v) || typeof v.kind !== 'string') return [];
  const body = analysisText(v.kind, v.content).slice(0, MAX_ANALYSIS);
  if (!body) return [];
  return [{ kind: v.kind.slice(0, 40), language: str(v.language, 50), sourcePages: pageList(v.sourcePages),
    title: KIND_TITLES[v.kind] ?? v.kind.slice(0, 40), text: body,
    ...(typeof v.coversShownPage === 'boolean' ? { coversShownPage: v.coversShownPage } : {}) }];
}
function analysisList(v: unknown): AnalysisItem[] {
  if (!Array.isArray(v)) return [];
  return v.filter(isObject).slice(0, 100).flatMap(a => typeof a.kind === 'string' && typeof a.text === 'string' && a.text
    ? [{ kind: a.kind.slice(0, 40), language: str(a.language, 50), sourcePages: pageList(a.sourcePages), title: str(a.title, 80) || (KIND_TITLES[a.kind] ?? a.kind.slice(0, 40)), text: a.text.slice(0, MAX_ANALYSIS) }] : []);
}

function batches(v: unknown): Batch[] {
  if (!Array.isArray(v)) return [];
  return v.filter(isObject).slice(0, 500).flatMap(b => Number.isInteger(b.page) && Array.isArray(b.segmentIds)
    ? [{ page: b.page as number, language: str(b.language, 50), segmentIds: b.segmentIds.filter((id): id is string => typeof id === 'string').slice(0, 3000).map(id => id.slice(0, 80)) }] : []);
}

/** Validates one tool result's structuredContent. Throws on a malformed payload so the
 * UI reports the first failure instead of painting partial or invented data. */
export function parseOutput(input: unknown): ReaderOutput {
  if (!isObject(input)) throw new Error('도구 결과에 리더 데이터가 없어요.');
  if (input.persistent === true || (input.mode !== undefined && input.mode !== 'ephemeral')) throw new Error('이 화면은 저장하지 않은(ephemeral) 읽기 결과만 보여줘요.');
  const pages = (Array.isArray(input.pages) ? input.pages : []).slice(0, 200).map(pageSource);
  const translations = (Array.isArray(input.translations) ? input.translations : []).slice(0, MAX_TRANSLATIONS)
    .filter(isObject).filter(t => typeof t.id === 'string' && typeof t.text === 'string')
    .map(t => ({ id: (t.id as string).slice(0, 80), text: (t.text as string).slice(0, MAX_TRANSLATION) }));
  const translation = isObject(input.translation) ? input.translation : {};
  const batchList = batches(translation.batches);
  return {
    attachment: attachment(input.attachment),
    page: Number.isInteger(input.page) ? input.page as number : null,
    sourceHash: typeof input.sourceHash === 'string' ? input.sourceHash.slice(0, 128) : null,
    pages, translations,
    nextPages: pageList(input.nextPages), needsOcrPages: pageList(input.needsOcrPages),
    failedPages: pageList(input.failedPages), deferredPages: pageList(input.deferredPages),
    attemptedPages: pageList(input.attemptedPages), unreadPages: Array.isArray(input.unreadPages) ? pageList(input.unreadPages) : null,
    complete: input.complete === true, reportedComplete: input.reportedComplete === true, pageLimit: count(input.pageLimit), extractablePages: count(input.extractablePages),
    language: str(translation.language, 50).trim() || batchList.find(b => b.language)?.language || '', batches: batchList,
    storageNotice: str(input.storageNotice, MAX_NOTE), prompt: str(input.prompt, MAX_NOTE),
    analysis: Array.isArray(input.analysis) ? analysisList(input.analysis) : analysis(input.analysis),
  };
}

export interface Doc {
  attachment: Attachment | null;
  pages: Map<number, PageSource>;
  translations: Map<string, string>;
  nextPages: number[]; needsOcrPages: number[]; failedPages: number[]; deferredPages: number[];
  attemptedPages: number[]; unreadPages: number[]; complete: boolean; reportedComplete: boolean;
  pageLimit: number | null; extractablePages: number | null;
  language: string; batches: Batch[];
  storageNotice: string; prompt: string; analysis: AnalysisItem[];
  /** Opened from an exported JSON file: its pages rest on that file, not on a fresh read. */
  restored?: boolean;
}
export const emptyDoc = (): Doc => ({ attachment: null, pages: new Map(), translations: new Map(),
  nextPages: [], needsOcrPages: [], failedPages: [], deferredPages: [], attemptedPages: [], unreadPages: [], complete: false, reportedComplete: false,
  pageLimit: null, extractablePages: null, language: '', batches: [], storageNotice: '', prompt: '', analysis: [] });
const union = (...lists: number[][]) => [...new Set(lists.flat())].sort((a, b) => a - b);
const sameLanguage = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

export function sameAttachment(a: Attachment | null, b: Attachment | null) {
  if (!a || !b) return false;
  if (a.pdfSha256 && b.pdfSha256) return a.pdfSha256 === b.pdfSha256;
  return !!a.fileId && a.fileId === b.fileId;
}

/** Folds a tool result into the in-memory document. A different attachment starts over;
 * a page whose segment ids changed replaces its old translations, never mixes them. */
export function merge(doc: Doc, out: ReaderOutput): Doc {
  const next = out.attachment && doc.attachment && !sameAttachment(doc.attachment, out.attachment) ? emptyDoc()
    : { ...doc, pages: new Map(doc.pages), translations: new Map(doc.translations), analysis: [...doc.analysis] };
  if (out.attachment) next.attachment = { ...next.attachment, ...out.attachment,
    numPages: out.attachment.numPages || next.attachment?.numPages || 0 };
  for (const page of out.pages) {
    const old = next.pages.get(page.page);
    if (old && old.segments.map(s => s.id).join('\n') !== page.segments.map(s => s.id).join('\n'))
      for (const s of old.segments) next.translations.delete(s.id);
    next.pages.set(page.page, page);
  }
  // The launcher (no attachment) carries the default language; it never changes a reading.
  if (out.attachment && out.language) {
    // Translations into another language never mix with the old ones in one frontier.
    if (next.language && !sameLanguage(next.language, out.language)) next.translations.clear();
    next.language = out.language;
  }
  if (out.attachment && out.batches.length) next.batches = out.batches;
  const known = new Set([...next.pages.values()].flatMap(p => p.segments.map(s => s.id)));
  for (const t of out.translations) if (known.has(t.id)) next.translations.set(t.id, t.text);
  // Only a result that read pages (it lists them in attemptedPages) moves the read loop;
  // a render or task result keeps it and can only add pages without a text layer.
  const read = out.attemptedPages.length > 0;
  const withText = out.pages.filter(p => p.segments.length).map(p => p.page);
  if (read) {
    next.restored = false;
    next.nextPages = out.nextPages; next.needsOcrPages = out.needsOcrPages;
    next.failedPages = out.failedPages; next.deferredPages = out.deferredPages;
    // Cumulative across calls; a deferred page was not read, whatever an earlier call said.
    next.attemptedPages = union(next.attemptedPages, out.attemptedPages).filter(n => !out.deferredPages.includes(n));
  } else next.needsOcrPages = union(next.needsOcrPages, out.needsOcrPages).filter(n => !withText.includes(n));
  next.attemptedPages = union(next.attemptedPages, out.pages.map(p => p.page));
  next.unreadPages = union(read && out.unreadPages ? out.unreadPages : next.unreadPages, out.needsOcrPages, out.failedPages)
    .filter(n => !withText.includes(n));
  if (out.pageLimit !== null) next.pageLimit = out.pageLimit;
  if (out.extractablePages !== null && out.attachment) next.extractablePages = out.extractablePages;
  next.complete = isComplete(next, read ? out.complete : next.complete);
  next.reportedComplete = !next.complete && (read ? out.reportedComplete : next.reportedComplete) && !next.unreadPages.length;
  if (out.storageNotice) next.storageNotice = out.storageNotice;
  next.prompt = out.prompt;
  // Questions accumulate; any other kind keeps only its newest result.
  for (const item of out.analysis) {
    next.analysis = next.analysis.filter(a => item.kind === 'qa' ? a.kind !== 'qa' || a.text !== item.text : a.kind !== item.kind);
    next.analysis.push(item);
  }
  next.analysis = next.analysis.slice(-100);
  return next;
}

/** Complete when the server verified it (one call read every page) or this reader itself
 * holds every page of this PDF with text; either way every page was attempted, none is
 * unread (scanned, failed) or deferred, and the PDF is within the page limit. A truncated,
 * scanned or failed document, or one only the caller's echoed lists call read, is never
 * shown as finished. */
function isComplete(doc: Doc, claimed: boolean) {
  const n = doc.attachment?.numPages ?? 0;
  if (!n) return false;
  let held = true;
  for (let i = 1; i <= n && held; i++) held = !!doc.pages.get(i)?.segments.length;
  if (!(claimed || held) || doc.unreadPages.length || doc.deferredPages.length || doc.failedPages.length || doc.needsOcrPages.length) return false;
  if (doc.pageLimit !== null && n > doc.pageLimit) return false;
  const attempted = new Set(doc.attemptedPages);
  for (let i = 1; i <= n; i++) if (!attempted.has(i)) return false;
  return true;
}

export const orderedPages = (doc: Doc) => [...doc.pages.values()].sort((a, b) => a.page - b.page);

/** The translation frontier: a sentence's translation is shown only when every earlier
 * sentence of the document's received pages is translated too, so nothing ever appears
 * out of order and a gap is never filled with source text. */
export function frontier(doc: Doc) {
  const shown = new Set<string>();
  let total = 0, open = true;
  for (const page of orderedPages(doc)) for (const s of page.segments) {
    total++;
    if (open && doc.translations.has(s.id)) shown.add(s.id); else open = false;
  }
  return { shown, total, translated: shown.size };
}

export function progress(doc: Doc) {
  const f = frontier(doc);
  const numPages = doc.attachment?.numPages ?? 0;
  const limit = doc.pageLimit;
  return { received: doc.pages.size, numPages, translated: f.translated, total: f.total,
    readable: [...doc.pages.values()].filter(p => p.segments.length).length,
    attempted: doc.attemptedPages.length, unread: doc.unreadPages, complete: doc.complete, reportedComplete: doc.reportedComplete,
    extractable: doc.extractablePages ?? (limit !== null && numPages ? Math.min(numPages, limit) : numPages),
    beyondLimit: limit !== null && numPages > limit ? numPages - limit : 0 };
}

/** Only small, non-sensitive metadata: never PDF bytes, text, translations or URLs. */
export function widgetState(doc: Doc, page: number, selected: string | null) {
  const a = doc.attachment;
  return { v: 1, page, ...(selected ? { seg: selected.slice(0, 80) } : {}),
    ...(a ? { file: { id: a.fileId.slice(0, 200), sha: a.pdfSha256 } } : {}) };
}
export function readWidgetState(raw: unknown, doc: Doc): { page: number; seg: string | null } | null {
  if (!isObject(raw) || raw.v !== 1 || !Number.isInteger(raw.page)) return null;
  const file = isObject(raw.file) ? raw.file : null;
  if (doc.attachment && file && !sameAttachment(doc.attachment, { fileId: str(file.id, 200), pdfSha256: str(file.sha, 64), fileName: '', numPages: 0 })) return null;
  return { page: raw.page as number, seg: typeof raw.seg === 'string' ? raw.seg.slice(0, 80) : null };
}

export function safeFilename(name: string, suffix: string) {
  const base = name.replace(/\.pdf$/i, '').normalize('NFC').replace(/[^\p{L}\p{N}._ -]+/gu, '_')
    .replace(/^[.\s_-]+|[.\s_-]+$/g, '').replace(/\s+/g, ' ').slice(0, 80);
  return (base || 'sundark-paper') + suffix;
}

export const EXPORT_FORMAT = 'sundark-ephemeral-reading';
export function exportJson(doc: Doc) {
  return JSON.stringify({
    format: EXPORT_FORMAT, version: 1, exportedAt: new Date().toISOString(), ...(doc.language ? { language: doc.language } : {}),
    attachment: doc.attachment ? { fileName: doc.attachment.fileName, pdfSha256: doc.attachment.pdfSha256, numPages: doc.attachment.numPages } : null,
    pages: orderedPages(doc).map(p => ({ page: p.page, width: p.width, height: p.height, segments: p.segments })),
    translations: [...frontier(doc).shown].map(id => ({ id, text: doc.translations.get(id)! })),
    analysis: doc.analysis,
  }, null, 1);
}
const quote = (text: string) => text.split('\n').map(line => '> ' + line).join('\n');
export function exportMarkdown(doc: Doc) {
  const shown = frontier(doc).shown;
  const out = [`# ${doc.attachment?.fileName ?? 'Sundark reading'}`, ''];
  if (doc.attachment?.pdfSha256) out.push(`PDF SHA-256: \`${doc.attachment.pdfSha256}\``, '');
  if (doc.language) out.push(`Translation language: ${doc.language}`, '');
  for (const a of doc.analysis) out.push(`## ${a.title}${a.sourcePages.length ? ` (source pages ${a.sourcePages.join(', ')})` : ''}`, '', a.text, '');
  for (const page of orderedPages(doc)) {
    out.push(`## Page ${page.page}`, '');
    for (const s of page.segments) {
      out.push(quote(s.text), '');
      if (shown.has(s.id)) out.push(doc.translations.get(s.id)!, '');
    }
  }
  return out.join('\n');
}

const MAX_RESTORE_BYTES = 4 * 1024 * 1024;
/** Restores an exported reading. Every page goes through the same segment validator as
 * a live tool result, and translations must name a restored segment. */
export function restoreJson(text: string): Doc {
  if (new TextEncoder().encode(text).length > MAX_RESTORE_BYTES) throw new Error('파일이 4MB보다 커요.');
  let raw: unknown;
  try { raw = JSON.parse(text); } catch { throw new Error('올바른 JSON 파일이 아니에요.'); }
  if (!isObject(raw) || raw.format !== EXPORT_FORMAT || raw.version !== 1) throw new Error('Sundark에서 내보낸 읽기 결과가 아니에요.');
  const a = isObject(raw.attachment) ? attachment({ ...raw.attachment, fileId: '' }) : null;
  const out = parseOutput({ mode: 'ephemeral', persistent: false, attachment: a, pages: raw.pages, translations: raw.translations, analysis: raw.analysis,
    ...(typeof raw.language === 'string' ? { translation: { language: raw.language } } : {}) });
  return { ...merge(emptyDoc(), out), restored: true };
}
