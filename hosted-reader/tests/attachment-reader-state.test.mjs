// Pure reader state for the ephemeral attachment reader: ordering, merging, widget state,
// exports and restore validation. Synthetic data only.
import assert from 'node:assert/strict';
import {register} from 'node:module';
import test from 'node:test';

register('./fixtures/worker-loader.mjs', import.meta.url);
const S = await import('../client/attachment-reader/state.ts');

const sha = 'a'.repeat(64), other = 'b'.repeat(64);
const seg = (page, i, text = `Sentence ${i} on page ${page}.`) => ({id: `p${page}-t2-s${i}`, text, bbox: [0.1, 0.1 + i * 0.05, 0.5, 0.04]});
const output = (extra = {}) => ({mode: 'ephemeral', persistent: false, attachment: {fileId: 'file-1', fileName: 'paper.pdf', pdfSha256: sha, numPages: 3},
  page: 1, sourceHash: 'h', pages: [{page: 1, width: 612, height: 792, segments: [seg(1, 0), seg(1, 1), seg(1, 2)]}], translations: [], ...extra});
const doc = (...outs) => outs.reduce((d, o) => S.merge(d, S.parseOutput(o)), S.emptyDoc());

test('only a contiguous translation prefix is shown, across pages', () => {
  const d = doc(output({translations: [{id: 'p1-t2-s0', text: '하나'}, {id: 'p1-t2-s2', text: '셋'}]}),
    output({pages: [{page: 2, width: 612, height: 792, segments: [seg(2, 0)]}], translations: [{id: 'p2-t2-s0', text: '둘째 쪽'}]}));
  const f = S.frontier(d);
  assert.deepEqual([...f.shown], ['p1-t2-s0']);
  assert.equal(f.total, 4);
  const {received, numPages, translated, total, readable} = S.progress(d);
  assert.deepEqual({received, numPages, translated, total, readable}, {received: 2, numPages: 3, translated: 1, total: 4, readable: 2});
  const md = S.exportMarkdown(d);
  assert.match(md, /하나/);
  assert(!md.includes('셋') && !md.includes('둘째 쪽'), 'translations after a gap are not exported either');
});

test('merge: unknown ids are ignored, a new attachment starts over, changed pages drop old translations', () => {
  let d = doc(output({translations: [{id: 'p1-t2-s0', text: '하나'}, {id: 'p9-t2-s0', text: 'stray'}]}));
  assert.equal(d.translations.size, 1);
  const changed = S.merge(d, S.parseOutput(output({pages: [{page: 1, width: 612, height: 792, segments: [seg(1, 0, 'Different.'), {...seg(1, 7)}]}]})));
  assert.equal(changed.translations.get('p1-t2-s0'), undefined, 'segment list changed: old translations dropped');
  const same = S.merge(d, S.parseOutput(output()));
  assert.equal(same.translations.get('p1-t2-s0'), '하나', 'same segments keep their translations');
  d = S.merge(d, S.parseOutput(output({attachment: {fileId: 'file-2', fileName: 'x.pdf', pdfSha256: other, numPages: 1}})));
  assert.equal(d.translations.size, 0);
  assert.equal(d.attachment.pdfSha256, other);
  // The launcher result (attachment null) keeps the current reading.
  const kept = S.merge(same, S.parseOutput({mode: 'ephemeral', persistent: false, attachment: null, page: null, pages: [], translations: [], prompt: 'Attach'}));
  assert.equal(kept.attachment.fileId, 'file-1');
});

test('tool results are validated, never trusted', () => {
  assert.throws(() => S.parseOutput({...output(), persistent: true}), /ephemeral/);
  assert.throws(() => S.parseOutput({...output(), mode: 'saved'}), /ephemeral/);
  assert.throws(() => S.parseOutput(output({pages: [{page: 1, width: 612, height: 792, segments: [{id: 'x', text: 't', bbox: [0, 0, 2, 2]}]}]})), /rectangle/);
  assert.throws(() => S.parseOutput(output({attachment: {fileId: 'f', pdfSha256: 'nothex'}})), /PDF/);
  assert.throws(() => S.parseOutput(null));
});

test('widget state holds only a small reference', () => {
  const d = doc(output({translations: [{id: 'p1-t2-s0', text: '하나'.repeat(5000)}]}));
  const state = S.widgetState(d, 1, 'p1-t2-s0');
  const json = JSON.stringify(state);
  assert(new TextEncoder().encode(json).length < 1024, json);
  assert.deepEqual(state, {v: 1, page: 1, seg: 'p1-t2-s0', file: {id: 'file-1', sha}});
  assert(!/Sentence|하나|https?:/.test(json));
  assert.deepEqual(S.readWidgetState(state, d), {page: 1, seg: 'p1-t2-s0'});
  assert.equal(S.readWidgetState({...state, file: {id: 'file-9', sha: other}}, d), null, 'state of another file is ignored');
  assert.equal(S.readWidgetState({v: 2}, d), null);
});

