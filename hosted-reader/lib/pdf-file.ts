/** PDF bytes shared by the Site upload and the ChatGPT attachment import: bounded reading,
 * signature and stored name, plus the attachment download policy. No platform imports, so
 * Node tests exercise exactly this code. Errors never carry the URL or its query. */
/** `reason` says what failed (missing, malformed, unsupported_host, unsafe_url, expired, download,
 * size); `host` is set only for unsupported_host and is a parsed, HOST-validated hostname. */
export class PdfFileError extends Error {status:number;reason:string;host?:string;constructor(status:number,message:string,reason='download',host?:string){super(message);this.status=status;this.reason=reason;this.host=host}}
export const MAX_PDF=20*1024*1024;
// ChatGPT serves attachments from per-region hosts under oaiusercontent.com (files., sdmntprwestus2.,
// sdmntprindiasocentral., ...), minted per call, so an exact list cannot converge. OpenAI lists
// oaiusercontent.com on the Public Suffix List: every single label under it is its own site, and
// other labels are separate tenants (app sandbox origins among them). Passing this rule proves
// only that the host is in that OpenAI namespace. It is not a provenance guarantee: it does not
// prove the URL is a ChatGPT file, or this user's file. A model or prompt injection could point a
// call at another tenant's PDF; those bytes are untrusted, like any attachment, and go only to the
// caller's own conversation. Nor does it check the address a name resolves to: that is left to
// OpenAI's DNS for its namespace. pdfSha256 binds the original pane to the bytes that produced the
// translation, not to where they came from.
const CHATGPT_FILE_NAMESPACE=/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.oaiusercontent\.com$/;
// ChatGPT also hands out SAS URLs straight on Azure Blob storage accounts named oaisdmntpr<region>
// (westus2, indiasocentral, koreacentral, ... observed in production, new regions keep appearing).
// Azure account names are 3-24 lowercase letters and digits, globally unique, served only at
// <account>.blob.core.windows.net by Microsoft's DNS, so this is a bounded family of whole
// account names, not a wildcard. It is observed compatibility, not ownership: OpenAI does not
// document these hosts, and any Azure customer can register an unclaimed name with this prefix
// and serve its own bytes. This expands permitted destinations but grants those bytes no trust:
// the request carries only the caller-provided URL, and the name resolves through Microsoft's DNS,
// not DNS that the URL's author runs. Other Azure names (*.windows.net, z<N>.blob.storage.azure.net,
// custom domains, the internal CNAME targets) stay refused. This rule does not inspect resolved
// IP addresses or establish private-network unreachability.
const CHATGPT_AZURE_FILE_ACCOUNT=/^oaisdmntpr[a-z0-9]{1,14}\.blob\.core\.windows\.net$/;
const isChatGptFileHost=(host:string)=>CHATGPT_FILE_NAMESPACE.test(host)||CHATGPT_AZURE_FILE_ACCOUNT.test(host);
// Exact extra hosts outside those families; SUNDARK_FILE_HOSTS replaces this list.
export const DEFAULT_FILE_HOSTS:string[]=[];
const HOST=/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
export function fileHosts(value?:string){if(value===undefined)return DEFAULT_FILE_HOSTS;return value.split(',').map(h=>h.trim().toLowerCase()).filter(h=>HOST.test(h))}
export interface FilePolicy{hosts:string[];devOrigin?:string}
const missing=()=>new PdfFileError(400,'The attachment reference has no download URL. Pass the PDF the user attached in ChatGPT as the file parameter.','missing');
const malformed=()=>new PdfFileError(400,'The attachment download URL is malformed. Call again with a fresh file reference to the attached PDF.','malformed');
const unsafe=()=>new PdfFileError(400,'The attachment download URL is not a plain https file URL (credentials, IP addresses and custom ports are refused). Nothing was downloaded.','unsafe_url');
// A configuration error: reattaching the same file cannot fix it, so do not ask the user to.
const unsupported=(host:string)=>new PdfFileError(400,`The attachment file host ${host} is outside the ChatGPT file host families (one label under oaiusercontent.com, or an Azure storage account oaisdmntpr<region>.blob.core.windows.net) and not in this Sundark deployment's exact extra file hosts (SUNDARK_FILE_HOSTS). Reattaching will not help; the Site owner may list this exact host only after confirming it is a genuine ChatGPT file host. Nothing was downloaded.`,'unsupported_host',host);
export function checkFileUrl(raw:unknown,policy:FilePolicy){
 if(typeof raw!=='string'||!raw)throw missing();
 if(raw.length>4096)throw malformed();
 let url:URL;try{url=new URL(raw)}catch{throw malformed()}
 if(url.username||url.password)throw unsafe();
 // Local fixture server, only when the dev build supplies its exact loopback origin.
 if(policy.devOrigin&&/^http:\/\/127\.0\.0\.1:\d{2,5}$/.test(policy.devOrigin)&&url.origin===policy.devOrigin)return url;
 if(url.protocol!=='https:'||url.port!==''||!HOST.test(url.hostname))throw unsafe();
 if(!isChatGptFileHost(url.hostname)&&!policy.hosts.includes(url.hostname))throw unsupported(url.hostname);
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
