import {env} from 'cloudflare:workers';
import {ApiError} from './papers';
import {fileHosts} from './pdf-file';
import {buildSentenceSegments,pdfTextAtoms} from './source-geometry';
/** Server pdf.js text-layer extraction shared by the saved import and the ephemeral attachment
 * reader. Pure: it reads bytes and returns pages, and never touches D1 or R2. */
export const BUDGET_MS=15000;
type Pdf=typeof import('pdfjs-dist/legacy/build/pdf.mjs');
export type Doc=Awaited<ReturnType<Pdf['getDocument']>['promise']>;
export type {Pdf};
let engine:Promise<Pdf>|undefined;
// Legacy build with pdf.js's in-thread "fake worker": no Web Worker, no network fetch.
// @ts-expect-error pdfjs-dist ships no type declarations for its worker entry.
function serverPdf(){return engine??=Promise.all([import('pdfjs-dist/legacy/build/pdf.mjs'),import('pdfjs-dist/legacy/build/pdf.worker.mjs')]).then(([pdf,worker])=>{(globalThis as {pdfjsWorker?:unknown}).pdfjsWorker??=worker;return pdf})}
export async function openPdf(bytes:Uint8Array){
 const pdf=await serverPdf();
 // A copy: pdf.js takes ownership of the buffer it reads, and the caller still stores the bytes.
 const task=pdf.getDocument({data:bytes.slice(),useWorkerFetch:false,disableFontFace:true,useSystemFonts:false,enableXfa:false});
 try{return {pdf,task,doc:await task.promise}}
 catch(e){await task.destroy().catch(()=>{});if((e as {name?:string})?.name==='PasswordException')return {pdf,task:null,doc:null};throw new ApiError(415,'The attachment is not a readable PDF. Nothing was saved.')}
}
export function policy(){const vars=env as unknown as Record<string,string|undefined>;return {hosts:fileHosts(vars.SUNDARK_FILE_HOSTS),devOrigin:import.meta.env.DEV?vars.SUNDARK_DEV_FILE_ORIGIN:undefined}}
/** One page through the browser reader's pdf.js atom/sentence rules. Throws when the page fails. */
export async function extractPage(pdf:Pdf,doc:Doc,n:number){
 const page=await doc.getPage(n);const viewport=page.getViewport({scale:1});
 const segments=buildSentenceSegments(pdfTextAtoms(await page.getTextContent(),viewport,pdf.Util.transform,n),n,'text');page.cleanup();
 return {width:viewport.width,height:viewport.height,segments};
}
