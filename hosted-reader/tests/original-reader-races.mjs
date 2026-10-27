// Regression tests execute the adapted original functions, not reimplemented lookalikes.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
const source=readFileSync(new URL('../public/sundark-original/app.js',import.meta.url),'utf8');
function fn(name){const start=source.search(new RegExp('(?:async )?function '+name+'\\('));assert(start>=0,name);return source.slice(start,source.indexOf('\n}',start)+2);}
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};};
const nodes=new Map(),loads=new Map();const node=id=>{if(!nodes.has(id))nodes.set(id,{style:{},classList:{add(){},remove(){}},innerHTML:'',textContent:'',checked:false,appendChild(){}});return nodes.get(id);};
const noop=()=>{};let post=async()=>({}),fetchResponse=async()=>({json:async()=>({turns:[]})});
const context=vm.createContext({window:{},console,encodeURIComponent,$:node,document:{querySelectorAll:()=>[],createElement:()=>({})},pdfjsLib:{getDocument:options=>{const id=options.url.split('/')[3],d=deferred();const task={promise:d.promise,destroy:async()=>{task.destroyed=true;}};loads.set(id,{...d,task});return task;}},stopRender:noop,setTitle:noop,updateReviewBtn:noop,zoomScale:()=>1,showZoom:noop,buildPageShells:async()=>{},buildTrShells:noop,resetTrNav:noop,showPageNum:noop,ensureRendered:async()=>{},translateAll:async()=>{},genSummary:async()=>{},loadAnatomy:async()=>{},loadChat:async()=>{},hide:noop,lang:()=> 'ko',postJSON:(...args)=>post(...args),fetch:(...args)=>fetchResponse(...args),mdMath:s=>s,renderMath:noop,esc:String,renderAnatomy:d=>node('anatomy').innerHTML=d.value,addMsg:()=>({}),setTimeout});
vm.runInContext(source.slice(source.indexOf('const S = {'),source.indexOf('\n};',source.indexOf('const S = {'))+3),context);
vm.runInContext(fn('beginPaperOpen')+'\n'+fn('showOpenFailure')+'\n'+fn('clearOpenFailure')+'\n'+fn('openDoc')+'\n'+fn('openFromLibrary')+'\nwindow.sundarkCurrentPdf=id=>S.docId===id&&S.loadedPaperId===id?S.pdf:null;\nglobalThis.state=S;',context);
const state=context.state;const pdf=id=>({id,numPages:1,getPage:async()=>({getViewport:()=>({width:612,height:792})})});
state.pdf=pdf('old');state.pdf.loadingTask={destroy:async()=>{}};state.docId='old';state.loadedPaperId='old';
const a=context.openDoc({doc_id:'A',title:'A'});assert.equal(state.pdf,null);assert.equal(context.window.sundarkCurrentPdf('A'),null);
const b=context.openDoc({doc_id:'B',title:'B'});const pb=pdf('B');loads.get('B').resolve(pb);await b;assert.equal(context.window.sundarkCurrentPdf('B'),pb);
loads.get('A').resolve(pdf('A'));await a;assert.equal(state.pdf,pb);assert.equal(state.loadedPaperId,'B');assert.equal(loads.get('A').task.destroyed,true);
// Late metadata cannot reopen a previously selected document.
const ma=deferred(),mb=deferred();post=(_,{rel})=>rel==='A'?ma.promise:mb.promise;
const oa=context.openFromLibrary('A');const ob=context.openFromLibrary('B');ma.resolve({doc_id:'A',title:'A'});await oa;assert.equal(state.pdf,null);mb.resolve({doc_id:'B',title:'B'});await Promise.resolve();await Promise.resolve();loads.get('B').resolve(pdf('new-B'));await ob;assert.equal(state.pdf.id,'new-B');
// Stale saved summary/anatomy/chat successes and failures cannot touch the new document.
for(const name of ['genSummary','loadAnatomy','loadChat']){
 vm.runInContext(fn(name),context);
 for(const reject of [false,true]){
  state.docId='A';state.openGeneration++;state.summaryLoaded=false;state.anatomyLoaded=false;state.anatomyLoading=false;
  const d=deferred();post=()=>d.promise;fetchResponse=async()=>({json:()=>d.promise});const run=context[name]();
  state.docId='B';state.openGeneration++;node('summary').innerHTML='B summary';node('anatomy').innerHTML='B anatomy';node('chatlog').innerHTML='B chat';
  if(reject)d.reject(new Error('old A error'));else d.resolve({summary:'A summary',value:'A anatomy',turns:[{role:'assistant',text:'A chat'}]});await run;
  assert.equal(node('summary').innerHTML,'B summary');assert.equal(node('anatomy').innerHTML,'B anatomy');assert.equal(node('chatlog').innerHTML,'B chat');
 }
}
console.log('Original reader document-switch regressions passed: PDF identity, late load, late metadata, and 6 stale analysis success/error cases.');
// A page render/layout awaited before a switch cannot land in the new document.
vm.runInContext(fn('ensureRendered'),context);
{
 const d=deferred();state.openGeneration++;state.docId='render-A';state.pdf={getPage:()=>d.promise};state.pages=[{gen:0,rendered:false}];
 const run=context.ensureRendered(0);state.openGeneration++;state.docId='render-B';state.pages=[];
 d.resolve({getViewport:()=>{throw new Error('stale render touched geometry');}});await run;
}
context.getJSON=()=>Promise.resolve({width:1,height:1,words:[],sentences:[]});
vm.runInContext(fn('ensureLayout'),context);
{
 const d=deferred();context.getJSON=()=>d.promise;state.openGeneration++;state.docId='layout-A';const old={};state.pages=[old];
 const run=context.ensureLayout(0,true);state.openGeneration++;state.docId='layout-B';state.pages=[];
 d.resolve({width:1,height:1,words:[],sentences:[]});assert.equal(await run,null);assert.equal(old.layout,undefined);
}
{
 const d=deferred(),calls=[];context.getJSON=url=>{calls.push(url);return calls.length===1?d.promise:Promise.resolve({width:612,height:792,words:[],sentences:[]});};
 state.openGeneration++;state.docId='layout-current';state.pages=[{}];const saved=context.ensureLayout(0);const visible=context.ensureLayout(0,true);
 d.resolve({width:1,height:1,words:[],sentences:[],notExtracted:true});await saved;await visible;assert.equal(calls.length,2);assert(calls[1].endsWith('?extract=1'));
}
console.log('Original reader render/layout generation and visible-page extraction race regressions passed.');
