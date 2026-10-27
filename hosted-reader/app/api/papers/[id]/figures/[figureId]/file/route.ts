import {identity,failure} from '../../../../../../../lib/papers';
import {figure} from '../../../../../../../lib/figures';
export const dynamic='force-dynamic';
export async function GET(r:Request,c:{params:Promise<{id:string,figureId:string}>}){try{const {id,figureId}=await c.params;const {object}=await figure(await identity(),id,figureId);return new Response(object.body,{headers:{'Content-Type':'image/png','Content-Length':String(object.size),'Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff','Content-Security-Policy':"sandbox; frame-ancestors 'self'",'Cross-Origin-Resource-Policy':'same-origin'}})}catch(e){return failure(e)}}
