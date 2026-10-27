import {ApiError} from './papers';
import {checkedContent,sha} from './analysis';
import {PdfFileError,checkFileUrl,downloadPdf,isPdf,pdfName,type FilePolicy} from './pdf-file';
import {BUDGET_MS,extractPage,openPdf,policy} from './pdf-extract';
import {paragraphBatches} from './workflow';
import {generationInstructions} from './upstream-contract';
import type {SourceSegment} from './source-geometry';
/** Ephemeral reading of a PDF attached in ChatGPT. Each call downloads the attachment into this
 * request's memory, extracts the requested pages and returns them; nothing is written to D1 or R2,
 * not even temporarily, and nothing is kept between calls. The caller (ChatGPT) holds the results
 * and the visited-page list. sourceHash is recomputed from the bytes on every render, so the
 * reader never shows source text it was handed. */
const MAX_PAGES=200,PAGE_BATCH=8,MAX_TRANSLATION_CHARS=300000;
export const STORAGE_NOTICE='Sundark did not store this PDF or its text: it was downloaded into memory for this call only and discarded. Translations stay in this ChatGPT conversation; ChatGPT\'s own file retention applies. To keep it in your Sundark library, ask explicitly to save it.';
export class AttachmentError extends ApiError {
 reason:string;host?:string;
 constructor(status:number,reason:string,message:string,host?:string){super(status,`Attachment error (${reason}${host?`, host ${host}`:''}): ${message}`);this.reason=reason;this.host=host}
}
export interface Deps{policy?:FilePolicy;fetcher?:typeof fetch;timeoutMs?:number;budgetMs?:number}
interface Ref{url:URL;fileId:string;fileName:string}
type Segment=SourceSegment;
interface Page{page:number;width:number;height:number;segments:Segment[];sourceHash:string}

