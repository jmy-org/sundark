// A paper that fails to load must give the library back: no blank reader columns, no stale paper
// identity, no page still drawing or observed. The failure must also reach #ai-banner (role=alert),
// because the topbar title that also carries it is not rendered on narrow screens. Executes the
// adapted original functions in a VM.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
const source=readFileSync(new URL('../public/sundark-original/app.js',import.meta.url),'utf8');
function fn(name){const start=source.search(new RegExp('(?:async )?function '+name+'\\('));assert(start>=0,name);return source.slice(start,source.indexOf('\n}',start)+2);}
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};};
const flush=async()=>{for(let i=0;i<10;i++)await Promise.resolve();};

function element(id){
  const classes=new Set(['pdfcol','aipanel','prep-overlay','ai-banner'].includes(id)?['hidden']:[]);
  const el={id,style:{},dataset:{},children:[],textContent:'',checked:false,
    classList:{add:c=>classes.add(c),remove:c=>classes.delete(c),contains:c=>classes.has(c),toggle(){}},
    appendChild(c){el.children.push(c);return c;},insertBefore(c){el.children.push(c);return c;},
    querySelector:()=>null,remove(){},
    get innerHTML(){return el._html??'';},set innerHTML(v){el._html=v;el.children=[];}};
  return el;
}
const nodes=new Map();const $=id=>{if(!nodes.has(id))nodes.set(id,element(id));return nodes.get(id);};
const observers=[];
class IntersectionObserver{constructor(cb){this.cb=cb;this.targets=new Set();this.live=true;observers.push(this);}
  observe(t){this.targets.add(t);}unobserve(t){this.targets.delete(t);}disconnect(){this.live=false;this.targets.clear();}}
let post=async()=>({});const loads=new Map();const started=[];
const context=vm.createContext({window:{},console,encodeURIComponent,$,IntersectionObserver,
  document:{querySelectorAll:()=>[],createElement:()=>element()},
  pdfjsLib:{getDocument:o=>{const id=decodeURIComponent(o.url.split('/')[3]),d=deferred();const task={promise:d.promise,destroy:async()=>{task.destroyed=true;}};loads.set(id,{...d,task});return task;}},
  updateReviewBtn(){},zoomScale:()=>1,showZoom(){},resetTrNav(){},buildTrShells(){},showPageNum(){},
  ensureRendered:async i=>{started.push(i);},translateAll:async()=>{},genSummary:async()=>{},loadAnatomy:async()=>{},loadChat:async()=>{},
  setTitle:t=>{$('title').textContent=t;},show:el=>el.classList.remove('hidden'),hide:el=>el.classList.add('hidden'),
  postJSON:(...a)=>post(...a)});
vm.runInContext(source.slice(source.indexOf('const S = {'),source.indexOf('\n};',source.indexOf('const S = {'))+3),context);
vm.runInContext(['beginPaperOpen','showOpenFailure','clearOpenFailure','openDoc','openFromLibrary','buildPageShells','resetObserver','shellOf','onPageVisible','onPageFar','stopRender'].map(fn).join('\n')+
  '\nwindow.sundarkCurrentPdf=id=>S.docId===id&&S.loadedPaperId===id?S.pdf:null;\nglobalThis.state=S;',context);
const state=context.state;
const hidden=id=>$(id).classList.contains('hidden');
function assertLibraryBack(label){
  assert.equal(hidden('prep-overlay'),true,label+': loading screen hidden');
  assert.equal(hidden('pdfcol'),true,label+': PDF column hidden');
  assert.equal(hidden('aipanel'),true,label+': AI panel hidden');
  assert.equal(hidden('empty'),false,label+': library prompt shown');
  assert.equal(state.docId,null,label+': no paper identity');
  assert.equal(state.loadedPaperId,null,label+': no loaded paper');
  assert.equal(state.pdf,null,label+': no PDF');
  assert.equal(state.loadingTask,null,label+': no loading task');
  assert.equal(state.pages.length,0,label+': no page shells');
  assert.equal($('pdfview').children.length,0,label+': PDF view cleared');
  assert.match($('title').textContent,/^열기 실패: /,label+': failure reported');
  assert.equal(hidden('ai-banner'),false,label+': failure banner shown');
  assert.equal($('ai-banner').textContent,$('title').textContent,label+': banner carries the title message');
}
const bannerClear=label=>{assert.equal(hidden('ai-banner'),true,label+': banner hidden');assert.equal($('ai-banner').textContent,'',label+': banner emptied');};
const page=(w=612)=>({getViewport:()=>({width:w,height:792})});

// 1. The PDF itself cannot be loaded (missing file, lost connection).
post=async()=>({doc_id:'broken',title:'Broken',num_pages:3});
{const run=context.openFromLibrary('broken');await flush();
 assert.equal(hidden('pdfcol'),false);assert.equal(hidden('empty'),true);
 loads.get('broken').reject(new Error('Missing PDF'));await run;
 assertLibraryBack('load failure');assert.equal(loads.get('broken').task.destroyed,true);
 assert.equal(context.window.sundarkCurrentPdf('broken'),null);}

