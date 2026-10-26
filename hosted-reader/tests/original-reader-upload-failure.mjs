// An upload that fails must say so in #ai-banner (role=alert), because the topbar title that also
// carries it is not rendered on narrow screens. A new pick takes down only the failure this code
// wrote, a stale upload failure never replaces a newer open's message, and an oversize pick sends
// nothing. Drives the real anonymous change listener of the adapted original in a VM.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
const source=readFileSync(new URL('../public/sundark-original/app.js',import.meta.url),'utf8');
function fn(name){const start=source.search(new RegExp('(?:async )?function '+name+'\\('));assert(start>=0,name);return source.slice(start,source.indexOf('\n}',start)+2);}
function listener(){const start=source.indexOf('$("file").addEventListener("change"');assert(start>=0,'file change listener');return source.slice(start,source.indexOf('\n});',start)+4);}
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};};
const flush=async()=>{for(let i=0;i<10;i++)await Promise.resolve();};

function element(id){
  const classes=new Set(['pdfcol','aipanel','prep-overlay','ai-banner'].includes(id)?['hidden']:[]);
  const el={id,style:{},dataset:{},children:[],textContent:'',checked:false,disabled:false,value:'',listeners:{},
    classList:{add:c=>classes.add(c),remove:c=>classes.delete(c),contains:c=>classes.has(c),toggle(){}},
    addEventListener(type,cb){el.listeners[type]=cb;},
    appendChild(c){el.children.push(c);return c;},insertBefore(c){el.children.push(c);return c;},
    querySelector:()=>null,remove(){},
    get innerHTML(){return el._html??'';},set innerHTML(v){el._html=v;el.children=[];}};
  return el;
}
const nodes=new Map();const $=id=>{if(!nodes.has(id))nodes.set(id,element(id));return nodes.get(id);};
class IntersectionObserver{constructor(cb){this.cb=cb;}observe(){}unobserve(){}disconnect(){}}
class FormData{constructor(){this.entries=[];}append(k,v){this.entries.push([k,v]);}}
let post=async()=>({});let upload=async()=>({});const uploads=[];const loads=new Map();
const context=vm.createContext({window:{},console,encodeURIComponent,$,IntersectionObserver,FormData,
  document:{querySelectorAll:()=>[],createElement:()=>element()},
  pdfjsLib:{getDocument:o=>{const id=decodeURIComponent(o.url.split('/')[3]),d=deferred();const task={promise:d.promise,destroy:async()=>{}};loads.set(id,{...d,task});return task;}},
  updateReviewBtn(){},zoomScale:()=>1,showZoom(){},resetTrNav(){},buildTrShells(){},showPageNum(){},loadLibrary(){},
  ensureRendered:async()=>{},translateAll:async()=>{},genSummary:async()=>{},loadAnatomy:async()=>{},loadChat:async()=>{},
  setTitle:t=>{$('title').textContent=t;},show:el=>el.classList.remove('hidden'),hide:el=>el.classList.add('hidden'),
  postJSON:(...a)=>post(...a),postForm:(...a)=>{uploads.push(a);return upload(...a);}});
vm.runInContext(source.slice(source.indexOf('const S = {'),source.indexOf('\n};',source.indexOf('const S = {'))+3),context);
vm.runInContext(['beginPaperOpen','showOpenFailure','clearOpenFailure','openDoc','openFromLibrary','buildPageShells','resetObserver','shellOf','onPageVisible','onPageFar','stopRender'].map(fn).join('\n')+
  '\n'+listener()+'\nglobalThis.state=S;',context);
const state=context.state;
const change=$('file').listeners.change;assert.equal(typeof change,'function','change listener captured');
const pick=(size,name='x.pdf')=>{$('file').value='C:\\fakepath\\'+name;return change({target:{files:[{size,name}]}});};
const hidden=id=>$(id).classList.contains('hidden');
const page=()=>({getViewport:()=>({width:612,height:792})});
const MiB20=20*1024*1024;const OVERSIZE='PDF는 20MB 이하만 추가할 수 있어요.';
const bannerShows=(text,label)=>{assert.equal(hidden('ai-banner'),false,label+': banner shown');assert.equal($('ai-banner').textContent,text,label+': banner text');};
const bannerClear=label=>{assert.equal(hidden('ai-banner'),true,label+': banner hidden');assert.equal($('ai-banner').textContent,'',label+': banner emptied');};
async function libraryFailure(rel,msg){post=async()=>({doc_id:rel,title:rel,num_pages:1});
  const run=context.openFromLibrary(rel);await flush();loads.get(rel).reject(new Error(msg));await run;
  bannerShows('열기 실패: '+msg,'library failure');}
async function openPaper(rel){post=async()=>({doc_id:rel,title:rel,num_pages:1});
  const run=context.openFromLibrary(rel);await flush();loads.get(rel).resolve({numPages:1,getPage:async()=>page()});await run;
  assert.equal(state.docId,rel);}

// 1. An oversize pick after a library failure shows its own error, not the stale one, sends
// nothing and leaves the open paper alone. Its value is reset so the same file can be picked again.
await libraryFailure('broken','Missing PDF');
{const gen=state.openGeneration;uploads.length=0;
 await pick(MiB20+1,'big.pdf');
 bannerShows(OVERSIZE,'oversize');assert.equal($('title').textContent,OVERSIZE,'oversize title');
 assert.equal(uploads.length,0,'oversize sends nothing');assert.equal(state.openGeneration,gen,'generation unchanged');
 assert.equal($('file').value,'','oversize value reset');assert.equal($('file').disabled,false,'input still enabled');}
