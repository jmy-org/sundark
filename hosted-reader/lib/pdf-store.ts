import {database,bucket,ApiError} from './papers';
import {PdfFileError} from './pdf-file';
/** Original PDF storage shared by the Site upload and the ChatGPT attachment import. The exact
 * bytes go to R2 first; the D1 write is conditional (quota, record cap, file fence) and the R2
 * object is deleted whenever that write does not land, so no orphan survives a lost race. */
export const MAX_LIBRARY=500*1024*1024;
export const MAX_PAPERS=2000;
export function asApiError(e:unknown){return e instanceof PdfFileError?new ApiError(e.status,e.message):e}
export async function sha256Hex(bytes:Uint8Array){return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes as BufferSource))).map(x=>x.toString(16).padStart(2,'0')).join('')}
export async function putPdf(id:string,bytes:Uint8Array,sha256:string){const key=`papers/${id}/${crypto.randomUUID()}.pdf`;await bucket().put(key,bytes,{httpMetadata:{contentType:'application/pdf'},customMetadata:{sha256}});return key}
export async function libraryRoom(owner:string,size:number){const row=await database().prepare('SELECT count(*) AS n,coalesce(sum(size),0) AS used FROM papers WHERE owner=?').bind(owner).first<{n:number;used:number}>();if((row?.n||0)>=MAX_PAPERS)throw new ApiError(409,'Library limit reached: at most 2,000 papers.');if((row?.used||0)+size>MAX_LIBRARY)throw new ApiError(409,'Library storage limit of 500 MiB would be exceeded.')}
export interface ImportedPdf{title:string;name:string;bytes:Uint8Array;sha256:string;pages:number|null;requestId:string;fileHash:string}
/** Inserts a new paper holding the PDF. Returns null when another call already holds this
 * requestId (the unique index fired); the caller then reads that row instead. */
export async function createPdfPaper(owner:string,f:ImportedPdf){
 const id=crypto.randomUUID();const key=await putPdf(id,f.bytes,f.sha256);let changes=0;
 try{const result=await database().prepare('INSERT INTO papers (id,owner,title,file_name,file_key,size,file_sha256,page_count,import_request_id,import_file_hash,updated_at) SELECT ?,?,?,?,?,?,?,?,?,?,? WHERE (SELECT count(*) FROM papers WHERE owner=?)<? AND (SELECT coalesce(sum(size),0) FROM papers WHERE owner=?)+?<=?').bind(id,owner,f.title,f.name,key,f.bytes.length,f.sha256,f.pages,f.requestId,f.fileHash,new Date().toISOString(),owner,MAX_PAPERS,owner,f.bytes.length,MAX_LIBRARY).run();changes=result.meta.changes}
 catch(e){await bucket().delete(key);if(/UNIQUE/i.test(String(e)))return null;throw e}
 if(!changes){await bucket().delete(key);throw new ApiError(409,'Library limit reached (2,000 papers or 500 MiB). Nothing was saved.')}
 return id;
}
