import {identity,reply,failure} from '../../../../../lib/papers';
import {listAnalysis} from '../../../../../lib/analysis';
export const dynamic='force-dynamic';
export async function GET(r:Request,c:{params:Promise<{id:string}>}){try{const q=new URL(r.url).searchParams;return reply(await listAnalysis(await identity(),(await c.params).id,{kind:q.get('kind')||undefined,page:q.has('page')?Number(q.get('page')):undefined,cursor:q.has('cursor')?Number(q.get('cursor')):undefined}))}catch(e){return failure(e)}}
