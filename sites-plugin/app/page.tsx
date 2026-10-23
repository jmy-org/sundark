import {requireChatGPTUser} from './chatgpt-auth';
import Library from './library';
export const dynamic='force-dynamic';
export default async function Home(){ const user=await requireChatGPTUser('/');return <Library userName={user.fullName || '내 서재'}/>;}
