import {ApiError,database,bucket,owned} from './papers';
import {siteUrl,fileVersion} from './analysis';
import {checkFileUrl,downloadPdf,isPdf,pdfName} from './pdf-file';
import {asApiError,createPdfPaper,libraryRoom,sha256Hex} from './pdf-store';
import {savePageContent} from './page-content';
import {BUDGET_MS,extractPage,openPdf,policy,type Doc,type Pdf} from './pdf-extract';
/** ChatGPT attachment -> private library, without a Site visit. Text comes only from the PDF's
 * own text layer through the browser reader's pdf.js atom/sentence rules: no OCR, no layout
 * model, no server AI. Extraction runs in small page batches so a long PDF finishes over
 * repeated extract_paper_pages calls, and a failure never removes the stored original. */
export const IMPORT_BATCH=4,EXTRACT_BATCH=8,MAX_PAGES=200;
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
type Row=Record<string,unknown>;
interface FileRef{download_url?:unknown;file_id?:unknown;file_name?:unknown}
async function savedPages(owner:string,p:Row){return ((await database().prepare('SELECT page FROM page_contents WHERE owner=? AND paper_id=? AND file_version=? ORDER BY page').bind(owner,p.id,fileVersion(p)).all()).results as {page:number}[]).map(r=>r.page)}
interface Run{savedPages:number[];alreadySavedPages:number[];needsOcrPages:number[];failedPages:number[];deferredPages:number[];error?:string}
const emptyRun=():Run=>({savedPages:[],alreadySavedPages:[],needsOcrPages:[],failedPages:[],deferredPages:[]});
type Outcome='needs_ocr'|'failed'|'encrypted';
// Terminal outcomes persist per file version, so nextPages never offers a scanned or failed page
// again (a long scanned run once cycled forever) and a replay reports them. Page 0 = whole file.
async function outcomes(owner:string,p:Row){return new Map(((await database().prepare('SELECT page,outcome FROM page_outcomes WHERE owner=? AND paper_id=? AND file_version=?').bind(owner,p.id,fileVersion(p)).all()).results as {page:number;outcome:Outcome}[]).map(r=>[r.page,r.outcome]))}
async function recordOutcome(owner:string,p:Row,page:number,outcome:Outcome){const version=fileVersion(p);await database().prepare('INSERT INTO page_outcomes(id,paper_id,owner,file_version,page,outcome,updated_at) SELECT ?,?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM papers WHERE id=? AND owner=? AND file_key IS ?) ON CONFLICT(id) DO UPDATE SET outcome=excluded.outcome,updated_at=excluded.updated_at').bind(`${p.id}:${version}:${page}`,p.id,owner,version,page,outcome,new Date().toISOString(),p.id,owner,p.file_key).run()}
async function status(owner:string,p:Row,numPages:number|null,run:Run,encrypted=false){
 const extracted=await savedPages(owner,p);const have=new Set(extracted);const extractable=numPages===null?0:Math.min(numPages,MAX_PAGES);
 const missing=Array.from({length:extractable},(_,i)=>i+1).filter(n=>!have.has(n));const known=await outcomes(owner,p);
 for(const n of run.needsOcrPages)known.set(n,'needs_ocr');for(const n of run.failedPages)known.set(n,'failed');
 const needsOcrPages=missing.filter(n=>known.get(n)==='needs_ocr'),failedPages=missing.filter(n=>known.get(n)==='failed');
 return {paperId:p.id,fileVersion:fileVersion(p),numPages,extractablePages:extractable,extractedPages:extracted,missingPages:missing,nextPages:missing.filter(n=>!known.has(n)).slice(0,EXTRACT_BATCH),complete:numPages!==null&&numPages<=MAX_PAGES&&!missing.length,encrypted:encrypted||known.get(0)==='encrypted',...run,needsOcrPages,failedPages,
  ...(numPages!==null&&numPages>MAX_PAGES?{pageLimit:`Only pages 1-${MAX_PAGES} of ${numPages} can be extracted.`}:{}),
  ...(needsOcrPages.length?{ocr:'needsOcrPages have no PDF text layer (scanned). Their text was not invented; OCR runs only in the Site reader.'}:{}),
  readerUrl:`${siteUrl}/?paper=${p.id}`};
}
async function extractInto(owner:string,p:Row,pdf:Pdf,doc:Doc,pages:number[]){
 const run=emptyRun();const have=new Set(await savedPages(owner,p));const started=Date.now();
 for(const n of pages){
  if(have.has(n)){run.alreadySavedPages.push(n);continue}
  if(run.error||Date.now()-started>BUDGET_MS){run.deferredPages.push(n);continue}
  let width=0,height=0,segments;
  try{({width,height,segments}=await extractPage(pdf,doc,n))}catch{run.failedPages.push(n);continue}
  if(!segments.length){run.needsOcrPages.push(n);continue}
  // Insert-only: a page the reader saved meanwhile (OCR or a correction) is never replaced.
  try{const saved=await savePageContent(owner,p,n,{method:'text',confidence:100,width,height,segments},{insertOnly:true});(saved.saved?run.savedPages:run.alreadySavedPages).push(n)}
  catch(e){if(e instanceof ApiError&&e.status===409){const current=await database().prepare('SELECT 1 FROM papers WHERE id=? AND owner=? AND file_key IS ?').bind(p.id,owner,p.file_key).first();run.error=current?'Extracted text was not saved: the 50 MiB extracted-text limit was reached.':'Extracted text was not saved: the PDF was replaced. Call extract_paper_pages again for the new file.';run.deferredPages.push(n)}else run.failedPages.push(n)}
 }
 for(const n of run.needsOcrPages)await recordOutcome(owner,p,n,'needs_ocr');
 for(const n of run.failedPages)await recordOutcome(owner,p,n,'failed');
 return run;
}
function summary(p:Row){return {paperId:p.id,title:p.title,fileName:p.file_name,fileVersion:fileVersion(p),size:p.size,sha256:p.file_sha256,numPages:p.page_count}}
const NEXT='Call extract_paper_pages with extraction.nextPages until the requested pages are extracted or nextPages is empty (needsOcrPages and failedPages are never offered again), then prepare_paper_task(kind translation), translate in ChatGPT, save_paper_analysis contiguous batches until each page is complete, and render_paper_reader. Never report partial extraction or translation as the whole document.';
async function replay(owner:string,row:Row,fileHash:string){
 if(row.import_file_hash!==fileHash)throw new ApiError(409,'This requestId was already used for a different attachment. Nothing was saved; use a new UUID for a new import.');
 const p=await owned(owner,String(row.id));return {...summary(p),idempotent:true,extraction:await status(owner,p,p.page_count as number|null,emptyRun()),readerUrl:`${siteUrl}/?paper=${p.id}`,next:NEXT};
}
const prior=(owner:string,requestId:string)=>database().prepare('SELECT * FROM papers WHERE owner=? AND import_request_id=?').bind(owner,requestId).first();
export async function importPdf(owner:string,a:{requestId?:unknown;file?:unknown;title?:unknown}){
 if(typeof a.requestId!=='string'||!UUID.test(a.requestId))throw new ApiError(400,'requestId must be a new UUID for this attachment; reuse it only to retry the same attachment.');
 const f=a.file as FileRef|null|undefined;if(!f||typeof f!=='object'||typeof f.file_id!=='string'||!f.file_id||f.file_id.length>512)throw new ApiError(400,'Attach the PDF in ChatGPT: file.download_url and file.file_id are required.');
 if(a.title!==undefined&&(typeof a.title!=='string'||a.title.length>500))throw new ApiError(400,'title must be text of at most 500 characters.');
 const requestId=a.requestId.toLowerCase();const fileHash=await sha256Hex(new TextEncoder().encode(f.file_id));
 // A retry never downloads again: the requestId and the file_id fingerprint decide.
 const before=await prior(owner,requestId);if(before)return replay(owner,before,fileHash);
 let url;try{url=checkFileUrl(f.download_url,policy())}catch(e){throw asApiError(e)}
 await libraryRoom(owner,0);
 const bytes=await downloadPdf(url).catch(e=>{throw asApiError(e)});
 if(!isPdf(bytes))throw new ApiError(415,'The attachment is not a PDF. Nothing was saved.');
 await libraryRoom(owner,bytes.length);
 const opened=await openPdf(bytes);
 try{
  const name=pdfName(f.file_name);const title=(typeof a.title==='string'&&a.title.trim())||name.replace(/\.pdf$/i,'').trim()||'Untitled PDF';
  const id=await createPdfPaper(owner,{title,name,bytes,sha256:await sha256Hex(bytes),pages:opened.doc?opened.doc.numPages:null,requestId,fileHash});
  if(!id){const row=await prior(owner,requestId);if(!row)throw new ApiError(409,'A concurrent import is in progress. Retry with the same requestId.');return replay(owner,row,fileHash)}
  const p=await owned(owner,id);let extraction;
  if(!opened.doc){await recordOutcome(owner,p,0,'encrypted');extraction=await status(owner,p,null,{...emptyRun(),error:'This PDF is password-protected; its text cannot be extracted. The original PDF is saved.'},true)}
  else{const first=Array.from({length:Math.min(IMPORT_BATCH,opened.doc.numPages,MAX_PAGES)},(_,i)=>i+1);let run;try{run=await extractInto(owner,p,opened.pdf,opened.doc,first)}catch{run={...emptyRun(),error:'Text extraction failed. The original PDF is saved.'}}extraction=await status(owner,p,opened.doc.numPages,run)}
  return {...summary(p),idempotent:false,extraction,readerUrl:`${siteUrl}/?paper=${p.id}`,next:NEXT};
 }finally{await opened.task?.destroy().catch(()=>{})}
}
export async function extractPages(owner:string,a:{id?:unknown;pages?:unknown}){
 const pages=a.pages;
 if(!Array.isArray(pages)||!pages.length||pages.length>EXTRACT_BATCH||pages.some((n:unknown)=>!Number.isInteger(n)||(n as number)<1||(n as number)>MAX_PAGES)||new Set(pages).size!==pages.length)throw new ApiError(400,`Select 1-${EXTRACT_BATCH} distinct pages between 1 and ${MAX_PAGES} per call.`);
 const p=await owned(owner,String(a.id||''));if(!p.file_key)throw new ApiError(409,'This paper has no stored PDF to extract.');
 const object=await bucket().get(String(p.file_key));if(!object)throw new ApiError(404,'The stored PDF was not found.');
 const opened=await openPdf(new Uint8Array(await object.arrayBuffer()));
 try{
  if(!opened.doc)throw new ApiError(422,'This PDF is password-protected; its text cannot be extracted. The original PDF stays saved.');
  const numPages=opened.doc.numPages;if(pages.some((n:number)=>n>numPages))throw new ApiError(400,`This PDF has ${numPages} pages.`);
  if(p.page_count!==numPages)await database().prepare('UPDATE papers SET page_count=? WHERE id=? AND owner=? AND file_key IS ?').bind(numPages,p.id,owner,p.file_key).run();
  return await status(owner,p,numPages,await extractInto(owner,p,opened.pdf,opened.doc,pages));
 }finally{await opened.task?.destroy().catch(()=>{})}
}
