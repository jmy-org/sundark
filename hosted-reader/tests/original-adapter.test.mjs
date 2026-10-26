import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const id='00000000-0000-4000-8000-000000000123';
const source={page:1,width:600,height:800,segments:[{id:'s1',text:'Source sentence.',bbox:[.1,.2,.3,.1],para:'p0'}]};
const script=fs.readFileSync('public/sundark-original/adapter.js','utf8');
function harness(){let version='file-a';const requests=[];let content=source;const fetch=async(path,options={})=>{requests.push({path:String(path),options});const u=new URL(path,'https://test.site');let body;
 if(u.pathname==='/api/papers'&&options.method==='POST')body={paper:{id}};
 else if(u.pathname.endsWith('/file')){assert.equal(options.headers['Content-Type'],'application/pdf');assert(options.body instanceof File);body={paper:{id}};}
 else if(u.pathname.endsWith('/analysis'))body={artifacts:[{kind:'translation',language:'ko',page:1,stale:false,content:{segments:[{id:'s1',text:'원문 문장이다.'}]}}],nextCursor:null};
 else if(u.pathname.endsWith('/content'))body={fileVersion:version,content};
 else if(u.pathname.endsWith(id))body={paper:{id,title:'Demo',fileName:'demo.pdf',fileVersion:version}};
 else throw new Error('Unexpected '+path);
 return new Response(JSON.stringify(body),{headers:{'Content-Type':'application/json'}});
 };const window={fetch};vm.runInNewContext(script,{window,location:{href:'https://test.site/original',origin:'https://test.site'},URL,URLSearchParams,Response,File,FormData,Map,Error,JSON,structuredClone});return {window,requests,version:v=>version=v,empty:()=>content=null};}
test('original upload sends raw PDF and preserves filename',async()=>{const h=harness(),f=new File(['%PDF-1.4\n'],'한글.pdf',{type:'application/pdf'}),form=new FormData();form.set('file',f);const r=await h.window.sundarkFetch('/api/upload',{method:'POST',body:form});assert.equal(r.status,200);const sent=h.requests.find(x=>x.path.endsWith('/file'));assert.equal(sent.options.body,f);assert.equal(decodeURIComponent(sent.options.headers['X-File-Name']),'한글.pdf');});
test('layout coordinates and one-based page mapping',async()=>{const h=harness();await h.window.sundarkFetch('/api/open',{body:JSON.stringify({rel:id})});const r=await h.window.sundarkFetch(`/api/layout/${id}/0`),l=await r.json();assert.equal(l.words[0].x0,60);assert.equal(l.words[0].y0,160);assert(h.requests.some(x=>x.path.endsWith('/content?page=1')));});
test('cached-only layout does not start PDF extraction',async()=>{const h=harness();h.empty();const r=await h.window.sundarkFetch(`/api/layout/${id}/0`);assert.equal((await r.json()).notExtracted,true);assert.equal(h.requests.length,1);});
test('cached layout refuses a replaced PDF',async()=>{const h=harness();await h.window.sundarkFetch('/api/open',{body:JSON.stringify({rel:id})});h.version('file-b');assert.equal((await h.window.sundarkFetch(`/api/layout/${id}/0`)).status,409);});
test('translation uses kind/page filter and verifies source slice',async()=>{const h=harness(),body={doc_id:id,page:0,start:0,segments:['Source sentence.'],target_lang:'ko'};const r=await h.window.sundarkFetch('/api/translate_stream',{body:JSON.stringify(body)});assert.equal(r.status,200);assert.equal(JSON.parse((await r.text()).trim()).tr,'원문 문장이다.');assert(h.requests.some(x=>x.path.includes('kind=translation')&&x.path.includes('page=1')));assert.equal((await h.window.sundarkFetch('/api/translate_stream',{body:JSON.stringify({...body,segments:['Wrong source']})})).status,409);});
test('external URLs and unsupported OAuth cannot execute',async()=>{const h=harness();assert.equal((await h.window.sundarkFetch('https://evil.example/')).status,409);assert.equal((await h.window.sundarkFetch('/api/auth/login')).status,501);assert.equal(h.requests.length,0);});