function only(a:unknown,keys:string[]):Record<string,unknown>{
 if(a===undefined||a===null)return {};
 if(typeof a!=='object'||Array.isArray(a))throw new AttachmentError(400,'invalid_arguments','Arguments must be an object.');
 const extra=Object.keys(a).filter(k=>!keys.includes(k));
 if(extra.length)throw new AttachmentError(400,'invalid_arguments',`Unknown arguments: ${extra.slice(0,5).join(', ')}. Source text always comes from the attachment itself.`);
 return a as Record<string,unknown>;
}
function reference(raw:unknown,deps:Deps):Ref{
 const f=raw as {download_url?:unknown;file_id?:unknown;file_name?:unknown}|null|undefined;
 if(!f||typeof f!=='object'||Array.isArray(f)||f.download_url===undefined||f.download_url===null||f.download_url==='')throw new AttachmentError(400,'missing','Pass the PDF the user attached in ChatGPT as file, with download_url and file_id.');
 if(typeof f.file_id!=='string'||!f.file_id||f.file_id.length>512)throw new AttachmentError(400,'missing','file.file_id is required: pass the PDF the user attached in ChatGPT as file.');
 let url;try{url=checkFileUrl(f.download_url,deps.policy??policy())}catch(e){throw fileError(e)}
 return {url,fileId:f.file_id,fileName:pdfName(f.file_name)};
}
// Operational diagnostic for the Site owner (error-level Workers logs): which exact host the gate refused. Only the
// validated hostname, never the URL, query, file id, file name or tool arguments.
const SAFE_HOST=/^[a-z0-9.-]{1,253}$/;
function logPolicy(host:unknown){console.error(JSON.stringify({event:'sundark_attachment_policy',reason:'unsupported_host',...(typeof host==='string'&&SAFE_HOST.test(host)?{host}:{})}))}
function fileError(e:unknown){
 if(!(e instanceof PdfFileError))return e;
 if(e.reason==='unsupported_host')logPolicy(e.host);
 return new AttachmentError(e.status,e.reason,e.message,e.reason==='unsupported_host'?e.host:undefined);
}
function pageList(raw:unknown){
 if(!Array.isArray(raw)||!raw.length||raw.length>PAGE_BATCH||raw.some(n=>!Number.isInteger(n)||n<1||n>MAX_PAGES)||new Set(raw).size!==raw.length)throw new AttachmentError(400,'invalid_pages',`Select 1-${PAGE_BATCH} distinct pages between 1 and ${MAX_PAGES}.`);
 return raw as number[];
}
function visited(raw:unknown,name:string){
 if(raw===undefined)return [];
 if(!Array.isArray(raw)||raw.length>MAX_PAGES||raw.some(n=>!Number.isInteger(n)||n<1||n>MAX_PAGES))throw new AttachmentError(400,'invalid_pages',`${name} must list up to ${MAX_PAGES} pages between 1 and ${MAX_PAGES}.`);
 return raw as number[];
}
function language(raw:unknown){
 if(raw===undefined)return 'Korean';
 if(typeof raw!=='string'||!raw.trim()||raw.length>50)throw new AttachmentError(400,'invalid_arguments','language must be text of at most 50 characters.');
 return raw;
}
async function hex(bytes:Uint8Array){return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes as BufferSource))).map(x=>x.toString(16).padStart(2,'0')).join('')}
// Canonical: the original file's digest plus the exact page geometry and segments, in fixed key order.
const pageHash=(pdfSha256:string,p:Omit<Page,'sourceHash'>)=>sha(JSON.stringify({v:'attachment-v1',pdfSha256,page:p.page,width:p.width,height:p.height,segments:p.segments}));
/** Downloads and opens the attachment, runs `run`, and always releases pdf.js. */
async function withPdf<T>(ref:Ref,deps:Deps,run:(o:{pdf:Awaited<ReturnType<typeof openPdf>>['pdf'];doc:NonNullable<Awaited<ReturnType<typeof openPdf>>['doc']>;pdfSha256:string})=>Promise<T>){
 let bytes:Uint8Array|null;
 try{bytes=await downloadPdf(ref.url,{timeoutMs:deps.timeoutMs,fetcher:deps.fetcher})}catch(e){throw fileError(e)}
 if(!isPdf(bytes))throw new AttachmentError(415,'not_pdf','The attachment is not a PDF. Nothing was stored.');
 const pdfSha256=await hex(bytes);
 let opened;try{opened=await openPdf(bytes)}catch{throw new AttachmentError(415,'not_pdf','The attachment is not a readable PDF. Nothing was stored.')}
 bytes=null;
 try{
  if(!opened.doc)throw new AttachmentError(422,'encrypted','This PDF is password-protected; its text cannot be read. Nothing was stored.');
  return await run({pdf:opened.pdf,doc:opened.doc,pdfSha256});
 }finally{await opened.task?.destroy().catch(()=>{})}
}
function batches(pages:Page[],language:string){return pages.flatMap(p=>p.segments.length?paragraphBatches(p.segments).map(b=>({page:p.page,sourceHash:p.sourceHash,language,segmentIds:b.map((s:Segment)=>s.id)})):[])}
// The server is stateless, so the target language must travel with every render.
const flow=(lang:string)=>`Translate the batches in order in ChatGPT, into ${lang}. After each batch, call render_attached_reader with the same file, the page, that page's sourceHash, the same language (${lang}) and translations = every segment of that page translated so far, in exact source order from its first segment. Never send source text as a translation. Nothing is saved unless the user explicitly asks.`;
// attemptedPages/unreadPages arrive from the caller with no proof of which PDF they came from, so
// progress built on them is only caller-reported: complete is true only when this call itself read
// every page, and reportedComplete (what the caller's lists add up to) is never verified.
interface Progress{nextPages:number[];needsOcrPages:number[];failedPages:number[];deferredPages:number[];attemptedPages:number[];unreadPages:number[];complete:boolean;reportedComplete:boolean;progressBasis:'caller-reported'}
const idle:Progress={nextPages:[],needsOcrPages:[],failedPages:[],deferredPages:[],attemptedPages:[],unreadPages:[],complete:false,reportedComplete:false,progressBasis:'caller-reported'};
function result(ref:Ref,numPages:number,page:number,pages:Page[],lang:string,extra:Partial<Progress>&{translations?:{id:string;text:string}[]}){
 const {translations=[],...progress}=extra;
 return {mode:'ephemeral' as const,persistent:false as const,attachment:{fileId:ref.fileId,fileName:ref.fileName,pdfSha256:'',numPages},page,sourceHash:pages.find(p=>p.page===page)?.sourceHash??'',pages,
  translations,...idle,...progress,pageLimit:MAX_PAGES,extractablePages:Math.min(numPages,MAX_PAGES),
  translation:{language:lang,instructions:`${generationInstructions('translation',lang)} ${flow(lang)}`,batches:batches(pages,lang)},storageNotice:STORAGE_NOTICE};
}

