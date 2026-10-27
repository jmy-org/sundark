import {identity,database,csrf,reply,failure,fields,jsonBody,owned,publicPaper} from '../../../../lib/papers';
export const dynamic='force-dynamic';
type Context={params:Promise<{id:string}>};
export async function GET(r:Request,c:Context){try{return reply({paper:publicPaper(await owned(await identity(),(await c.params).id))})}catch(e){return failure(e)}}
export async function PATCH(r:Request,c:Context){try{const owner=await identity();csrf(r);const {id}=await c.params;await owned(owner,id);const x=fields(await jsonBody(r));const keys=Object.keys(x);if(keys.length)await database().prepare(`UPDATE papers SET ${keys.map(k=>`${k}=?`).join(',')},updated_at=? WHERE id=? AND owner=?`).bind(...keys.map(k=>x[k]),new Date().toISOString(),id,owner).run();return reply({paper:publicPaper(await owned(owner,id))})}catch(e){return failure(e)}}