test('safe export file names', () => {
  assert.equal(S.safeFilename('../../etc/passwd.pdf', '.md'), 'etc_passwd.md');
  assert.equal(S.safeFilename('논문: 확산 모델?.PDF', '-sundark.json'), '논문_ 확산 모델-sundark.json');
  assert.equal(S.safeFilename('...', '.md'), 'sundark-paper.md');
  assert.equal(S.safeFilename('a'.repeat(300) + '.pdf', '.md').length, 83);
  assert(!/[\\/:*?"<>|\u0000-\u001f]/.test(S.safeFilename('a\u0000b<c>|d\\e.pdf', '.md')));
});

test('export JSON round-trips through the validator; bad files are refused', () => {
  const d = doc(output({translations: [{id: 'p1-t2-s0', text: '하나'}]}));
  d.analysis.push({kind: 'summary', language: 'Korean', sourcePages: [1], title: '요약', text: '합성 요약'});
  const json = S.exportJson(d);
  assert(!json.includes('file-1'), 'the ChatGPT file id is not exported');
  const back = S.restoreJson(json);
  assert.deepEqual([...S.frontier(back).shown], ['p1-t2-s0']);
  assert.equal(back.analysis[0].text, '합성 요약');
  assert.equal(back.attachment.pdfSha256, sha);
  assert.throws(() => S.restoreJson('{'), /JSON/);
  assert.throws(() => S.restoreJson(JSON.stringify({format: 'other', version: 1})), /Sundark/);
  const bad = JSON.parse(json); bad.pages[0].segments[0].bbox = [0, 0, 5, 5];
  assert.throws(() => S.restoreJson(JSON.stringify(bad)), /rectangle/);
  assert.throws(() => S.restoreJson(' '.repeat(4 * 1024 * 1024 + 1)), /4MB/);
});

test('analysis results flatten by kind; unknown shapes show nothing', () => {
  assert.equal(S.analysisText('summary', {text: '요약', citations: []}), '요약');
  assert.equal(S.analysisText('qa', {question: '왜?', answer: '그래서.', citations: []}), 'Q. 왜?\n\n그래서.');
  const card = s => ({status: 'present', points: [{text: s, kind: 'author_stated', citations: []}]});
  const anatomy = S.analysisText('anatomy', {schemaVersion: 2, problem: card('P'), gap: {status: 'not_present', points: []}, claim: card('C'), method: card('M'),
    evidence: {dataset_test: card('D'), metric: card('X'), baseline: card('B'), ablation: card('A')}, limitations: card('L')});
  assert.match(anatomy, /^문제\n- P\n공백: 논문에 없음\n주장\n- C/);
  assert.equal(S.analysisText('made-up', {text: 'x'}), '');
  const d = doc(output({analysis: {kind: 'qa', language: 'Korean', sourcePages: [1], sourceHash: 'h', content: {question: 'q1', answer: 'a1'}}}),
    output({analysis: {kind: 'qa', language: 'Korean', sourcePages: [1], sourceHash: 'h', content: {question: 'q2', answer: 'a2'}}}),
    output({analysis: {kind: 'summary', sourcePages: [1], content: {text: 's1'}}}), output({analysis: {kind: 'summary', sourcePages: [1], content: {text: 's2'}}}));
  assert.deepEqual(d.analysis.map(a => [a.kind, a.text]), [['qa', 'Q. q1\n\na1'], ['qa', 'Q. q2\n\na2'], ['summary', 's2']]);
});

// The read-progress contract of read_attached_pdf: attemptedPages/unreadPages are echoed
// cumulatively, and complete is believed only when this reader agrees.
const page = (n, segs = [seg(n, 0)]) => ({page: n, width: 612, height: 792, segments: segs});
const read = (pages, extra = {}) => output({page: pages[0], pages: pages.map(n => page(n)), attemptedPages: pages, unreadPages: [], nextPages: [], complete: false, pageLimit: 200, extractablePages: 3, ...extra});

test('complete is never shown for scanned, failed, deferred or truncated documents', () => {
  const claim = extra => doc(read([1, 2, 3], {complete: true, ...extra})).complete;
  assert.equal(claim({}), true, 'every page read with text');
  assert.equal(claim({pages: [page(1), page(2, []), page(3)], needsOcrPages: [2], unreadPages: [2]}), false, 'scanned page');
  assert.equal(claim({pages: [page(1), page(3)], failedPages: [2], unreadPages: [2]}), false, 'failed page');
  assert.equal(claim({pages: [page(1), page(3)], unreadPages: [2]}), false, 'an earlier unread page the server still lists');
  assert.equal(claim({deferredPages: [3], attemptedPages: [1, 2]}), false, 'deferred page');
  assert.equal(claim({pages: [page(1), page(3)], attemptedPages: [1, 3]}), false, 'a page never attempted');
  const big = output({attachment: {fileId: 'file-1', fileName: 'paper.pdf', pdfSha256: sha, numPages: 250}});
  const truncated = doc({...read([1]), attachment: big.attachment, attemptedPages: Array.from({length: 200}, (_, i) => i + 1), complete: true, extractablePages: 200});
  assert.equal(truncated.complete, false, 'pages beyond the limit were never read');
  const p = S.progress(truncated);
  assert.equal(p.beyondLimit, 50);
  assert.equal(p.extractable, 200);
  // Without the server's verified claim, only pages this reader holds with text count.
  assert.equal(claim({complete: false}), true, 'the reader holds every page with text');
  assert.equal(claim({complete: false, pages: [page(3)]}), false, 'pages only the caller reported as read');
  const reported = doc(read([3], {attemptedPages: [1, 2, 3], complete: false, reportedComplete: true}));
  assert.deepEqual([reported.complete, reported.reportedComplete], [false, true], 'caller-reported progress is not completion');
  assert.equal(doc(output({pages: [page(1), page(2)]})).complete, false, 'an older server, page 3 never received');
});

test('read progress is cumulative and only read results move the loop', () => {
  let d = doc(read([1, 2], {pages: [page(1), page(2, [])], needsOcrPages: [2], unreadPages: [2], nextPages: [3]}));
  assert.deepEqual([d.attemptedPages, d.unreadPages, d.nextPages], [[1, 2], [2], [3]]);
  // A render result carries attemptedPages [] and complete false: it must not reset the loop.
  d = S.merge(d, S.parseOutput(output({attemptedPages: [], unreadPages: [], nextPages: [], complete: false, translations: [{id: 'p1-t2-s0', text: '하나'}]})));
  assert.deepEqual([d.attemptedPages, d.unreadPages, d.nextPages], [[1, 2], [2], [3]]);
  // The next read echoes them; the server's cumulative lists win, a deferred page is not attempted.
  d = S.merge(d, S.parseOutput(read([3], {attemptedPages: [1, 2, 3], unreadPages: [2], complete: false})));
  assert.deepEqual([d.attemptedPages, d.unreadPages], [[1, 2, 3], [2]]);
  assert.equal(d.complete, false, 'page 2 is still unread');
  const deferred = S.merge(doc(read([1])), S.parseOutput(read([2], {attemptedPages: [1], deferredPages: [3], nextPages: [3]})));
  assert(!deferred.attemptedPages.includes(3));
  // A later read that finds text on a once-unread page clears it.
  const fixed = S.merge(d, S.parseOutput(read([2], {attemptedPages: [1, 2, 3], unreadPages: [], complete: true})));
  assert.deepEqual(fixed.unreadPages, []);
  assert.equal(fixed.complete, true);
  // A render that finds no text layer on its page marks it unread and withdraws complete.
  const ocr = S.merge(fixed, S.parseOutput(output({page: 3, pages: [page(3, [])], attemptedPages: [], needsOcrPages: [3]})));
  assert.deepEqual(ocr.unreadPages, [3]);
  assert.equal(ocr.complete, false);
});

test('translation language and batch languages survive render and export', () => {
  const ja = {language: 'Japanese', batches: [{page: 1, sourceHash: 'h', language: 'Japanese', segmentIds: ['p1-t2-s0']}]};
  let d = doc(read([1], {translation: ja}));
  assert.equal(d.language, 'Japanese');
  assert.deepEqual(d.batches.map(b => b.language), ['Japanese']);
  d = S.merge(d, S.parseOutput(output({translation: {...ja, batches: []}, translations: [{id: 'p1-t2-s0', text: '一つ'}]})));
  assert.equal(d.language, 'Japanese');
  assert.deepEqual(d.batches.map(b => b.language), ['Japanese'], 'a result without batches keeps the last ones');
  assert.equal(d.translations.get('p1-t2-s0'), '一つ');
  // The launcher's default language never overrides a reading.
  d = S.merge(d, S.parseOutput({mode: 'ephemeral', persistent: false, attachment: null, page: null, pages: [], translations: [], translation: {language: 'Korean', batches: []}}));
  assert.equal(d.language, 'Japanese');
  // Batches alone name the language when translation.language is absent.
  assert.equal(doc(read([1], {translation: {batches: [{page: 1, language: 'French', segmentIds: []}]}})).language, 'French');
  // Exported and restored with its language; Markdown names it.
  const back = S.restoreJson(S.exportJson(d));
  assert.equal(back.language, 'Japanese');
  assert.equal(back.translations.get('p1-t2-s0'), '一つ');
  assert.match(S.exportMarkdown(d), /Translation language: Japanese/);
  // A different language never mixes into the same frontier.
  const ko = S.merge(d, S.parseOutput(output({translation: {language: 'Korean', batches: []}, translations: []})));
  assert.equal(ko.translations.size, 0);
  assert.equal(ko.language, 'Korean');
});

test('analysis keeps its source pages and whether it covers the shown page', () => {
  const d = doc(output({page: 1, analysis: {kind: 'summary', language: 'English', sourcePages: [2, 3], sourceHash: 'h', coversShownPage: false, content: {text: 'Document summary.', citations: []}}}));
  assert.deepEqual(d.analysis.map(a => [a.sourcePages, a.coversShownPage, a.language]), [[[2, 3], false, 'English']]);
  assert.match(S.exportMarkdown(d), /## 요약 \(source pages 2, 3\)/);
});