/** read_attached_pdf: up to 8 pages (default page 1). nextPages skips every page the caller has
 * attempted, so a whole-document loop ends even across scanned runs; deferred pages were not read
 * and are offered again, even when the caller already listed them as attempted. The caller echoes
 * attemptedPages and unreadPages from each result; reportedComplete is true once those lists and this
 * call cover every page up to the page limit with a text layer. complete is true only when this call
 * read every page of the PDF with a text layer. */
export async function readAttached(raw:unknown,deps:Deps={}){
 const a=only(raw,['file','pages','attemptedPages','unreadPages','language']);
 const ref=reference(a.file,deps);
 const pages=a.pages===undefined?[1]:pageList(a.pages);const attempted=visited(a.attemptedPages,'attemptedPages');const unread=visited(a.unreadPages,'unreadPages');const lang=language(a.language);
 return withPdf(ref,deps,async({pdf,doc,pdfSha256})=>{
  const numPages=doc.numPages;
  if(pages.some(n=>n>numPages))throw new AttachmentError(400,'invalid_pages',`This PDF has ${numPages} pages.`);
  const out:Page[]=[],needsOcrPages:number[]=[],failedPages:number[]=[],deferredPages:number[]=[];const started=Date.now();const budget=deps.budgetMs??BUDGET_MS;
  for(const n of pages){
   // The first page always runs, so every call advances the loop.
   if(n!==pages[0]&&Date.now()-started>budget){deferredPages.push(n);continue}
   let x;try{x=await extractPage(pdf,doc,n)}catch{failedPages.push(n);continue}
   const p={page:n,width:x.width,height:x.height,segments:x.segments};
   out.push({...p,sourceHash:await pageHash(pdfSha256,p)});if(!p.segments.length)needsOcrPages.push(n);
  }
  // A deferred page was not read, even if an earlier call (or attemptedPages) listed it.
  const seen=new Set([...attempted,...pages].filter(n=>n<=numPages&&!deferredPages.includes(n)));
  const all=Array.from({length:Math.min(numPages,MAX_PAGES)},(_,i)=>i+1);
  const remaining=all.filter(n=>!seen.has(n));
  const unreadPages=[...new Set([...unread.filter(n=>seen.has(n)&&!out.some(p=>p.page===n&&p.segments.length)),...needsOcrPages,...failedPages])].sort((x,y)=>x-y);
  const reportedComplete=!remaining.length&&numPages<=MAX_PAGES&&!unreadPages.length;
  // Pages are distinct, so reading numPages of them with text means this call read the whole PDF.
  const complete=numPages<=MAX_PAGES&&out.length===numPages&&out.every(p=>p.segments.length>0);
  const r=result(ref,numPages,pages[0],out,lang,{nextPages:remaining.slice(0,PAGE_BATCH),needsOcrPages,failedPages,deferredPages,attemptedPages:[...seen].sort((x,y)=>x-y),unreadPages,complete,reportedComplete});r.attachment.pdfSha256=pdfSha256;return r;
 });
}

const TASKS=['summary','anatomy','qa','explanation','equation','glossary','review'];
const SHAPES:Record<string,string>={summary:'{text,citations:[{page,segmentId,quote}]}',explanation:'{text,citations:[{page,segmentId,quote}]}',qa:'{question,answer,citations:[{page,segmentId,quote}]}',
 equation:'{latex,explanation,citations:[]}',glossary:'{field,abbreviations:[{term,meaning}],terms:[{term,translation}]} (at most 20 terms)',
 anatomy:'{schemaVersion:2,problem:CARD,gap:CARD,claim:CARD,method:CARD,evidence:{dataset_test:CARD,metric:CARD,baseline:CARD,ablation:CARD},limitations:CARD}; CARD={status:present or not_present,points:[{text,kind:author_stated or synthesis or ai_interpretation,citations:[]}]}',
 review:'{title,paperTitle,authors:[],venue,year:null or integer,tags:[],summary,sections:[{key,heading,text,citations:[]}]} with exactly six keys summary,background,contributions,method,results,limitations'};
