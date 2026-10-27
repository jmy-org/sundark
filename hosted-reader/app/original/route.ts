import {requireChatGPTUser} from '../chatgpt-auth';
import {originalHtml} from '../../lib/original-html';
export const dynamic='force-dynamic';
export async function GET(request:Request){
 const url=new URL(request.url);
 await requireChatGPTUser('/original'+url.search);
 return new Response(originalHtml,{headers:{'Content-Type':'text/html; charset=utf-8','Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff','Referrer-Policy':'same-origin','Content-Security-Policy':"default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' blob: data:; font-src 'self' data:; connect-src 'self'; worker-src 'self' blob:; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'self'"}});
}
