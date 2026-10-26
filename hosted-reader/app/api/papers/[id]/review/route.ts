import {identity,failure} from '../../../../../lib/papers';
import {review,generatedReview} from '../../../../../lib/review';
export const dynamic='force-dynamic';
export async function GET(r:Request,c:{params:Promise<{id:string}>}){try{const owner=await identity(),id=(await c.params).id,q=new URL(r.url).searchParams;const bytes=q.get('mode')==='review'?await generatedReview(owner,id,q.get('language')||'ko'):await review(owner,id);return new Response(bytes,{headers:{'Content-Type':'application/zip','Content-Disposition':'attachment; filename="sundark-review.zip"','Content-Length':String(bytes.length),'Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff'}})}catch(e){return failure(e)}}