// A task covers several pages: its hash is over their page hashes, in the order given.
const taskHash=(pages:Page[])=>sha(JSON.stringify({v:'attachment-task-v1',pages:pages.map(p=>[p.page,p.sourceHash])}));
function taskKind(raw:unknown){if(typeof raw!=='string'||!TASKS.includes(raw))throw new AttachmentError(400,'invalid_arguments',`kind must be one of ${TASKS.join(', ')}; translation uses read_attached_pdf.`);return raw}
function fullPage(p:Page,reason:string){if(!p.segments.length)throw new AttachmentError(400,reason,`Page ${p.page} has no PDF text layer (scanned); its text is never invented.`);return p}
/** Extracts pages of one opened PDF, each at most once per call. */
function pageReader(pdf:Parameters<typeof extractPage>[0],doc:Parameters<typeof extractPage>[1],pdfSha256:string){
 const cache=new Map<number,Promise<Page>>();
 return (n:number)=>{let p=cache.get(n);if(!p){p=(async()=>{if(n>doc.numPages)throw new AttachmentError(400,'invalid_pages',`This PDF has ${doc.numPages} pages.`);let x;try{x=await extractPage(pdf,doc,n)}catch{throw new AttachmentError(422,'extract_failed',`Page ${n} could not be read from the PDF.`)}const q={page:n,width:x.width,height:x.height,segments:x.segments};return {...q,sourceHash:await pageHash(pdfSha256,q)}})();cache.set(n,p)}return p};
}

/** prepare_attachment_task: grounded summary, anatomy, Q&A, explanation, equation, glossary or
 * review over up to 8 pages, generated in ChatGPT and shown with render_attached_reader. */
export async function prepareAttachedTask(raw:unknown,deps:Deps={}){
 const a=only(raw,['file','pages','kind','language','question']);
 const ref=reference(a.file,deps);const kind=taskKind(a.kind);const pages=pageList(a.pages);const lang=language(a.language);
 if(a.question!==undefined&&(typeof a.question!=='string'||!a.question.trim()||a.question.length>10000))throw new AttachmentError(400,'invalid_arguments','question must be text of at most 10000 characters.');
 return withPdf(ref,deps,async({pdf,doc,pdfSha256})=>{
  const read=pageReader(pdf,doc,pdfSha256);const selected:Page[]=[];
  for(const n of pages)selected.push(fullPage(await read(n),'invalid_pages'));
  if(selected.reduce((n,p)=>n+p.segments.reduce((m,s)=>m+s.text.length,0),0)>300000)throw new AttachmentError(413,'invalid_pages','Choose fewer pages; the selected source exceeds 300K characters.');
  const sourceHash=await taskHash(selected);
  const r=result(ref,doc.numPages,pages[0],selected,lang,{});r.attachment.pdfSha256=pdfSha256;
  return {...r,task:{kind,language:lang,...(a.question!==undefined?{question:a.question}:{}),sourcePages:pages,sourceHash,contentShape:SHAPES[kind],
   instructions:`${generationInstructions(kind,lang)} Use only these pages and never claim others were read. Generate the content in ChatGPT, then show it with render_attached_reader (same file, the page the reader shows with that page's sourceHash from read_attached_pdf or this result, analysis={kind,language,sourcePages,sourceHash:task.sourceHash,content}). The analysis covers sourcePages, which may differ from the page shown; say which pages it covers. Citations must exactly quote a segment of a selected page. Nothing is saved unless the user explicitly asks.`}};
 });
}

/** render_attached_reader: one page, source re-extracted from the attachment and checked against
 * sourceHash. Translations must be a prefix of the page's segments in exact order. An optional
 * analysis is checked against its own pages' hashes and the saved-analysis validators. */
