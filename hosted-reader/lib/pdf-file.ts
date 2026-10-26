/** PDF bytes shared by the Site upload and the ChatGPT attachment import: bounded reading,
 * signature and stored name, plus the attachment download policy. No platform imports, so
 * Node tests exercise exactly this code. Errors never carry the URL or its query. */
/** `reason` says what failed (missing, malformed, unsupported_host, unsafe_url, expired, download,
 * size); `host` is set only for unsupported_host and is a parsed, HOST-validated hostname. */
export class PdfFileError extends Error {status:number;reason:string;host?:string;constructor(status:number,message:string,reason='download',host?:string){super(message);this.status=status;this.reason=reason;this.host=host}}
export const MAX_PDF=20*1024*1024;
// Candidate ChatGPT file host. Not an official guarantee: the live host gate decides,
// and SUNDARK_FILE_HOSTS replaces it with an exact-host list.
export const DEFAULT_FILE_HOSTS=['files.oaiusercontent.com'];
const HOST=/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
export function fileHosts(value?:string){if(value===undefined)return DEFAULT_FILE_HOSTS;return value.split(',').map(h=>h.trim().toLowerCase()).filter(h=>HOST.test(h))}
export interface FilePolicy{hosts:string[];devOrigin?:string}
const missing=()=>new PdfFileError(400,'The attachment reference has no download URL. Pass the PDF the user attached in ChatGPT as the file parameter.','missing');
const malformed=()=>new PdfFileError(400,'The attachment download URL is malformed. Call again with a fresh file reference to the attached PDF.','malformed');
const unsafe=()=>new PdfFileError(400,'The attachment download URL is not a plain https file URL (credentials, IP addresses and custom ports are refused). Nothing was downloaded.','unsafe_url');
// A configuration error: reattaching the same file cannot fix it, so do not ask the user to.
const unsupported=(host:string)=>new PdfFileError(400,`The attachment file host ${host} is not in this Sundark deployment's allowed file hosts (SUNDARK_FILE_HOSTS). Reattaching will not help; the Site owner must allow this exact host if it is a genuine ChatGPT file host. Nothing was downloaded.`,'unsupported_host',host);
export function checkFileUrl(raw:unknown,policy:FilePolicy){
 if(typeof raw!=='string'||!raw)throw missing();
 if(raw.length>4096)throw malformed();
 let url:URL;try{url=new URL(raw)}catch{throw malformed()}
 if(url.username||url.password)throw unsafe();
 // Local fixture server, only when the dev build supplies its exact loopback origin.
 if(policy.devOrigin&&/^http:\/\/127\.0\.0\.1:\d{2,5}$/.test(policy.devOrigin)&&url.origin===policy.devOrigin)return url;
 if(url.protocol!=='https:'||url.port!==''||!HOST.test(url.hostname))throw unsafe();
 if(!policy.hosts.includes(url.hostname))throw unsupported(url.hostname);
 return url;
}
export function isPdf(bytes:Uint8Array){return bytes.length>=8&&new TextDecoder().decode(bytes.slice(0,5))==='%PDF-'}
export function pdfName(raw:unknown){let name=typeof raw==='string'&&raw.trim()?raw.trim():'paper.pdf';name=name.replace(/[\x00-\x1f\x7f/\\]/g,'_').slice(0,180);if(!name.toLowerCase().endsWith('.pdf'))name+='.pdf';return name}
export async function readBounded(body:ReadableStream<Uint8Array>|null,max:number,tooLarge:string){
 if(!body)throw new PdfFileError(400,'파일이 없습니다.','download');
 const reader=body.getReader();let size=0;const chunks:Uint8Array[]=[];
 while(true){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>max){await reader.cancel().catch(()=>{});throw new PdfFileError(413,tooLarge,'size')}chunks.push(value)}
 const bytes=new Uint8Array(size);let offset=0;for(const c of chunks){bytes.set(c,offset);offset+=c.length}return bytes;
}
const TOO_LARGE='The attached PDF exceeds the 20 MiB limit.';
/** GET with no redirects, credentials, cookies or forwarded headers; time and size bounded. */
export async function downloadPdf(url:URL,{timeoutMs=20000,fetcher=fetch}:{timeoutMs?:number;fetcher?:typeof fetch}={}){
 const signal=AbortSignal.timeout(timeoutMs);
 const failed=(e:unknown)=>e instanceof PdfFileError?e:signal.aborted?new PdfFileError(504,'The attachment download timed out. Ask the user to attach the PDF again.'):new PdfFileError(502,'The attachment could not be downloaded. Ask the user to attach the PDF again.');
 // A signed file URL that stopped working: a fresh reference to the same attachment usually fixes it.
 const expired=()=>new PdfFileError(502,'The attachment link has expired or is no longer accessible. Call again with a fresh file reference to the same attached PDF; ask the user to reattach only if that also fails.','expired');
 let response:Response;
 try{response=await fetcher(url.href,{method:'GET',redirect:'manual',headers:{Accept:'application/pdf'},signal})}catch(e){throw failed(e)}
 if(response.status!==200){await response.body?.cancel().catch(()=>{});throw [401,403,404,410].includes(response.status)?expired():failed(null)}
 if(Number(response.headers.get('content-length')||0)>MAX_PDF){await response.body?.cancel().catch(()=>{});throw new PdfFileError(413,TOO_LARGE,'size')}
 try{return await readBounded(response.body,MAX_PDF,TOO_LARGE)}catch(e){throw failed(e)}
}
