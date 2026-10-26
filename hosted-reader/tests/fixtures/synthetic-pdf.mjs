// Deterministic synthetic PDFs for import/extraction tests. No real research or user data.
// `node tests/fixtures/synthetic-pdf.mjs <dir>` writes every fixture into <dir>.
import {writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
function build(pageStreams, trailer = '') {
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', null, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>',
    '<< /Type /XObject /Subtype /Image /Width 2 /Height 2 /ColorSpace /DeviceGray /BitsPerComponent 8 /Length 4 >>\nstream\n\x00\xff\xff\x00\nendstream'];
  const kids = [];
  for (const content of pageStreams) {
    const page = objects.length + 1;
    kids.push(`${page} 0 R`);
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents ${page + 1} 0 R /Resources << /Font << /F1 3 0 R >> /XObject << /Im1 4 0 R >> >> >>`);
    objects.push(`<< /Length ${Buffer.byteLength(content, 'latin1')} >>\nstream\n${content}\nendstream`);
  }
  objects[1] = `<< /Type /Pages /Kids [${kids.join(' ')}] /Count ${kids.length} >>`;
  let out = '%PDF-1.4\n%\xe2\xe3\xcf\xd3\n';
  const offsets = [];
  objects.forEach((o, i) => { offsets.push(Buffer.byteLength(out, 'latin1')); out += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const xref = Buffer.byteLength(out, 'latin1');
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map(o => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R${trailer} >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}
const text = lines => 'BT /F1 12 Tf 14 TL 72 720 Td ' + lines.map(l => `(${l}) Tj T*`).join(' ') + ' ET';
export const TWO_PAGE_LINES = [
  ['SYNTHETIC IMPORT FIXTURE ONLY.', 'Plants use light to grow. This synthetic sentence wraps', 'across two lines for geometry checks.'],
  ['Second synthetic page for extraction.', 'It has a second sentence. Nothing here is a real study.'],
];
export const twoPagePdf = () => build(TWO_PAGE_LINES.map(text));
export const manyPagePdf = (n = 12) => build(Array.from({length: n}, (_, i) => text([`Synthetic page ${i + 1} of ${n}.`, 'Batch extraction fixture text only.'])));
// Image-only page: a scanned-style PDF without any text layer.
export const scannedPdf = () => build(['q 400 0 0 500 100 150 cm /Im1 Do Q']);
// 20 pages: 1-16 scanned (no text layer), 17-20 text. A long scanned run ahead of text pages.
export const mixedScanPdf = () => build(Array.from({length: 20}, (_, i) => i < 16 ? 'q 400 0 0 500 100 150 cm /Im1 Do Q' : text([`Synthetic text page ${i + 1} after scans.`])));
// Standard security handler with a user password: pdf.js refuses it without the password.
const hex32 = c => '<' + c.repeat(64) + '>';
export const encryptedPdf = () => build(TWO_PAGE_LINES.map(text), ` /Encrypt << /Filter /Standard /V 1 /R 2 /O ${hex32('a')} /U ${hex32('b')} /P -4 >> /ID [${hex32('c').slice(0, 34)}> ${hex32('c').slice(0, 34)}>]`);
export const fixtures = {'two-page.pdf': twoPagePdf, 'many-page.pdf': manyPagePdf, 'scanned.pdf': scannedPdf, 'mixed-scan.pdf': mixedScanPdf};
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  for (const [name, make] of Object.entries(fixtures)) writeFileSync(join(process.argv[2], name), make());
}