export async function renderAttached(raw:unknown,deps:Deps={}){
 const a=only(raw,['file','page','sourceHash','translations','language','analysis']);
 const ref=reference(a.file,deps);
 const page=a.page;if(!Number.isInteger(page)||(page as number)<1||(page as number)>MAX_PAGES)throw new AttachmentError(400,'invalid_pages',`page must be between 1 and ${MAX_PAGES}.`);
 if(typeof a.sourceHash!=='string'||!/^[0-9a-f]{64}$/.test(a.sourceHash))throw new AttachmentError(409,'source_changed','sourceHash must be the one read_attached_pdf returned for this page.');
 if(a.translations!==undefined&&!Array.isArray(a.translations))throw new AttachmentError(400,'invalid_translation','translations must be an array of {id,text}.');
 const lang=language(a.language);const given=(a.translations??[]) as {id?:unknown;text?:unknown}[];
 let wanted:{kind:string;language:string;sourcePages:number[];sourceHash:string;content:unknown}|undefined;
 if(a.analysis!==undefined){
  const x=only(a.analysis,['kind','language','sourcePages','sourceHash','content']);
  if(typeof x.sourceHash!=='string'||!/^[0-9a-f]{64}$/.test(x.sourceHash))throw new AttachmentError(409,'source_changed','analysis.sourceHash must be the task sourceHash from prepare_attachment_task.');
  wanted={kind:taskKind(x.kind),language:x.language===undefined?lang:language(x.language),sourcePages:pageList(x.sourcePages),sourceHash:x.sourceHash,content:x.content};
 }
 return withPdf(ref,deps,async({pdf,doc,pdfSha256})=>{
  const read=pageReader(pdf,doc,pdfSha256);const p=await read(page as number);
  if(p.sourceHash!==a.sourceHash)throw new AttachmentError(409,'source_changed','The attachment or page differs from the one read. Call read_attached_pdf for this page again and translate from its result.');
  const translations=checkTranslations(given,p,lang,a.language===undefined);
  const r=result(ref,doc.numPages,p.page,[p],lang,{translations,needsOcrPages:p.segments.length?[]:[p.page]});r.attachment.pdfSha256=pdfSha256;
  if(!wanted)return r;
  const sources:Page[]=[];for(const n of wanted.sourcePages)sources.push(await read(n));
  if(await taskHash(sources)!==wanted.sourceHash)throw new AttachmentError(409,'source_changed','The analysis source differs from the pages prepared. Call prepare_attachment_task again and regenerate.');
  let content;try{content=checkedContent(wanted.kind,wanted.content,{pages:sources},wanted.language)}catch(e){throw e instanceof ApiError?new AttachmentError(400,'invalid_analysis',e.message):e}
  if(new TextEncoder().encode(JSON.stringify(content)).length>300000)throw new AttachmentError(413,'invalid_analysis','Analysis exceeds 300 KB.');
  // A document-level analysis may cover other pages than the one shown; the reader labels its scope.
  return {...r,analysis:{kind:wanted.kind,language:wanted.language,sourcePages:wanted.sourcePages,sourceHash:wanted.sourceHash,coversShownPage:wanted.sourcePages.includes(p.page),content}};
 });
}
function checkTranslations(given:{id?:unknown;text?:unknown}[],p:{page:number;segments:Segment[]},lang:string,defaulted:boolean){
 const bad=(m:string)=>new AttachmentError(400,'invalid_translation',m);
 if(given.length>p.segments.length)throw bad('More translations than source segments on this page.');
 given.forEach((x,i)=>{if(!x||typeof x!=='object'||x.id!==p.segments[i].id)throw bad('Translation IDs must follow exact source order from the page\'s first segment, without gaps or repeats.')});
 if(given.reduce((n,x)=>n+(typeof x.text==='string'?x.text.length:0),0)>MAX_TRANSLATION_CHARS)throw bad('Translations exceed 300K characters; render fewer segments.');
 // The saved-translation rules (nonempty, bounded, not left in the source language), 40 at a time.
 const out:{id:string;text:string}[]=[];
 for(let i=0;i<given.length;i+=40){
  try{out.push(...(checkedContent('translation',{scope:'batch',segments:given.slice(i,i+40)},{pages:[p]},lang) as {segments:{id:string;text:string}[]}).segments)}
  catch(e){throw e instanceof ApiError?bad(defaulted?`${e.message} language was not given and defaults to Korean: pass the language from read_attached_pdf (translation.language).`:e.message):e}
 }
 return out;
}

