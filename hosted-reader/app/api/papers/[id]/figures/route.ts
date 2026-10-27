import {identity,csrf,reply,failure} from '../../../../../lib/papers';
import {figures,saveFigure} from '../../../../../lib/figures';
export const dynamic='force-dynamic';
type Context={params:Promise<{id:string}>};
export async function GET(r:Request,c:Context){try{return reply({figures:await figures(await identity(),(await c.params).id)})}catch(e){return failure(e)}}
export async function POST(r:Request,c:Context){try{const owner=await identity();csrf(r);return reply(await saveFigure(owner,(await c.params).id,r))}catch(e){return failure(e)}}
