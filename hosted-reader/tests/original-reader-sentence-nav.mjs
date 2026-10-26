// The Translation sentence navigator: native Previous/Next/Pin source buttons reach the same pin and
// source-scroll path as a mouse click. Executes the adapted original functions in a VM over a small
// fake DOM, plus the serialized markup and stylesheet the navigator relies on.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
const source=readFileSync(new URL('../public/sundark-original/app.js',import.meta.url),'utf8');
const css=readFileSync(new URL('../public/sundark-original/styles.css',import.meta.url),'utf8');
const html=readFileSync(new URL('../lib/original-html.ts',import.meta.url),'utf8');
function fn(name){const start=source.search(new RegExp('\\n(?:async )?function '+name+'\\('));assert(start>=0,name);return source.slice(start,source.indexOf('\n}',start)+2);}
const navStart=source.indexOf('// ================= Sentence navigator');
assert(navStart>=0,'sentence navigator section exists');
const navSrc=source.slice(navStart,source.indexOf('\n// ================= ',navStart+10));
const escLine=source.split('\n').find(l=>l.startsWith('document.addEventListener("keydown"')&&l.includes('Escape'));
assert(escLine,'Escape handler exists');

class El{
  constructor(tag,doc){Object.assign(this,{tagName:tag,doc,children:[],parent:null,cls:new Set(),dataset:{},attrs:{},listeners:{},_text:'',style:{},disabled:false,hovered:false,scrolled:0});}
  get classList(){const c=this.cls;return {add:x=>c.add(x),remove:x=>c.delete(x),contains:x=>c.has(x),toggle:(x,on)=>(on?c.add(x):c.delete(x))};}
  set className(v){this.cls=new Set(v.split(/\s+/).filter(Boolean));}
  get textContent(){return this.children.length?this.children.map(c=>c.textContent).join(''):this._text;}
  set textContent(v){this.detach();this._text=String(v);}
  set innerHTML(v){this.detach();this._text='';this.htmlSet=(this.htmlSet||[]).concat(v);}
  get childNodes(){if(this.children.length)return this.children;if(!this._text)return [];const t=new El('#text',this.doc);t._text=this._text;t.parent=this;return [t];}
  get nextElementSibling(){const s=this.parent?.children;return s?s[s.indexOf(this)+1]||null:null;}
  detach(){for(const c of this.children)c.parent=null;this.children=[];}
  appendChild(c){c.remove?.();c.parent=this;this.children.push(c);return c;}
  replaceChildren(){this.detach();this._text='';}
  remove(){if(this.parent)this.parent.children=this.parent.children.filter(c=>c!==this);this.parent=null;}
  contains(x){for(let n=x;n;n=n.parent)if(n===this)return true;return false;}
  get isConnected(){return this.doc.body.contains(this);}
  all(){return this.children.flatMap(c=>[c,...c.all()]);}
  matchOne(sel){const m=sel.match(/^((?:\.[\w-]+)+)((?:\[[\w-]+="[^"]*"\])*)$/);assert(m,'selector '+sel);
    if(!m[1].split('.').filter(Boolean).every(c=>this.cls.has(c)))return false;for(const [,k,v] of m[2].matchAll(/\[data-([\w-]+)="([^"]*)"\]/g))if(String(this.dataset[k])!==v)return false;return true;}
  querySelectorAll(sel){return this.all().filter(e=>e.matchOne(sel));}
  querySelector(sel){return this.querySelectorAll(sel)[0]||null;}
  addEventListener(type,f){(this.listeners[type]=this.listeners[type]||[]).push(f);}
  fire(type,ev={}){for(const f of this.listeners[type]||[])f({currentTarget:this,target:this,...ev});}
  setAttribute(k,v){this.attrs[k]=String(v);}getAttribute(k){return this.attrs[k];}
  focus(){this.doc.activeElement=this;}
  matches(sel){return sel===':hover'&&this.hovered;}
  scrollIntoView(){this.scrolled+=1;}
  cloneNode(deep){const c=new El(this.tagName,this.doc);c._text=this._text;c.cls=new Set(this.cls);if(deep)for(const k of this.children)c.appendChild(k.cloneNode(true));return c;}
}

const line=head=>{const l=source.split('\n').find(l=>l.startsWith(head));assert(l,head);return l;};
// real: the Auto-translate checkbox and the translation run it starts, over saved results that
// answer every batch at once. pdf: the real highlight layers, PDF hover handlers and page teardown.
function setup({real=false,pdf=false}={}){
  const calls={hover:[],highlight:[],math:[],batches:[]};
  const doc={listeners:{},activeElement:null};doc.body=new El('body',doc);
  doc.addEventListener=(t,f)=>(doc.listeners[t]=doc.listeners[t]||[]).push(f);
  doc.createElement=t=>new El(t,doc);
  doc.createTextNode=t=>{const n=new El('#text',doc);n._text=t;return n;};
  doc.querySelectorAll=sel=>doc.body.querySelectorAll(sel);
  const nodes=new Map();
  const $=id=>{if(!nodes.has(id)){const e=new El('div',doc);e.id=id;doc.body.appendChild(e);nodes.set(id,e);}return nodes.get(id);};
  for(const id of ['trnav-prev','trnav-next','trnav-pin'])$(id).disabled=true;
  $('trnav-pos').textContent='None selected';
  let mathReply=null;
  const context=vm.createContext({console,document:doc,$,window:{},
    ...(pdf?{sourceSegmentAt:()=>null,partAt:()=>0,scrollTrTo(){},segParts:()=>[],partY(){},segMidY(){}}:{stopRender(){},
    setHover:(page,k,on)=>{calls.hover.push([page,k,on]);const t=$('trlist').querySelector(`.trseg[data-page="${page}"][data-i="${k}"]`);if(t)t.classList.toggle('hl',on);}}),
    highlightSource:(page,k,on,scroll)=>{calls.highlight.push([page,k,on,scroll]);context.setHover(page,k,on);},
    renderMath:el=>{calls.math.push(el);},
    ...(real?{}:{translateAll(){}}),
    fetch:async()=>({ok:true,json:async()=>mathReply}),
    lang:()=>'ko',hide(){},sleep:()=>Promise.resolve(),ensureLayout:async()=>{},
    translateBatch:async(page,b,force,token)=>{calls.batches.push([page,b.start,force]);const P=context.state.pages[page];
      if(token!==context.state.trToken||!P.trBuf)return;b.texts.forEach((t,j)=>{P.trBuf[b.start+j]='번역 '+t;});context.paintFrontier();},
  });
  vm.runInContext(source.slice(source.indexOf('const S = {'),source.indexOf('\n};',source.indexOf('const S = {'))+3)+
    '\nconst BULLET_RE = /^\\s*[•◦▪▫●○‣⁃∙]/;\n'+
    ['beginPaperOpen','buildTrShells','paintFrontier','paragraphBatches','preparePage','fetchMath','makeTrSeg','toggleTrPin','unpinTr','retranslateAll'].map(fn).join('\n')+
    '\n'+escLine+'\n'+line('let pdfHoverCur = null;')+'\nfunction setPdfHover(v){pdfHoverCur=v;}\n'+navSrc+
    (pdf?'\n'+['drawHlRects','setHover','attachPdfHover','clearPdfHover','stopRender'].map(fn).join('\n'):'')+
    (real?'\n'+[line('$("autotr").addEventListener("change"'),line('const trPool = '),fn('translateAll')].join('\n'):'')+
    '\nglobalThis.state=S;',context);
  const S=context.state;
  if(pdf)S.scale=1;
  // Two pages: page 0 has three sentences (the third comes back empty), page 1 has one.
  const open=()=>{
    S.docId='A';S.numPages=2;
    S.pages=[{segs:[{text:'a',para:0},{text:'b',para:0},{text:'c',para:1}]},{segs:[{text:'d',para:0}]}];
    context.buildTrShells();context.preparePage(0);context.preparePage(1);
  };
  const seg=(page,k)=>S.pages[page].spanByK[k];
  const put=(page,k,t)=>{S.pages[page].trBuf[k]=t;context.paintFrontier();};
  const keydown=key=>{for(const f of doc.listeners.keydown||[])f({key});};
  // Each page's PDF side as renderPage draws it: a highlight layer and a text layer with the hover
  // handlers. Sentence k sits at x = 10k; next gives page 0's last sentence a continuation at x = 50
  // on page 1.
  const layers=({next=false}={})=>S.pages.forEach((P,i)=>{
    P.el=$('pdfview').appendChild(doc.createElement('div'));P.hllayer=P.el.appendChild(doc.createElement('div'));
    P.textEl=P.el.appendChild(doc.createElement('div'));
    P.segs.forEach((g,k)=>{g.rects=[{left:10*k,top:0,w:5,h:5}];});
    if(next&&i===0)Object.assign(P.segs.at(-1),{nextPage:1,rectsNext:[{left:50,top:0,w:5,h:5}]});
    context.attachPdfHover(i,P.textEl);
  });
  // The pointer over sentence k of page pg, on page on's text layer.
  const pointAt=(on,pg,k)=>{const w={_seg:k,_segPage:pg===on?undefined:pg};w.closest=()=>w;S.pages[on].textEl.fire('mousemove',{target:w});};
  // What a page's highlight layer shows: the x of each rect drawn (rings and fills alike).
  const drawn=page=>S.pages[page].hllayer.children.map(d=>d.style.left);
  return {context,S,$,doc,calls,open,seg,put,keydown,layers,pointAt,drawn,setMath:r=>{mathReply=r;}};
}
const state=t=>({prev:t.$('trnav-prev').disabled,next:t.$('trnav-next').disabled,pin:t.$('trnav-pin').disabled,
  pressed:t.$('trnav-pin').getAttribute('aria-pressed'),pos:t.$('trnav-pos').textContent});
function assertCleared(t,label){
  assert.equal(t.S.trSel,null,label+': no selection');
  assert.equal(t.$('trnav-prev').disabled,true,label+': Previous disabled');
  assert.equal(t.$('trnav-pin').disabled,true,label+': Pin disabled');
  assert.equal(t.$('trnav-pin').getAttribute('aria-pressed'),'false',label+': Pin unpressed');
  assert.equal(t.$('trnav-pos').textContent,'None selected',label+': no position');
  assert.equal(t.$('trnav-preview').children.length+t.$('trnav-preview').textContent.length,0,label+': preview empty');
  assert.equal(t.$('trnav-status').textContent,'',label+': status empty');
  assert.equal(t.doc.body.querySelectorAll('.trseg.pinned').length+t.doc.body.querySelectorAll('.trseg.hl').length,0,label+': no pin or highlight');
}

// 1. Painting order: a sentence buffered out of order is not navigable until the frontier paints it,
//    and an empty translation is skipped. Painting never announces.
{
  const t=setup();t.open();
  assert.equal(state(t).next,true,'nothing painted: Next disabled');
  t.put(0,1,'second');
  assert.equal(state(t).next,true,'a later sentence buffered first is not painted, so not navigable');
  t.put(0,0,'first');t.put(0,2,'');t.put(1,0,'fourth');
  assert.equal(state(t).next,false,'painted sentences enable Next');
  assert.equal(t.$('trnav-status').textContent,'','painting does not announce');
  const order=[];
  while(!t.$('trnav-next').disabled){t.$('trnav-next').fire('click');order.push(t.$('trnav-pos').textContent);}
  assert.deepEqual(order,['Page 1, sentence 1','Page 1, sentence 2','Page 2, sentence 1'],'document order, empty sentence skipped');
  assert.equal(t.$('trnav-status').textContent,'Page 2, sentence 1','a move announces the place');
  t.$('trnav-prev').fire('click');t.$('trnav-prev').fire('click');
  assert.equal(t.$('trnav-pos').textContent,'Page 1, sentence 1');assert.equal(state(t).prev,true,'first sentence: Previous disabled');
  assert.equal(t.seg(0,0).cls.has('selected'),true,'selected sentence marked');
  assert(t.seg(0,0).scrolled>0,'selected sentence scrolled into the bounded list');
  for(const s of t.doc.body.querySelectorAll('.trseg')){assert.equal(s.attrs.tabindex,undefined,'no per-span tabindex');assert.equal(s.attrs.role,undefined,'no per-span role');}
}

// 2. Mouse click keeps its semantics (pin, highlight, centred scroll; a second click releases) and
//    also selects; Pin source toggles the same pin with aria-pressed; Escape releases.
{
  const t=setup();t.open();t.put(0,0,'first');t.put(0,1,'second');t.put(0,2,'third');t.put(1,0,'fourth');
  const s=t.seg(0,1);s.hovered=true;s.fire('mouseenter');s.fire('click');
  assert.deepEqual(t.calls.highlight.at(-1),[0,1,true,'center'],'click scrolls the PDF to the source');
  assert.equal(s.cls.has('pinned'),true);assert.equal(t.S.trSel,s,'click selects');
  assert.deepEqual(state(t),{prev:false,next:false,pin:false,pressed:'true',pos:'Page 1, sentence 2'});
  s.fire('click');assert.equal(s.cls.has('pinned'),false,'second click releases');
  assert.equal(s.cls.has('hl'),true,'the pointer still owns the hover highlight');
  assert.equal(state(t).pressed,'false');
  s.hovered=false;s.fire('mouseleave');assert.equal(s.cls.has('hl'),false,'mouseleave clears the highlight');
  t.$('trnav-pin').fire('click');
  assert.equal(s.cls.has('pinned'),true,'Pin source pins the selected sentence');
  assert.equal(s.cls.has('hl'),true,'Pin source highlights it');assert.equal(state(t).pressed,'true');
  t.keydown('Escape');
  assert.equal(s.cls.has('pinned'),false,'Escape releases');assert.equal(s.cls.has('hl'),false,'a keyboard pin clears its highlight');
  assert.equal(state(t).pressed,'false');assert.equal(t.S.trSel,s,'selection survives Escape');
  t.$('trnav-pin').fire('click');t.$('trnav-next').fire('click');
  assert.equal(s.cls.has('pinned')||s.cls.has('hl'),false,'moving the selection releases the pin');
  assert.equal(t.doc.body.querySelectorAll('.trseg.pinned').length,0);
}

// 3. Preview: clones of the painted sentence's DOM (no markup string), refreshed when math lands.
{
  const t=setup();t.open();t.put(0,0,'first');t.put(0,1,'x');t.put(0,2,'third');t.put(1,0,'fourth');
  t.$('trnav-next').fire('click');t.$('trnav-next').fire('click');
  const s=t.seg(0,1);const box=t.$('trnav-preview');
  assert.equal(box.textContent,'x');assert.notEqual(box.children[0],s.childNodes[0],'preview holds copies');
  assert.equal(box.htmlSet,undefined,'preview never assigns markup');
  t.setMath({equations:[{i:1,latex:'y'}]});await t.context.fetchMath(0);
  assert.equal(s.textContent,'\\[ y \\]');assert.equal(box.textContent,'\\[ y \\]','math refresh updates the preview');
  assert(t.calls.math.includes(box),'preview math rendered');
}

// 4. A Next/Previous press that reaches the end hands focus to Pin source, only if it was focused.
{
  const t=setup();t.open();t.put(0,0,'first');t.put(0,1,'second');t.put(0,2,'third');t.put(1,0,'fourth');
  t.$('trnav-next').focus();for(let i=0;i<4;i++)t.$('trnav-next').fire('click');
  assert.equal(t.$('trnav-next').disabled,true);assert.equal(t.doc.activeElement,t.$('trnav-pin'),'focus kept in the group');
  t.$('trnav-prev').focus();t.$('trnav-prev').fire('click');
  assert.equal(t.doc.activeElement,t.$('trnav-prev'),'focus stays on an enabled button');
  const other=t.$('chatinput');other.focus();for(let i=0;i<4;i++)t.$('trnav-prev').fire('click');
  assert.equal(t.$('trnav-prev').disabled,true);assert.equal(t.doc.activeElement,other,'an unfocused press does not move focus');
}

// 5. Reset: opening another paper, a failed open's cleanup and reloading saved results all drop the
//    old selection, pin and highlight; the next paint re-enables Next.
for(const how of ['open','retranslate','failure']){
  const t=setup();t.open();t.put(0,0,'first');t.put(0,1,'second');t.put(0,2,'third');t.put(1,0,'fourth');
  t.$('trnav-next').fire('click');t.$('trnav-pin').fire('click');
  assert.equal(t.doc.body.querySelectorAll('.trseg.hl').length,1);
  const before=t.calls.hover.length;
  if(how==='open')t.context.beginPaperOpen();
  else if(how==='retranslate')t.context.retranslateAll();
  else{const old=t.S.trSel;t.context.resetTrNav();assert.equal(old.isConnected,false,how+': old spans gone');}
  assert(t.calls.hover.slice(before).some(([p,k,on])=>p===0&&k===0&&!on),how+': source highlight released');
  assertCleared(t,how);
  assert.equal(t.$('trnav-next').disabled,true,how+': nothing to select');
  if(how==='retranslate'){t.context.preparePage(0);t.context.preparePage(1);t.put(0,0,'again');assert.equal(t.$('trnav-next').disabled,false,how+': repaint enables Next');}
}
assert.match(fn('beginPaperOpen'),/resetTrNav\(\)/,'beginPaperOpen resets the navigator');
assert.match(fn('openDoc').slice(fn('openDoc').indexOf('catch (err)')),/resetTrNav\(\)/,'a failed open resets the navigator');

// 8. Reloading saved results takes down every source highlight its detached spans hold (none of
//    them will get a mouseleave), except the sentence the pointer owns on the PDF, which stays.
{
  const t=setup();t.open();t.put(0,0,'first');t.put(0,1,'second');t.put(0,2,'third');t.put(1,0,'fourth');
  const s=t.seg(0,1);s.hovered=true;s.fire('mouseenter');
  let before=t.calls.hover.length;t.context.retranslateAll();
  assert.equal(s.isConnected,false,'the hovered span was replaced');
  assert.deepEqual(t.calls.hover.slice(before),[[0,1,false]],'a hovered sentence\'s highlight outlived its span');
  assertCleared(t,'hover only');
  // The pointer is on sentence 2 in the PDF, which the keyboard also pinned: the pin goes, the bar stays.
  t.context.preparePage(0);t.context.preparePage(1);t.put(0,0,'first');t.put(0,1,'second');t.put(0,2,'third');
  t.context.setPdfHover({page:0,k:1,part:0});
  t.$('trnav-next').fire('click');t.$('trnav-next').fire('click');t.$('trnav-pin').fire('click');
  before=t.calls.hover.length;t.context.retranslateAll();
  assert.deepEqual(t.calls.hover.slice(before),[],'releasing the pin cleared the PDF-owned highlight');
  assert.equal(t.$('trnav-pin').getAttribute('aria-pressed'),'false');
  // Another sentence on the same page pinned from the keyboard: clearing it wipes the page's layer,
  // so the PDF-owned bar is drawn again.
  t.context.preparePage(0);t.context.preparePage(1);t.put(0,0,'first');t.put(0,1,'second');t.put(0,2,'third');
  t.context.setHover(0,1,true);
  t.$('trnav-next').fire('click');t.$('trnav-pin').fire('click');
  before=t.calls.hover.length;t.context.retranslateAll();
  assert.deepEqual(t.calls.hover.slice(before),[[0,0,false],[0,1,true]],'the pin\'s page wipe took the PDF-owned highlight with it');
}

// 9. The real PDF highlight layers under a rebuilt list. The pointer owns a sentence only through a
//    live text layer: a layer torn down without a mouseleave (another paper opening, a zoom, a page
//    scrolled far away) takes its sentence with it, while a same-paper rebuild keeps it drawn.
{
  const paint=t=>{t.put(0,0,'first');t.put(0,1,'second');t.put(0,2,'third');t.put(1,0,'fourth');};
  const pinAt=(t,n)=>{for(let j=0;j<n;j++)t.$('trnav-next').fire('click');t.$('trnav-pin').fire('click');};
  const reload=t=>{t.context.retranslateAll();t.context.preparePage(0);t.context.preparePage(1);};
  const bar=x=>[x,x];  // a rect's ring and its fill
  // Another paper reuses the old one's sentence numbers: the old pointer owns nothing in it.
  for(const pinK of [0,1]){
    const t=setup({pdf:true});t.open();t.layers();paint(t);
    t.pointAt(0,0,0);assert.deepEqual(t.drawn(0),bar('0px'));
    t.context.beginPaperOpen();t.open();t.layers();paint(t);
    pinAt(t,pinK+1);assert.deepEqual(t.drawn(0),bar(pinK*10+'px'));
    reload(t);
    assert.deepEqual(t.drawn(0),[],`the old paper's pointer kept the new paper's sentence ${pinK} drawn`);
    paint(t);assert.equal(t.doc.body.querySelectorAll('.trseg.hl').length,0);
    t.pointAt(0,0,0);assert.deepEqual(t.drawn(0),bar('0px'),'the old paper\'s pointer swallowed the first move over the new one');
  }
  // The pointer on sentence 1 of a live page: a keyboard pin on it or on a neighbour goes with the
  // list, and the pointer's bar is what the page shows afterwards.
  for(const pinK of [1,2]){
    const t=setup({pdf:true});t.open();t.layers();paint(t);
    t.pointAt(0,0,1);pinAt(t,pinK+1);assert.deepEqual(t.drawn(0),bar(pinK*10+'px'));
    reload(t);
    assert.deepEqual(t.drawn(0),bar('10px'),`a pin on sentence ${pinK} took the pointer's bar`);
    assert.equal(t.$('trnav-pin').getAttribute('aria-pressed'),'false');
  }
  // The pointer on page 2 over the continuation of page 1's last sentence; a keyboard pin on page
  // 2's own sentence shares only that continuation page. Both halves are drawn after.
  {
    const t=setup({pdf:true});t.open();t.layers({next:true});paint(t);
    t.pointAt(1,0,2);assert.deepEqual([t.drawn(0),t.drawn(1)],[bar('20px'),bar('50px')]);
    pinAt(t,4);assert.deepEqual([t.drawn(0),t.drawn(1)],[bar('20px'),bar('0px')]);
    reload(t);
    assert.deepEqual([t.drawn(0),t.drawn(1)],[bar('20px'),bar('50px')],'the continuation\'s half was lost');
    // Page 1's text layer going leaves the pointer on page 2 with its sentence; page 2's takes it.
    t.context.stopRender(t.S.pages[0],true);assert.deepEqual([t.drawn(0),t.drawn(1)],[bar('20px'),bar('50px')]);
    t.context.stopRender(t.S.pages[1],true);
    assert.deepEqual([t.drawn(0),t.drawn(1)],[[],[]],'a removed layer\'s pointer kept its sentence');
  }
  // No pointer on the PDF: a keyboard pin clears with Escape, and with a rebuilt list.
  {
    const t=setup({pdf:true});t.open();t.layers();paint(t);
    pinAt(t,2);assert.deepEqual(t.drawn(0),bar('10px'));
    t.keydown('Escape');assert.deepEqual(t.drawn(0),[]);
    t.$('trnav-pin').fire('click');assert.deepEqual(t.drawn(0),bar('10px'));
    reload(t);assert.deepEqual(t.drawn(0),[],'a rebuilt list left the keyboard pin drawn');
  }
  // A PDF hover over another sentence takes the page's one layer from the pin; when the pointer
  // leaves, the pinned sentence is drawn again. Without a pin, or once it is released, nothing is.
  {
    const t=setup({pdf:true});t.open();t.layers({next:true});paint(t);
    const leave=p=>t.S.pages[p].textEl.fire('mouseleave');
    const hl=()=>t.doc.body.querySelectorAll('.trseg.hl').map(x=>[x.dataset.page,x.dataset.i]);
    t.pointAt(0,0,1);leave(0);assert.deepEqual([t.drawn(0),hl()],[[],[]],'a hover with no pin left a bar behind');
    pinAt(t,2);const pinned=t.S.trSel;assert.deepEqual(t.drawn(0),bar('10px'));
    t.pointAt(0,0,2);assert.deepEqual([t.drawn(0),t.drawn(1)],[bar('20px'),bar('50px')],'the hover is drawn as before');
    leave(0);assert.deepEqual([t.drawn(0),t.drawn(1)],[bar('10px'),[]],'the pin was not drawn again');
    assert.deepEqual(hl(),[[0,1]]);assert.equal(t.S.trSel,pinned);assert(pinned.cls.has('pinned'));
    assert.equal(t.$('trnav-pin').getAttribute('aria-pressed'),'true');
    // The pointer leaving the pinned sentence itself.
    t.pointAt(0,0,1);leave(0);assert.deepEqual([t.drawn(0),hl()],[bar('10px'),[[0,1]]],'leaving the pinned sentence cleared it');
    // A pin across the page break; the hover on the next page takes its second half there.
    pinAt(t,1);assert.deepEqual([t.drawn(0),t.drawn(1)],[bar('20px'),bar('50px')]);
    t.pointAt(1,1,0);assert.deepEqual([t.drawn(0),t.drawn(1)],[bar('20px'),bar('0px')]);
    leave(1);assert.deepEqual([t.drawn(0),t.drawn(1)],[bar('20px'),bar('50px')],'the pin\'s second half was lost');
    // Released with Escape, or with a rebuilt list, while the pointer is on the PDF.
    t.pointAt(0,0,0);t.keydown('Escape');leave(0);
    assert.deepEqual([t.drawn(0),t.drawn(1),hl()],[[],[],[]],'a released pin came back');
    t.$('trnav-pin').fire('click');t.pointAt(0,0,0);reload(t);paint(t);leave(0);
    assert.deepEqual([t.drawn(0),t.drawn(1),hl()],[[],[],[]],'a rebuilt list\'s pin came back');
  }
}

// 7. Auto-translate off and on again after a keyboard pin on a finished document: off changes
//    nothing; on rebuilds the list from saved results (nothing forced), releases the old sentence
//    and its source highlight, and the repainted sentences are navigable. A sentence whose span
//    is gone can never be pinned.
{
  const t=setup({real:true});const autotr=t.$('autotr');autotr.checked=true;
  t.S.aiConfig={backend:'chatgpt',concurrency:{chatgpt:2}};
  t.open();await t.context.translateAll();
  assert.equal(t.S.frontier,2,'the first run painted the whole document');
  t.$('trnav-next').fire('click');t.$('trnav-next').fire('click');t.$('trnav-pin').fire('click');
  const old=t.S.trSel;
  assert.equal(t.$('trnav-pos').textContent,'Page 1, sentence 2');assert.equal(old.cls.has('hl'),true,'keyboard pin drew the highlight');
  t.calls.batches=[];autotr.checked=false;autotr.fire('change');await new Promise(r=>setImmediate(r));
  assert.equal(t.S.trSel,old,'off keeps the selection');assert.equal(old.isConnected&&old.cls.has('pinned'),true,'off keeps the pin');
  assert.deepEqual(t.calls.batches,[],'off starts nothing');
  const before=t.calls.hover.length;
  autotr.checked=true;autotr.fire('change');for(let i=0;i<5;i++)await new Promise(r=>setImmediate(r));
  assert.equal(old.isConnected,false,'the old span was replaced');
  assert.equal(old.cls.has('pinned')||old.cls.has('hl'),false,'the old sentence was released');
  assert.deepEqual(t.calls.hover.slice(before),[[0,1,false]],'its source highlight was cleared');
  assert(t.calls.batches.length>0&&t.calls.batches.every(([,,force])=>!force),'saved results reused, nothing forced');
  assert.equal(t.S.frontier,2,'the frontier ran over the rebuilt list');
  assert.deepEqual(t.doc.body.querySelectorAll('.trseg').map(d=>d.textContent),['번역 a','번역 b','번역 c','번역 d'],'rebuilt list painted');
  assertCleared(t,'autotr');assert.equal(t.$('trnav-next').disabled,false,'autotr: Next ready');
  t.calls.highlight=[];t.S.trSel=old;t.$('trnav-pin').fire('click');
  assert.deepEqual(t.calls.highlight,[],'a removed sentence was pinned');
  assertCleared(t,'detached pin');
  for(let i=0;i<4;i++)t.$('trnav-next').fire('click');
  assert.equal(t.$('trnav-pos').textContent,'Page 2, sentence 1');assert.equal(t.S.trSel.isConnected,true);
  t.$('trnav-pin').fire('click');
  assert.deepEqual(t.calls.highlight,[[1,0,true,'center']]);assert.equal(t.$('trnav-preview').textContent,'번역 d');
  // A run that rebuilds a page in place (no new shells) lets the selection go with it too.
  const pinned=t.S.trSel;const mark=t.calls.hover.length;
  await t.context.translateAll();
  assert.equal(pinned.isConnected||pinned.cls.has('pinned'),false);
  assert.deepEqual(t.calls.hover.slice(mark),[[1,0,false]]);
  assert.equal(t.S.trSel,null);assert.deepEqual(state(t).pin,true);assert.equal(t.$('trnav-pos').textContent,'None selected');
  assert.equal(t.$('trnav-preview').textContent,'');
}

// 6. Markup and layout: three native buttons in a labelled group above the bounded list, read-only
//    reload wording kept, and the list (not the tab) scrolls so the navigator stays in view.
{
  const page=JSON.parse(html.slice(html.indexOf('"'),html.lastIndexOf('"')+1));
  const tab=page.slice(page.indexOf('id="tab-translation"'),page.indexOf('id="tab-anatomy"'));
  assert.match(tab,/⟳ 저장된 결과 불러오기/);assert.match(tab,/title="ChatGPT가 저장한 번역을 다시 불러옵니다"/);
  assert.match(tab,/<div class="trnav" role="group" aria-labelledby="trnav-label">/);
  for(const id of ['trnav-prev','trnav-next','trnav-pin'])assert.match(tab,new RegExp(`<button id="${id}" type="button" class="btn-ghost"[^>]* disabled>`),id);
  assert.match(tab,/id="trnav-pin"[^>]*aria-pressed="false"/);assert.match(tab,/id="trnav-status" class="sr-only" role="status"/);
  assert(tab.indexOf('class="trnav"')>tab.indexOf('tr-toolbar')&&tab.indexOf('class="trnav"')<tab.indexOf('id="trlist"'),'navigator between toolbar and list');
  assert.match(css,/#tab-translation \.trlist \{[^}]*flex: 1 1 auto;[^}]*min-height: 0;/,'bounded list');
  assert.match(css,/\.trnav \{[^}]*flex: 0 0 auto;/,'navigator does not shrink');
  assert.match(css,/\.trnav-bar \{[^}]*flex-wrap: wrap;/,'navigator wraps at narrow widths');
  assert.match(css,/\.trnav-pos \{[^}]*flex: 1 1 calc\(100% - 8em\);/,'position fills the label row; buttons take the next');
  assert.match(css,/\.trnav-preview \{[^}]*height: 3em;/,'preview reserves two lines');
  assert.doesNotMatch(css,/\.trnav-preview:empty|\.trnav-preview \{[^}]*max-height/,'selection never resizes the preview');
  assert.match(css,/\.sr-only \{/);assert.match(css,/\.trseg\.selected \{/);
  assert.doesNotMatch(source,/showPane/,'no pane switching');
}
console.log('Original reader sentence navigator passed: paint order, empty skip, mouse/button/Escape pin, preview, endpoint focus, 3 resets, hover ownership on reset, real highlight layers across paper switch/rebuild/teardown, auto-translate off/on, markup/layout.');
