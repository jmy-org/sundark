// Folder rows run through the adapted loadLibrary: each opens from a native button, so Tab,
// Enter and Space reach it, while the selected state stays on the row.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
const source=readFileSync(new URL('../public/sundark-original/app.js',import.meta.url),'utf8');
function fn(name){const start=source.search(new RegExp('(?:async )?function '+name+'\\('));assert(start>=0,name);return source.slice(start,source.indexOf('\n}',start)+2);}
const el=tag=>({tagName:tag.toUpperCase(),children:[],listeners:{},textContent:'',_html:'',set innerHTML(v){this.children=[];this._html=v;},get innerHTML(){return this._html;},appendChild(c){this.children.push(c);return c;},addEventListener(t,f){this.listeners[t]=f;}});
const nodes=new Map();const $=id=>{if(!nodes.has(id))nodes.set(id,el('div'));return nodes.get(id);};
const opened=[];
const context=vm.createContext({$,document:{createElement:el},esc:String,fetch:async()=>({json:async()=>({dir:'서재',papers:[{rel:'a.pdf',name:'Alpha Study',file:'a.pdf',size:2048}]})}),openFromLibrary:(rel,li)=>opened.push({rel,li})});
vm.runInContext('let libSource="folder";let folderGen=0;\n'+fn('fmtSize')+'\n'+fn('loadLibrary'),context);
await context.loadLibrary();
const [li]=$('paperlist').children;
assert.equal(li.tagName,'LI');
const [button]=li.children;
assert.equal(button?.tagName,'BUTTON','a Folder row opens from a native keyboard control');
assert.equal(button.type,'button');
assert.equal(button.className,'paper-action');
assert.equal(button.innerHTML,'Alpha Study<span class="meta">a.pdf · 2 KB</span>','the control names the full visible row');
assert.equal(li.listeners.click,undefined,'the row itself carries no second click target');
button.listeners.click();
assert.deepEqual(opened,[{rel:'a.pdf',li}],'activation opens the paper and marks its row');
console.log('Original reader Folder rows open from native buttons.');
