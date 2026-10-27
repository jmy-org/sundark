// translateBatch runs one attempt, so a batch with a missing result must fill its placeholders
// without holding the worker in a retry pause. Executes the adapted original functions.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
const source=readFileSync(new URL('../public/sundark-original/app.js',import.meta.url),'utf8');
function fn(name){const start=source.search(new RegExp('(?:async )?function '+name+'\\('));assert(start>=0,name);return source.slice(start,source.indexOf('\n}',start)+2);}
const PH='[ChatGPT에서 생성·저장 필요]';
const calls={stream:[],sleeps:[],paints:0,rateBanner:0};let stream=async()=>{};
const context=vm.createContext({
  sleep:ms=>{calls.sleeps.push(ms);return Promise.resolve();},
  streamTranslate:(...args)=>{calls.stream.push(args);return stream(...args);},
  paintFrontier:()=>{calls.paints++;},showRateLimit:()=>{calls.rateBanner++;},
});
vm.runInContext('class RateLimited extends Error {}\nconst S={trToken:1,rateLimited:null,pages:[]};\n'+fn('fillSource')+'\n'+fn('translateBatch')+'\nglobalThis.state=S;globalThis.RL=RateLimited;',context);
const state=context.state;
const run=async(setup,{start=3,texts=['a','b','c']}={})=>{
  calls.stream.length=0;calls.sleeps.length=0;calls.paints=0;calls.rateBanner=0;state.rateLimited=null;state.trToken=1;
  const P={trBuf:Array(9).fill(null)};P.trBuf[0]='earlier';P.trBuf[8]='later';state.pages=[P];stream=setup;
  await context.translateBatch(0,{start,texts},false,1,'ko');return P.trBuf;
};
// 1. Missing result (the adapter's 409 is a plain Error): one call, the batch's slots get the
// placeholder, slots outside the batch are untouched, and no retry pause is scheduled.
{
  const buf=await run(async()=>{throw new Error('missing saved translation');});
  assert.equal(calls.stream.length,1,'one attempt, no retry');
  assert.deepEqual(calls.stream[0].slice(0,4),[0,3,['a','b','c'],false]);
  assert.deepEqual(buf,['earlier',null,null,PH,PH,PH,null,null,'later']);
  assert.deepEqual(calls.sleeps,[],'no pause after the only attempt');
  assert(calls.paints>=1,'placeholder fill repaints the frontier');
}
// 2. Partial result: written sentences stay, only the gap gets the placeholder, no pause.
{
  const buf=await run(async(page,off,texts,force,write)=>{write(off,'A');write(off+2,'C');});
  assert.equal(calls.stream.length,1);
  assert.deepEqual(buf.slice(3,6),['A',PH,'C']);
  assert.deepEqual(calls.sleeps,[]);
}
// 3. Full saved result: unchanged, no placeholder, no pause.
{
  const buf=await run(async(page,off,texts,force,write)=>{texts.forEach((t,i)=>write(off+i,t.toUpperCase()));});
  assert.deepEqual(buf,['earlier',null,null,'A','B','C',null,null,'later']);
  assert.equal(calls.stream.length,1);assert.deepEqual(calls.sleeps,[]);
}
// 4. Rate limit: still stops the run, shows the banner once and fills the batch.
{
  const buf=await run(async()=>{throw new context.RL('rate_limited');});
  assert.equal(state.rateLimited,1);assert.equal(calls.rateBanner,1);assert.equal(calls.stream.length,1);
  assert.deepEqual(buf.slice(3,6),[PH,PH,PH]);assert.deepEqual(calls.sleeps,[]);
}
// 5. A retranslate during the request (token bumped): the old run writes nothing.
{
  const buf=await run(async(page,off,texts,force,write)=>{state.trToken=2;write(off,'stale');throw new Error('late');});
  assert.deepEqual(buf.slice(3,6),[null,null,null]);assert.deepEqual(calls.sleeps,[]);
}
console.log('Original reader translateBatch passed: missing/partial/full/rate-limit/stale cases, one attempt, no retry pause.');
