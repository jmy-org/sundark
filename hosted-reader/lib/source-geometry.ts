/** Independently implemented source contract informed by jmy-org/sundark's
 * word-indexed sentences, paragraph batches and multi-part highlights. This is
 * NOT its DocLayout/PyMuPDF layout engine. No upstream implementation copied. */
export type BBox = [number, number, number, number];
export interface SourceSegment {
  id: string; text: string; bbox: BBox;
  schemaVersion?: 2; para?: string; sourceIds?: string[];
  rects?: { page: number; bbox: BBox }[];
  geometryPrecision?: 'pdf-item' | 'ocr-word'; size?: number; confidence?: number;
}
export interface SourceAtom { id: string; text: string; bbox: BBox; para: string; size?: number; joinBefore?: string }
const MAX_PARTS = 128;
function box(value: unknown): BBox {
  if (!Array.isArray(value) || value.length !== 4 || value.some(n => typeof n !== 'number' || !Number.isFinite(n) || n < 0 || n > 1)
      || value[0] + value[2] > 1.000001 || value[1] + value[3] > 1.000001) throw new Error('Invalid normalized source rectangle.');
  return [...value] as BBox;
}
function identifier(value: unknown): string {
  if (typeof value !== 'string' || !value.length || value.length > 80 || /[\u0000-\u001f]/.test(value)) throw new Error('Invalid source identifier.');
  return value;
}
/** Bounded serializer shared by browser and authenticated persistence API.
 * Legacy records keep precisely their original IDs/text/box; no silent migration. */
export function normalizeSegments(input: unknown, page: number): SourceSegment[] {
  if (!Number.isInteger(page) || page < 1 || page > 200) throw new Error('Invalid source page.');
  if (!Array.isArray(input) || input.length > 3000) throw new Error('Too many source segments.');
  let characters = 0;
  const seen = new Set<string>();
  const result = input.map((raw): SourceSegment => {
    if (!raw || typeof raw !== 'object') throw new Error('Invalid source segment.');
    const id = identifier(raw.id);
    if (seen.has(id)) throw new Error('Duplicate source segment ID.');
    seen.add(id);
    if (typeof raw.text !== 'string' || (characters += raw.text.length) > 80000) throw new Error('Source text exceeds 80000 characters.');
    const segment: SourceSegment = { id, text: raw.text, bbox: box(raw.bbox) };
    if (raw.schemaVersion === undefined) {
      if (['para','sourceIds','rects','geometryPrecision'].some(k => raw[k] !== undefined)) throw new Error('Geometry metadata requires schemaVersion 2.');
      return segment;
    }
    if (raw.schemaVersion !== 2) throw new Error('Unsupported geometry schema.');
    segment.schemaVersion = 2;
    segment.para = identifier(raw.para);
    if (!['pdf-item','ocr-word'].includes(raw.geometryPrecision)) throw new Error('Invalid geometry precision.');
    segment.geometryPrecision = raw.geometryPrecision;
    if (!Array.isArray(raw.sourceIds) || !raw.sourceIds.length || raw.sourceIds.length > MAX_PARTS) throw new Error('Invalid source item references.');
    segment.sourceIds = [...new Set<string>(raw.sourceIds.map(identifier))];
    if (!Array.isArray(raw.rects) || !raw.rects.length || raw.rects.length > MAX_PARTS) throw new Error('Invalid source rectangles.');
    segment.rects = raw.rects.map((part: { page: number; bbox: unknown }) => {
      // Cross-page ownership is deliberately unsupported until an actual layout
      // provider can verify stitching. Do not fabricate it from adjacent pages.
      if (!part || part.page !== page) throw new Error('Source rectangle must belong to this page.');
      return { page, bbox: box(part.bbox) };
    });
    if (raw.size !== undefined) {
      if (typeof raw.size !== 'number' || !Number.isFinite(raw.size) || raw.size <= 0 || raw.size > 1000) throw new Error('Invalid source font size.');
      segment.size = raw.size;
    }
    if (raw.confidence !== undefined) {
      if (typeof raw.confidence !== 'number' || !Number.isFinite(raw.confidence) || raw.confidence < 0 || raw.confidence > 100) throw new Error('Invalid confidence.');
      segment.confidence = raw.confidence;
    }
    return segment;
  });
  if (new TextEncoder().encode(JSON.stringify(result)).length > 300000) throw new Error('Source geometry exceeds 300KB.');
  return result;
}
function envelope(boxes: BBox[]): BBox {
  const x = Math.min(...boxes.map(b => b[0])), y = Math.min(...boxes.map(b => b[1]));
  return [x,y,Math.max(...boxes.map(b => b[0]+b[2]))-x,Math.max(...boxes.map(b => b[1]+b[3]))-y];
}
/** Keeps supplied reading order and paragraph provenance. PDF item geometry is
 * never fractionally divided to impersonate measured word/glyph coordinates. */
