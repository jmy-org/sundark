import { siteUrl } from './site-origin';
/** Optional MCP Apps view. Host support must be verified separately from tool support. */
export const readerHtml = String.raw`<!doctype html>
<html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Sundark Reader</title>
<style>
:root{color-scheme:light dark;font-family:system-ui,sans-serif;color:var(--color-text-primary,#25272b);background:var(--color-background-primary,#fff)}*{box-sizing:border-box}body{margin:0;padding:18px}header{display:flex;align-items:start;justify-content:space-between;gap:16px}h1{font-size:20px;margin:0 0 6px}p{margin:6px 0;font-size:13px;line-height:1.55}a{color:#41685b}#status{opacity:.72}label{display:block;font-size:13px;margin:16px 0 10px}select{max-width:100%;margin-left:8px;padding:7px;border-radius:8px}#rows{max-height:65vh;overflow:auto;border:1px solid #89928c55;border-radius:12px}.row,.head{display:grid;grid-template-columns:1fr 1fr;gap:14px;padding:13px;border-bottom:1px solid #89928c33}.head{font-size:12px;font-weight:650;position:sticky;top:0;background:var(--color-background-primary,#fff);z-index:1}.segment{margin:0;padding:8px;border:1px solid transparent;border-radius:8px;background:transparent;color:inherit;font:inherit;font-size:14px;line-height:1.7;white-space:pre-wrap;overflow-wrap:anywhere;text-align:left;cursor:pointer}.segment:hover,.segment:focus-visible{border-color:#709d8a}.row.selected{background:#93bea522}.row.selected .segment{border-color:#709d8a}.muted{opacity:.6}.empty{padding:20px}.note{opacity:.65;font-size:12px}@media(max-width:480px){body{padding:12px}.row,.head{gap:5px;padding:7px}.segment{font-size:13px;padding:4px}header{display:block}header a{font-size:13px}}
</style></head><body><header><div><h1 id="title">Sundark 대조 리더</h1><p id="status" role="status">대화의 논문 결과를 기다리고 있어요.</p></div><a id="site" href="${siteUrl}" target="_blank" rel="noopener noreferrer">비공개 사이트에서 열기</a></header>
<label>저장된 번역<select id="versions" aria-label="번역 버전"><option>아직 번역이 없어요</option></select></label><div id="rows"><p class="empty">이 화면을 지원하지 않는 환경에서는 위 사이트에서 논문을 볼 수 있어요.</p></div><p class="note">문단을 누르면 대응하는 원문과 번역이 함께 강조됩니다. 번역 생성·저장은 대화에서 요청하세요.</p>
<script>
(function(){
'use strict';
var title=document.getElementById('title'),status=document.getElementById('status'),rows=document.getElementById('rows'),versions=document.getElementById('versions');
var current=null,translations=[],initialized=false;
function label(tag,text,cls){var e=document.createElement(tag);e.textContent=text;if(cls)e.className=cls;return e;}
function paint(){
 rows.replaceChildren();if(!current)return;
 var head=document.createElement('div');head.className='head';head.append(label('span','원문'),label('span','번역'));rows.append(head);
 var index=Number(versions.value),artifact=translations[index],map=new Map();
 if(artifact&&artifact.content&&Array.isArray(artifact.content.segments)){artifact.content.segments.forEach(function(s){if(s&&typeof s.id==='string'&&typeof s.text==='string')map.set(s.id,s.text);});}
 current.segments.forEach(function(s){if(!s||typeof s.id!=='string'||typeof s.text!=='string')return;var row=document.createElement('div');row.className='row';var source=label('button',s.text,'segment'),translation=label('button',map.get(s.id)||'아직 저장된 번역이 없어요.','segment'+(map.has(s.id)?'':' muted'));source.type=translation.type='button';source.setAttribute('aria-pressed','false');translation.setAttribute('aria-pressed','false');function select(){rows.querySelectorAll('.row').forEach(function(r){r.classList.remove('selected');r.querySelectorAll('button').forEach(function(b){b.setAttribute('aria-pressed','false');});});row.classList.add('selected');source.setAttribute('aria-pressed','true');translation.setAttribute('aria-pressed','true');}source.onclick=translation.onclick=select;row.append(source,translation);rows.append(row);});
 if(!current.segments.length)rows.append(label('p','이 페이지에 추출된 원문이 없어요. 사이트에서 텍스트 추출 또는 OCR을 먼저 실행해 주세요.','empty'));
}
function render(data){
 if(!data||typeof data!=='object'||!Array.isArray(data.segments))return;
 current=data;if(typeof data.paperId==='string'&&/^[a-f0-9-]{36}$/.test(data.paperId))document.getElementById('site').href='${siteUrl}/?paper='+encodeURIComponent(data.paperId);title.textContent=typeof data.title==='string'?data.title:'Sundark 대조 리더';
 status.textContent='페이지 '+(Number.isInteger(data.page)?data.page:'—')+' · 원문 '+data.segments.length+'개 문단';
 translations=(Array.isArray(data.artifacts)?data.artifacts:[]).filter(function(a){return a&&a.kind==='translation'&&!a.stale&&a.content&&Array.isArray(a.content.segments);});
 versions.replaceChildren();if(!translations.length){var empty=label('option','아직 번역이 없어요');empty.value='-1';versions.append(empty);versions.disabled=true;}else{versions.disabled=false;translations.forEach(function(a,i){var option=label('option',(a.language||'번역')+' · '+(a.createdAt||'저장된 버전'));option.value=String(i);versions.append(option);});}paint();
}
versions.onchange=paint;
// Official ChatGPT Apps SDK compatibility bridge, alongside MCP Apps.
function renderOpenAiGlobals(){if(window.openai&&window.openai.toolOutput){initialized=true;render(window.openai.toolOutput);}}
window.addEventListener('openai:set_globals',renderOpenAiGlobals);
renderOpenAiGlobals();
window.addEventListener('message',function(event){
 if(event.source!==window.parent)return;var m=event.data;if(!m||m.jsonrpc!=='2.0')return;
 if(m.id==='sundark-ui-init'&&!initialized){if(m.result&&m.result.protocolVersion==='2026-01-26'){initialized=true;window.parent.postMessage({jsonrpc:'2.0',method:'ui/notifications/initialized',params:{}},'*');if(m.result.hostContext&&m.result.hostContext.theme)document.documentElement.style.colorScheme=m.result.hostContext.theme;}else if(m.error||m.result){status.textContent='이 환경의 내장 리더 연결을 확인하지 못했어요. 사이트에서 열어 주세요.';}return;}
 if(m.method==='ui/notifications/tool-result'&&initialized){if(m.params&&m.params.isError){status.textContent='논문을 불러오지 못했어요. 대화에서 다시 요청해 주세요.';return;}render(m.params&&m.params.structuredContent);}
 if(m.method==='ui/notifications/host-context-changed'&&m.params&&(m.params.theme==='light'||m.params.theme==='dark'))document.documentElement.style.colorScheme=m.params.theme;
 if(m.method==='ui/resource-teardown'&&m.id!==undefined)window.parent.postMessage({jsonrpc:'2.0',id:m.id,result:{}},'*');
});
if(window.parent!==window){window.parent.postMessage({jsonrpc:'2.0',id:'sundark-ui-init',method:'ui/initialize',params:{appInfo:{name:'Sundark Reader',version:'1.0.0'},appCapabilities:{availableDisplayModes:['inline','fullscreen']},protocolVersion:'2026-01-26'}},'*');}
setTimeout(function(){if(!initialized&&!current)status.textContent='내장 리더 연결을 확인하지 못했어요. 위 사이트에서 열 수 있어요.';},6000);
})();
</script></body></html>`;