// With a paper open, an oversize pick keeps it open.
await openPaper('kept');
{const gen=state.openGeneration,pdf=state.pdf;uploads.length=0;
 await pick(MiB20+1,'big.pdf');
 bannerShows(OVERSIZE,'oversize over open paper');assert.equal(uploads.length,0);assert.equal(state.openGeneration,gen);
 assert.equal(state.docId,'kept','current paper unchanged');assert.equal(state.pdf,pdf,'current PDF unchanged');}

// 2. Exactly 20 MiB is accepted and uploaded.
{const d=deferred();upload=()=>d.promise;uploads.length=0;
 const run=pick(MiB20,'edge.pdf');await flush();
 assert.equal(uploads.length,1,'20 MiB uploads');assert.equal(uploads[0][0],'/api/upload');
 // A real pick takes down the earlier owned failure as soon as the attempt starts.
 bannerClear('new upload attempt');
 d.resolve({doc_id:'edge',title:'Edge',num_pages:1});await flush();
 loads.get('edge').resolve({numPages:1,getPage:async()=>page()});await run;
 bannerClear('upload success');assert.equal(state.docId,'edge');assert.equal($('file').value,'');}

// 3. The current upload's rejection reaches the alert banner, after a library failure too.
await libraryFailure('broken3','Nope');
upload=async()=>{throw new Error('quota');};
await pick(1024);
bannerShows('업로드 실패: quota','current upload failure');assert.equal($('title').textContent,'업로드 실패: quota');
assert.equal($('file').disabled,false);assert.equal($('file').value,'');

// 4. The next library open takes the upload failure down; its own failure then shows.
{post=async()=>({doc_id:'lib',title:'Lib',num_pages:1});
 const run=context.openFromLibrary('lib');await flush();bannerClear('next library attempt');
 loads.get('lib').resolve({numPages:1,getPage:async()=>page()});await run;bannerClear('library success');}

// 5. An old upload's rejection after a newer library open is fenced: it writes nothing.
{const d=deferred();upload=()=>d.promise;
 const run=pick(1024,'slow.pdf');await flush();
 post=async()=>({doc_id:'newer',title:'Newer',num_pages:1});
 const lib=context.openFromLibrary('newer');await flush();
 d.reject(new Error('late upload failure'));await run;
 bannerClear('stale upload failure while the newer open loads');assert.equal($('title').textContent.startsWith('업로드 실패'),false);
 loads.get('newer').reject(new Error('newer failed'));await lib;
 bannerShows('열기 실패: newer failed','newer open keeps its own failure');
 // And an old upload failing after the newer open already failed does not replace that message.
 const d2=deferred();upload=()=>d2.promise;
 const run2=pick(1024,'slow2.pdf');await flush();
 await libraryFailure('newest','newest failed');
 d2.reject(new Error('later upload failure'));await run2;
 bannerShows('열기 실패: newest failed','stale upload failure fenced');assert.equal($('title').textContent,'열기 실패: newest failed');}

// 6. An oversize error is owned too: the next upload attempt clears it, and a success keeps it clear.
await pick(MiB20+1);bannerShows(OVERSIZE,'second oversize');
{upload=async()=>({doc_id:'ok',title:'OK',num_pages:1});
 const run=pick(2048,'ok.pdf');await flush();bannerClear('upload after oversize');
 loads.get('ok').resolve({numPages:1,getPage:async()=>page()});await run;bannerClear('upload success after oversize');}

// 7. Clearing touches only the owned message: another error in the banner survives a new pick
// that brings no error of its own.
{const other='요청이 너무 많아요. 잠시 후 다시 시도해 주세요.';$('ai-banner').textContent=other;$('ai-banner').classList.remove('hidden');
 upload=async()=>({doc_id:'ok2',title:'OK2',num_pages:1});
 const run=pick(4096,'ok2.pdf');await flush();
 assert.equal(hidden('ai-banner'),false,'unrelated error kept on new pick');assert.equal($('ai-banner').textContent,other);
 loads.get('ok2').resolve({numPages:1,getPage:async()=>page()});await run;
 assert.equal(hidden('ai-banner'),false,'unrelated error kept on success');assert.equal($('ai-banner').textContent,other);
 // An owned upload failure replaced by a later error is no longer the upload's to clear.
 upload=async()=>{throw new Error('boom');};await pick(1024);bannerShows('업로드 실패: boom','upload failure over other');
 $('ai-banner').textContent='페이지 표시 오류: render';
 upload=async()=>({doc_id:'ok3',title:'OK3',num_pages:1});
 const run2=pick(1024,'ok3.pdf');await flush();loads.get('ok3').resolve({numPages:1,getPage:async()=>page()});await run2;
 bannerShows('페이지 표시 오류: render','later error kept');}

console.log('Original reader upload-failure feedback passed: oversize shows its own alert with no request and the paper kept, 20 MiB uploads, current upload failures alert, stale upload failures fenced, owned failures cleared on the next attempt and success, other errors kept.');