// 2. A later page fails after earlier shells are observed and drawing.
post=async()=>({doc_id:'partial',title:'Partial',num_pages:3});
{const run=context.openFromLibrary('partial');await flush();
 const renderTask={cancelled:false,cancel(){renderTask.cancelled=true;}};
 const pdf={numPages:3,getPage:async n=>{if(n===2){state.pages[0].renderTask=renderTask;state.pages[0].rendered=true;}
   if(n===3)throw new Error('Bad page 3');return page();}};
 loads.get('partial').resolve(pdf);await run;
 assertLibraryBack('page failure');assert.equal(renderTask.cancelled,true,'page 1 render cancelled');
 assert.equal(context.window.sundarkCurrentPdf('partial'),null,'broken PDF is not offered to OCR');
 const shellObservers=observers.slice(-2);assert(shellObservers.every(o=>!o.live),'page observers disconnected');
 // An entry queued before the disconnect still arrives: it must not throw or draw anything.
 const staleShell=element();staleShell.dataset.page=0;started.length=0;
 assert.doesNotThrow(()=>shellObservers[0].cb([{isIntersecting:true,target:staleShell}]));
 assert.doesNotThrow(()=>shellObservers[1].cb([{isIntersecting:false,target:staleShell}]));
 await flush();assert.deepEqual(started,[],'stale entry draws nothing');}

// 3. A retry of the same paper opens it.
post=async()=>({doc_id:'partial',title:'Partial',num_pages:1});
{const run=context.openFromLibrary('partial');await flush();
 bannerClear('next open');
 loads.get('partial').resolve({numPages:1,getPage:async()=>page()});await run;
 bannerClear('retry success');
 assert.equal(state.docId,'partial');assert.equal(hidden('pdfcol'),false);assert.equal(hidden('empty'),true);
 assert.equal(state.pages.length,1);assert.equal(context.window.sundarkCurrentPdf('partial')?.numPages,1);}

// 4. An old paper's failure after the user picked another cannot tear the new one down.
{post=async(_,{rel})=>({doc_id:rel,title:rel,num_pages:1});
 const old=context.openFromLibrary('old');await flush();
 const cur=context.openFromLibrary('current');await flush();
 loads.get('current').resolve({numPages:1,getPage:async()=>page()});await cur;
 loads.get('old').reject(new Error('late old failure'));await old;
 assert.equal(state.docId,'current');assert.equal(hidden('pdfcol'),false);assert.equal(hidden('empty'),true);
 assert.equal(state.pages.length,1);assert.equal($('title').textContent.startsWith('열기 실패'),false);}

// 5. A failed open leaves its banner up until the next open; a success through another path
// (an upload calls openDoc directly) also takes it down.
post=async()=>({doc_id:'gone',title:'Gone',num_pages:1});
{const run=context.openFromLibrary('gone');await flush();
 loads.get('gone').reject(new Error('Failed to fetch'));await run;
 assertLibraryBack('second failure');assert.equal($('ai-banner').textContent,'열기 실패: Failed to fetch');
 const run2=context.openDoc({doc_id:'uploaded',title:'Uploaded',num_pages:1});await flush();
 assert.equal(hidden('ai-banner'),false,'failure stays up while the next paper loads');
 loads.get('uploaded').resolve({numPages:1,getPage:async()=>page()});await run2;
 bannerClear('success through openDoc');assert.equal(state.docId,'uploaded');}

// 6. Clearing touches only the open-failure message: another error in the banner stays.
{const other='저장된 결과를 불러오지 못했어요.';$('ai-banner').textContent=other;$('ai-banner').classList.remove('hidden');
 post=async()=>({doc_id:'next',title:'Next',num_pages:1});
 const run=context.openFromLibrary('next');await flush();
 loads.get('next').resolve({numPages:1,getPage:async()=>page()});await run;
 assert.equal(hidden('ai-banner'),false,'unrelated error kept');assert.equal($('ai-banner').textContent,other,'unrelated text kept');
 // A failure banner replaced by another error is no longer the failure's to clear.
 post=async()=>({doc_id:'x',title:'X',num_pages:1});
 const fail=context.openFromLibrary('x');await flush();loads.get('x').reject(new Error('boom'));await fail;
 assert.equal($('ai-banner').textContent,'열기 실패: boom');
 $('ai-banner').textContent='페이지 표시 오류: render';
 post=async()=>({doc_id:'y',title:'Y',num_pages:1});
 const run2=context.openFromLibrary('y');await flush();loads.get('y').resolve({numPages:1,getPage:async()=>page()});await run2;
 assert.equal(hidden('ai-banner'),false);assert.equal($('ai-banner').textContent,'페이지 표시 오류: render','later error kept');
 $('ai-banner').textContent='';$('ai-banner').classList.add('hidden');}

// 7. A stale failure, or a stale success, never touches the current paper's banner.
{post=async(_,{rel})=>({doc_id:rel,title:rel,num_pages:1});
 const old=context.openFromLibrary('old2');await flush();
 const cur=context.openFromLibrary('cur2');await flush();
 loads.get('cur2').reject(new Error('current failure'));await cur;
 assert.equal($('ai-banner').textContent,'열기 실패: current failure');
 loads.get('old2').reject(new Error('stale failure'));await old;
 assert.equal($('ai-banner').textContent,'열기 실패: current failure','stale failure does not replace the current one');
 assert.equal($('title').textContent,'열기 실패: current failure');
 const old3=context.openFromLibrary('old3');await flush();
 const cur3=context.openFromLibrary('cur3');await flush();
 loads.get('cur3').reject(new Error('third failure'));await cur3;
 loads.get('old3').resolve({numPages:1,getPage:async()=>page()});await old3;
 assert.equal(hidden('ai-banner'),false,'stale success does not clear the current failure');
 assert.equal($('ai-banner').textContent,'열기 실패: third failure');}

console.log('Original reader open-failure recovery passed: load failure, partial page failure with stale observer entries, retry, stale failure fencing, and the open-failure banner (shown, cleared on next open and success, other errors kept, stale results fenced).');