/** Raw bytes per read_attachment_original call (about 2.8 MB as base64). */
export const ORIGINAL_CHUNK=2*1024*1024;
/** read_attachment_original: app-only. The reader view fetches the original PDF through the host
 * bridge instead of the browser, one aligned slice per call. Each call downloads the whole file
 * into memory again (nothing is stored or cached), and returns bytes only when they are a PDF whose
 * SHA-256 equals pdfSha256, the digest read_attached_pdf returned. That digest is caller-supplied:
 * it proves consistency with the translated bytes, not authorization or prior possession; the
 * file reference passes the same gate as read_attached_pdf. App-only visibility is the host's to
 * enforce: the route authenticates the user, not whether the view or the model called. The slice
 * goes in meta, which the route puts in the result _meta for the view alone; data holds only small
 * numbers. */
export async function readAttachedOriginal(raw:unknown,deps:Deps={}){
 const a=only(raw,['file','pdfSha256','offset']);
 if(typeof a.pdfSha256!=='string'||!/^[0-9a-f]{64}$/.test(a.pdfSha256))throw new AttachmentError(400,'invalid_arguments','pdfSha256 must be the attachment.pdfSha256 read_attached_pdf returned.');
 const offset=a.offset;
 if(!Number.isInteger(offset)||(offset as number)<0||(offset as number)%ORIGINAL_CHUNK!==0)throw new AttachmentError(400,'invalid_arguments',`offset must be a non-negative multiple of ${ORIGINAL_CHUNK}.`);
 const ref=reference(a.file,deps);
 let bytes:Uint8Array;
 try{bytes=await downloadPdf(ref.url,{timeoutMs:deps.timeoutMs,fetcher:deps.fetcher})}catch(e){throw fileError(e)}
 if(!isPdf(bytes))throw new AttachmentError(415,'not_pdf','The attachment is not a PDF. Nothing was stored.');
 if(await hex(bytes)!==a.pdfSha256)throw new AttachmentError(409,'source_changed','The attachment differs from the one read. Nothing was returned.');
 const total=bytes.length,start=offset as number;
 if(start>=total)throw new AttachmentError(400,'invalid_arguments',`offset must be below the file size of ${total} bytes.`);
 const slice=bytes.subarray(start,Math.min(start+ORIGINAL_CHUNK,total));
 let binary='';for(let i=0;i<slice.length;i+=8192)binary+=String.fromCharCode(...slice.subarray(i,i+8192));
 return {data:{fileId:ref.fileId,pdfSha256:a.pdfSha256,offset:start,length:slice.length,total,done:start+slice.length===total},meta:{'sundark/originalChunk':btoa(binary)}};
}

/** open_pdf_file: the app-only PDF file entrypoint. The host injects {file:{name,resourceUri}} and
 * the reader view reads that resource through the host; the server downloads nothing, stores nothing
 * and does not echo the resource URI. Like the SDK's non-strict input schema, other top-level keys
 * the host adds are ignored; the file itself is still checked. */
export function attachmentFileEntrypoint(raw:unknown){
 if(raw!==undefined&&raw!==null&&(typeof raw!=='object'||Array.isArray(raw)))throw new AttachmentError(400,'invalid_arguments','Arguments must be an object.');
 const f=(raw as {file?:unknown}|null|undefined)?.file as {name?:unknown;resourceUri?:unknown}|undefined;
 if(!f||typeof f!=='object'||Array.isArray(f)||typeof f.name!=='string'||!f.name||typeof f.resourceUri!=='string'||!f.resourceUri.trim())throw new AttachmentError(400,'missing','Open a PDF file in ChatGPT with Sundark; the file entrypoint passes file.name and file.resourceUri.');
 return {...attachmentLauncher(),fileEntrypoint:{fileName:pdfName(f.name)},prompt:'The reader opens this PDF from ChatGPT. Ask to translate it, or for a summary; Sundark stores nothing.'};
}

/** open_attachment_reader: the empty-args launcher. It cannot read a file by itself. */
export function attachmentLauncher(){
 return {mode:'ephemeral' as const,persistent:false as const,attachment:null,page:null,sourceHash:'',pages:[],translations:[],...idle,pageLimit:MAX_PAGES,extractablePages:0,
  translation:{language:'Korean',instructions:'',batches:[]},storageNotice:STORAGE_NOTICE,
  prompt:'Attach a PDF in ChatGPT and ask to read or translate it; Sundark then reads it without saving it.'};
}