export function buildSentenceSegments(atoms: SourceAtom[], page: number, method: 'text' | 'ocr'): SourceSegment[] {
  const paragraphs: SourceAtom[][] = [];
  for (const atom of atoms) {
    if (!atom.text.trim()) continue;
    const previous = paragraphs[paragraphs.length-1];
    // Bound very long paragraphs without losing source atoms.
    if (!previous || previous[0].para !== atom.para || previous.length >= MAX_PARTS) paragraphs.push([atom]);
    else previous.push(atom);
  }
  const result: SourceSegment[] = [];
  const splitter = new Intl.Segmenter('en', { granularity: 'sentence' });
  for (const paragraph of paragraphs) {
    let text = '';
    const spans = paragraph.map(atom => {
      if (text && !/\s$/.test(text) && !/^\s|^[,.;:!?)}\]]/.test(atom.text)) text += atom.joinBefore ?? ' ';
      const start = text.length;
      text += atom.text;
      return { atom, start, end: text.length };
    });
    for (const sentence of splitter.segment(text)) {
      const start = sentence.index, end = start + sentence.segment.trimEnd().length;
      const selected = spans.filter(s => s.start < end && s.end > start);
      if (!selected.length || !sentence.segment.trim()) continue;
      const rects = selected.map(s => ({ page, bbox: s.atom.bbox }));
      const sizes = selected.map(s => s.atom.size).filter((s): s is number => !!s && s > 0 && s <= 1000).sort((a,b)=>a-b);
      result.push({ id: `p${page}-${method === 'text' ? 't' : 'o'}2-s${result.length}`, text: sentence.segment.trim(),
        bbox: envelope(rects.map(r=>r.bbox)), schemaVersion: 2, para: paragraph[0].para,
        sourceIds: selected.map(s=>s.atom.id), rects, geometryPrecision: method === 'text' ? 'pdf-item' : 'ocr-word',
        ...(sizes.length ? { size: sizes[Math.floor(sizes.length/2)] } : {}),
      });
    }
  }
  return normalizeSegments(result, page);
}
export function normalizedBox(x: number, y: number, w: number, h: number, width: number, height: number): BBox {
  const clamp = (n: number) => Math.max(0, Math.min(1, Number.isFinite(n) ? n : 0));
  const left = clamp(x / width), top = clamp(y / height);
  return [left, top, Math.max(0, clamp((x + w) / width) - left), Math.max(0, clamp((y + h) / height) - top)];
}
interface TextItem { str: string; transform: number[]; width: number; fontName: string; hasEOL: boolean }
interface TextContent { items: unknown[]; styles: Record<string, { ascent?: number; descent?: number }> }
interface Viewport { transform: number[]; width: number; height: number; scale: number }
/** PDF.js text items -> atoms. Shared by the browser reader and the server import so both
 * produce identical segment IDs and geometry; `transform` is pdf.js Util.transform. */
export function pdfTextAtoms(content: TextContent, viewport: Viewport, transform: (a: number[], b: number[]) => number[], number: number): SourceAtom[] {
  const atoms: SourceAtom[] = [];
  let para = 0;
  let previous: { bbox: BBox; hasEOL: boolean; lineLeft: number } | undefined;
  for (const raw of content.items) {
    if (!raw || typeof raw !== 'object' || !('str' in raw)) continue;
    const item = raw as TextItem;
    if (!item.str.trim()) { if (previous && item.hasEOL) previous.hasEOL = true; continue; }
    const t = transform(viewport.transform, item.transform);
    const height = Math.hypot(t[2], t[3]);
    const angle = Math.atan2(t[1], t[0]);
    const style = content.styles[item.fontName];
    const ascent = (style?.ascent ?? (style?.descent ? 1 + style.descent : 0.8)) * height;
    const x = t[4] + Math.sin(angle) * ascent, y = t[5] - Math.cos(angle) * ascent;
    const width = item.width * viewport.scale;
    const corners = [[x,y], [x + Math.cos(angle)*width,y + Math.sin(angle)*width],
      [x - Math.sin(angle)*height,y + Math.cos(angle)*height],
      [x + Math.cos(angle)*width - Math.sin(angle)*height,y + Math.sin(angle)*width + Math.cos(angle)*height]];
    const xs = corners.map(c => c[0]), ys = corners.map(c => c[1]);
    const bbox = normalizedBox(Math.min(...xs), Math.min(...ys), Math.max(...xs)-Math.min(...xs), Math.max(...ys)-Math.min(...ys), viewport.width, viewport.height);
    // Content-stream order is retained. This conservative grouping is NOT
    // model-derived block/column reading order, and never globally row-sorts.
    let joinBefore = ' ';
    let lineLeft = bbox[0];
    if (previous) {
      const p = previous.bbox;
      const sameBaseline = Math.abs(bbox[1]-p[1]) <= Math.max(bbox[3],p[3])*0.45;
      const gap = bbox[0]-(p[0]+p[2]);
      const nearInline = sameBaseline && gap >= -p[3]*0.4 && gap <= p[3]*2;
      const nearNextLine = previous.hasEOL && bbox[1] > p[1] && bbox[1]-(p[1]+p[3]) <= p[3]*1.2
        && Math.abs(bbox[0]-previous.lineLeft) < Math.max(0.025,p[3]*2);
      if (nearInline) lineLeft = previous.lineLeft;
      if (!nearInline && !nearNextLine) para++;
      if (nearInline && !previous.hasEOL && gap < p[3]*0.15) joinBefore = '';
    }
    atoms.push({ id: `p${number}-t${atoms.length}`, text: item.str, bbox, para: `p${number}-pdf${para}`,
      size: height, joinBefore });
    previous = { bbox, hasEOL: item.hasEOL, lineLeft };
  }
  return atoms;
}
