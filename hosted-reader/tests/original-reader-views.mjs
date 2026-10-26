// The four AI views are native toggle buttons: the adapted Tabs handler moves aria-pressed with the
// active class, each button controls the pane that its id names, and the selection's Ask-in-chat
// switch goes through the same click. Runs the real handlers in a VM over the serialized markup.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
const source=readFileSync(new URL('../public/sundark-original/app.js',import.meta.url),'utf8');
const ts=readFileSync(new URL('../lib/original-html.ts',import.meta.url),'utf8');
const html=JSON.parse(ts.slice(ts.indexOf('"'),ts.lastIndexOf('"')+1));
const section=title=>{const start=source.indexOf('// ================= '+title);assert(start>=0,title);return source.slice(start,source.indexOf('\n// ================= ',start+10));};
const askStart=source.indexOf('$("btn-ask").addEventListener');assert(askStart>=0,'Ask-in-chat handler exists');
const askSrc=source.slice(askStart,source.indexOf('\n});',askStart)+4);

const attrs=tag=>Object.fromEntries([...tag.matchAll(/([\w-]+)="([^"]*)"/g)].map(m=>[m[1],m[2]]));
class El{
  constructor(a={},text=''){this.attrs={...a};this.cls=new Set((a.class||'').split(/\s+/).filter(Boolean));this.dataset={tab:a['data-tab']};this.textContent=text;this.listeners={};}
  get id(){return this.attrs.id;}get type(){return this.attrs.type;}
  get classList(){const c=this.cls;return {add:x=>c.add(x),remove:x=>c.delete(x),contains:x=>c.has(x),toggle:(x,on)=>(on?c.add(x):c.delete(x))};}
  getAttribute(k){return this.attrs[k]??null;}setAttribute(k,v){this.attrs[k]=String(v);}
  addEventListener(t,f){(this.listeners[t]=this.listeners[t]||[]).push(f);}
  click(){for(const f of this.listeners.click||[])f({currentTarget:this,target:this});}
  focus(){doc.activeElement=this;}
}
const groupTag=html.match(/<div class="tabs"[^>]*>/)[0];
const buttons=[...html.slice(html.indexOf(groupTag),html.indexOf('</div>',html.indexOf(groupTag))).matchAll(/<button([^>]*)>([^<]*)<\/button>/g)].map(m=>new El(attrs(m[1]),m[2]));
const panes=[...html.matchAll(/<div class="tabpane[^"]*"[^>]*>/g)].map(m=>new El(attrs(m[0])));
const byId=new Map([...buttons,...panes].map(e=>[e.id,e]));
const doc={activeElement:null,querySelectorAll:sel=>({'.tab':buttons,'.tabpane':panes})[sel]||assert.fail('selector '+sel),
  querySelector:sel=>{const m=sel.match(/^\.tab\[data-tab="(\w+)"\]$/);assert(m,'selector '+sel);return buttons.find(b=>b.dataset.tab===m[1]);}};
const other=new Map();const $=id=>byId.get(id)||other.get(id)||(other.set(id,new El({id})),other.get(id));
const calls={anatomy:0,summary:0,pane:[]};
const context=vm.createContext({document:doc,$,S:{docId:'d1',summaryLoaded:false},
  loadAnatomy:()=>{calls.anatomy++;},genSummary:()=>{calls.summary++;context.S.summaryLoaded=true;},
  hide(){},setChatCite(){},fitChatInput(){},showPane:p=>calls.pane.push(p)});
vm.runInContext(section('Tabs')+'\nlet lastSelection = "";\n'+askSrc+'\nglobalThis.select=t=>{lastSelection=t;};',context);

// Markup: a labelled group of four native buttons, each controlling a region it names.
assert.match(groupTag,/role="group"/);assert.match(groupTag,/aria-label="AI views"/);
assert.deepEqual(buttons.map(b=>b.textContent),['Translation','Anatomy','Summary','Chat'],'Tab order is unchanged');
for(const b of buttons){
  assert.equal(b.type,'button');assert.equal(b.id,'tabbtn-'+b.dataset.tab);assert.equal(b.getAttribute('tabindex'),null,'no roving tabindex');
  const pane=byId.get(b.getAttribute('aria-controls'));
  assert(pane&&pane.cls.has('tabpane'),b.id+' controls an existing pane');
  assert.equal(pane.id,'tab-'+b.dataset.tab);assert.equal(pane.getAttribute('role'),'region');
  assert.equal(byId.get(pane.getAttribute('aria-labelledby')),b,pane.id+' is named by its button');
}
const view=(tab,label)=>{
  assert.deepEqual(buttons.filter(b=>b.getAttribute('aria-pressed')==='true').map(b=>b.dataset.tab),[tab],label+': one pressed view');
  for(const b of buttons){
    assert.equal(b.cls.has('active'),b.getAttribute('aria-pressed')==='true',label+': '+b.id+' class matches aria-pressed');
    assert.equal(byId.get(b.getAttribute('aria-controls')).cls.has('active'),b.dataset.tab===tab,label+': '+b.id+' pane shown');
  }
};
view('translation','initial');

// Activation: the native click (Enter and Space click a button) updates state and loads lazily.
const btn=tab=>buttons.find(b=>b.dataset.tab===tab);
btn('anatomy').click();view('anatomy','anatomy');assert.equal(calls.anatomy,1);
btn('summary').click();view('summary','summary');assert.equal(calls.summary,1);
btn('translation').click();view('translation','back');
btn('summary').click();view('summary','summary again');assert.equal(calls.summary,1,'a loaded summary is not generated again');

// Ask-in-chat clicks the Chat button, so it goes through the same update.
context.select('selected source text');
$('btn-ask').click();
view('chat','Ask in chat');
assert.equal(doc.activeElement,$('chatinput'));
assert.deepEqual([calls.anatomy,calls.summary],[1,1],'switching views starts no other generation');
console.log('Original reader AI views expose the pressed view and its region.');
