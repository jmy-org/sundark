/* Private Sites storage adapter for the original Sundark browser UI.
 * No AI inference, account login, external service, or generated-text fallback.
 */
(() => {
  const nativeFetch = window.fetch.bind(window);
  const versions = new Map();
  const paperId = value => { if (typeof value !== 'string' || !/^[a-f0-9-]{36}$/.test(value)) throw new Error('잘못된 자료 ID'); return value; };
  const language = value => ({Korean:'ko',English:'en',Japanese:'ja',Chinese:'zh',Spanish:'es',French:'fr',German:'de'}[value] || value || 'ko');
  const reply = (value,status=200) => new Response(JSON.stringify(value),{status,headers:{'Content-Type':'application/json'}});
  async function json(path,options) {const response=await nativeFetch(path,options);const data=await response.json();if(!response.ok)throw new Error(data.error||data.detail||'서재 요청에 실패했습니다.');return data;}
  const base = id => '/api/papers/'+encodeURIComponent(paperId(id));
  const jsonOptions = body => ({method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
  let enginePromise;
  const engine = () => enginePromise ||= import('/vendor/sundark/pdf-engine.js');
  async function metadata(id){const {paper}=await json(base(id));versions.set(id,paper.fileVersion||'text-v1');return {doc_id:id,title:paper.title,byline:paper.authors,num_pages:0,has_pdf:!!paper.fileName};}
  async function pageContent(id,page,ocr=false,progress,signal){
    if(!Number.isInteger(page)||page<1||page>200)throw new Error('원문 연결은 처음 200페이지까지 지원합니다.');
    const stored=await json(base(id)+'/content?page='+page);
    const opened=versions.get(id);if(opened&&opened!==stored.fileVersion)throw new Error('PDF가 변경되었습니다. 자료를 다시 열어 주세요.');
    if(stored.content&&!ocr)return stored.content;
    const reader=await engine();let doc=window.sundarkCurrentPdf?.(id)||null,own=false;
    if(!doc){doc=await reader.openPdf(base(id)+'/file');own=true;}
    try{
      const result=ocr?await reader.runOcr(doc,page,progress,signal):await reader.extractPage(doc,page);
      if(!result.segments.length)throw new Error('텍스트를 찾지 못했습니다. 현재 페이지 OCR을 실행해 주세요.');
      await json(base(id)+'/content',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({...result,page,fileVersion:stored.fileVersion})});
      return {...result,page};
    }finally{if(own)await doc.loadingTask.destroy();}
  }
  function layout(content){const words=[],sentences=[];for(const s of content.segments){const rects=(s.rects||[{page:content.page,bbox:s.bbox}]).filter(r=>r.page===content.page),indices=[];for(const [index,r] of rects.entries()){const [x,y,w,h]=r.bbox;indices.push(words.length);words.push({t:index===0?s.text:'',x0:x*content.width,y0:y*content.height,x1:(x+w)*content.width,y1:(y+h)*content.height});}sentences.push({id:s.id,text:s.text,para:s.para??'legacy',size:s.size||12,words:indices});}return {width:content.width,height:content.height,words,sentences,engine:'browser-approximation',warning:'Not DocLayout/PyMuPDF word geometry'};}
  async function analyses(id,kind,page){const result=[];let cursor=null;do{const data=await json(base(id)+'/analysis?'+new URLSearchParams({...cursor===null?{}:{cursor:String(cursor)},...kind?{kind}:{},...page?{page:String(page)}:{}}));result.push(...data.artifacts);cursor=data.nextCursor;}while(cursor!==null&&result.length<2000);if(cursor!==null)throw new Error('분석 기록이 조회 한도를 초과했습니다. 저장된 결과가 없다고 판단하지 않았습니다.');return result;}
  async function saved(id,kind,lang,page){return (await analyses(id,kind,page)).filter(a=>!a.stale&&a.kind===kind&&language(a.language)===language(lang));}
  const missing = () => {throw new Error('저장된 결과가 없습니다. ChatGPT에서 Sundark로 생성·저장한 뒤 다시 불러오세요.');};
  window.sundarkOcrPage = async(id,page,progress,signal) => {await pageContent(paperId(id),page,true,progress,signal);return true;};
  window.sundarkFetch = async(input,options={}) => {
    try{
      const url=new URL(typeof input==='string'?input:input.url,location.href);
      if(url.origin!==location.origin)throw new Error('외부 요청은 지원하지 않습니다.');
      const path=url.pathname,body=typeof options.body==='string'?JSON.parse(options.body):{};
      if(path==='/api/papers'){const data=await json('/api/papers');return reply({dir:'Private ChatGPT Site library',papers:data.papers.filter(p=>p.fileName).map(p=>({name:p.title,file:p.fileName,size:p.size,rel:p.id}))});}
      if(path==='/api/open')return reply(await metadata(paperId(body.rel)));
      if(path==='/api/upload'){
        const file=options.body?.get?.('file');if(!(file instanceof File)||file.size>20*1024*1024||!file.name.toLowerCase().endsWith('.pdf'))throw new Error('20MiB 이하 PDF를 선택해 주세요.');
        const created=await json('/api/papers',jsonOptions({title:file.name.replace(/\.pdf$/i,'')}));
        try{await json(base(created.paper.id)+'/file',{method:'POST',body:file,headers:{'Content-Type':'application/pdf','X-File-Name':encodeURIComponent(file.name)}});}catch(error){throw new Error('자료는 보관되었지만 PDF 업로드에 실패했습니다. 서재에서 같은 자료에 첨부해 주세요. '+error.message);}
        return reply(await metadata(created.paper.id));
      }
      let match=path.match(/^\/api\/layout\/([^/]+)\/(\d+)$/);
      if(match){const id=paperId(match[1]),page=Number(match[2])+1;if(url.searchParams.get('extract')!=='1'){const stored=await json(base(id)+'/content?page='+page);if(versions.has(id)&&versions.get(id)!==stored.fileVersion)throw new Error('PDF가 변경되었습니다. 자료를 다시 열어 주세요.');return reply(stored.content?layout(stored.content):{width:1,height:1,words:[],sentences:[],notExtracted:true});}return reply(layout(await pageContent(id,page)));}
      if(path.startsWith('/api/status/'))return reply({finished:true,num_pages:0,done:0});
      if(path==='/api/translate_stream'){
        const id=paperId(body.doc_id),page=Number(body.page)+1,content=await pageContent(id,page),start=Number(body.start||0);
        if(!Number.isInteger(start)||start<0||!Array.isArray(body.segments)||body.segments.length>40)throw new Error('번역 구간을 확인해 주세요.');
        const chosen=content.segments.slice(start,start+body.segments.length);
        if(chosen.length!==body.segments.length||chosen.some((s,i)=>s.text!==body.segments[i]))throw new Error('원문 구간이 변경되었습니다. 다시 열어 주세요.');
        const history=(await saved(id,'translation',body.target_lang,page)).filter(a=>a.page===page),map=new Map();
        for(const a of history)for(const s of a.content.segments||[])if(!map.has(s.id))map.set(s.id,s.text);
        if(chosen.every(s=>!map.has(s.id)))missing();
        return new Response(chosen.flatMap((s,i)=>map.has(s.id)?[JSON.stringify({i,tr:map.get(s.id)})]:[]).join('\n')+'\n',{headers:{'Content-Type':'application/x-ndjson'}});
      }
      if(path==='/api/anatomy'){
        const a=(await saved(paperId(body.doc_id),'anatomy',body.output_language)).find(x=>x.content.schemaVersion===2);if(!a)missing();
        const c=structuredClone(a.content),cards=[c.problem,c.gap,c.claim,c.method,...Object.values(c.evidence),c.limitations];
        for(const card of cards)for(const point of card.points){point.quote=point.citations?.[0]?.quote||null;point.verified=!!point.quote;}
        return reply(c);
      }
      if(path==='/api/summarize'){const a=(await saved(paperId(body.doc_id),'summary',body.output_language))[0];if(!a)missing();return reply({summary:a.content.text});}
      match=path.match(/^\/api\/math\/([^/]+)\/(\d+)$/);if(match)return reply({equations:[],limitation:'Automatic equation localization is not available in this adapter. Use explicit saved crops for ChatGPT vision.'});
      match=path.match(/^\/api\/chat\/([^/]+)$/);
      if(match){const qa=(await analyses(paperId(match[1]),'qa')).filter(a=>!a.stale&&a.kind==='qa').slice(0,10).reverse();return reply({turns:qa.flatMap(a=>[{role:'user',text:a.content.question},{role:'assistant',text:a.content.answer}])});}
      if(path==='/api/chat'){const a=(await saved(paperId(body.doc_id),'qa',body.output_language)).find(a=>a.content.question===body.question);if(!a)missing();return reply({answer:a.content.answer});}
      match=path.match(/^\/api\/review\/([^/]+)$/);if(match)return nativeFetch(base(paperId(match[1]))+'/review?mode=review&language='+encodeURIComponent(language(url.searchParams.get('output_language'))));
      return reply({detail:'이 기능은 이식되지 않았습니다. 연결·로그인·서버 AI 기능을 실행하지 않았습니다.'},501);
    }catch(error){return reply({detail:error instanceof Error?error.message:'요청을 완료하지 못했습니다.'},409);}
  };
})();
