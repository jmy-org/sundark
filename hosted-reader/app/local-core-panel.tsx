"use client";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { Laptop, LoaderCircle, Plug, Unplug, Upload } from "lucide-react";
import "katex/dist/katex.min.css";
import { DEFAULT_LOCAL_CORE_PORT, LocalCore, LocalCoreError, coreLanguage } from "../lib/local-core";
import { renderMarkdown } from "../lib/markdown";

// Opt-in: the owner runs Sundark on their own machine as the Site companion and pastes its
// pairing token here. The token is held only by the LocalCore object (memory) and forgotten on
// disconnect or when this panel closes. Results are shown, never saved to the library.

type Point={text?:unknown;kind?:unknown;quote?:unknown;verified?:unknown};
type Card={status?:unknown;points?:unknown};
type Results={summary?:string;anatomy?:Record<string,unknown>;translation?:{page:number;segments:{src:string;tr:string}[]}};
type Phase="idle"|"connecting"|"connected"|"sending"|"ready"|"working";

const anatomyCards:[string,string][]=[["problem","연구 문제"],["gap","기존 연구의 빈틈"],["claim","핵심 주장"],["method","방법"]];
const evidenceCards:[string,string][]=[["dataset_test","데이터셋 · 시험"],["metric","평가 지표"],["baseline","비교 기준"],["ablation","Ablation · 구성 요소 검증"]];
const kindNames:Record<string,string>={author_stated:"저자 서술",synthesis:"종합",ai_interpretation:"AI 해석"};

function message(e:unknown){return e instanceof LocalCoreError?(e.rateLimited?`${e.message} 잠시 후 다시 시도하거나 로컬 Sundark 설정에서 동시 작업 수를 줄여 주세요.`:e.message):"로컬 Sundark 작업이 실패했습니다.";}

function LocalMarkdown({text}:{text:string}){
 const ref=useRef<HTMLDivElement>(null);
 useEffect(()=>{if(ref.current)renderMarkdown(ref.current,text);},[text]);
 return <div ref={ref} className="local-core-markdown"/>;
}

function LocalAnatomyCard({title,value}:{title:string;value:unknown}){
 const card=(value&&typeof value==="object"?value:{}) as Card,points=Array.isArray(card.points)?card.points as Point[]:[],absent=card.status==="not_present";
 return <section className={`anatomy-fixed-card ${absent?"absent":""}`}><header><h4>{title}</h4><span>{absent?"원문에 없음":`${points.length}개 항목`}</span></header>{absent||!points.length?<p className="anatomy-absent">{absent?"논문에서 이 항목을 찾지 못했습니다.":"내용이 없습니다."}</p>:<ul>{points.map((p,i)=><li key={i}><span className={`anatomy-point-kind ${p.kind==="ai_interpretation"?"interpretation":""}`}>{kindNames[String(p.kind)]||"근거 유형 미지정"}</span><p>{typeof p.text==="string"?p.text:""}</p>{typeof p.quote==="string"&&p.quote?<p className="local-core-quote"><small>{p.verified===true?"원문 인용 확인됨":"원문에서 확인되지 않은 인용"}</small>{p.quote}</p>:null}</li>)}</ul>}</section>;
}

export function LocalCorePanel({paperId,fileName,page,language}:{paperId:string;fileName:string;page:number;language:string}){
 const core=useRef<LocalCore|null>(null),generation=useRef(0);
 const [port,setPort]=useState(String(DEFAULT_LOCAL_CORE_PORT)),[token,setToken]=useState("");
 const [phase,setPhase]=useState<Phase>("idle"),[status,setStatus]=useState(""),[error,setError]=useState(""),[sent,setSent]=useState(0);
 const [doc,setDoc]=useState<{id:string;pages:number}|null>(null),[results,setResults]=useState<Results>({}),[origin,setOrigin]=useState("");
 useEffect(()=>()=>{generation.current++;void core.current?.close();core.current=null;},[]);
 // A reply that arrives after a disconnect, a new connection or unmount must not touch the panel.
 const live=(client:LocalCore|null,g:number)=>generation.current===g&&core.current===client;
 const busy=phase==="connecting"||phase==="sending"||phase==="working";

 async function connect(e:FormEvent){
  e.preventDefault();setError("");
  let client:LocalCore;
  try{client=new LocalCore({port:Number(port),token:token.trim()});}catch(err){setError(message(err));return;}
  const g=++generation.current;
  setPhase("connecting");setStatus("로컬 Sundark에 연결하고 있어요. 브라우저가 이 기기의 다른 앱·서비스 접근을 물으면 이 사이트에 대해서만 허용해 주세요.");
  try{await client.connect();if(generation.current!==g){void client.close();return;}core.current=client;setToken("");setPhase("connected");setStatus("연결됐어요. 이 논문의 PDF를 로컬 Sundark로 보내면 분석할 수 있어요.");}
  catch(err){void client.close();if(generation.current!==g)return;if(err instanceof LocalCoreError&&err.kind==="unauthorized")setToken("");setPhase("idle");setStatus("");setError(message(err));}
 }
 async function disconnect(){generation.current++;const client=core.current;core.current=null;setPhase("idle");setDoc(null);setResults({});setStatus("연결을 끊었어요. 토큰은 이 페이지에서 지워졌습니다.");setError("");await client?.close();}
 async function sendPdf(){
  const client=core.current,g=generation.current;if(!client)return;
  setPhase("sending");setError("");setSent(0);setStatus("이 논문의 PDF를 서재에서 읽고 있어요…");
  try{
   const response=await fetch(`/api/papers/${encodeURIComponent(paperId)}/file`,{cache:"no-store"});
   if(!response.ok)throw new LocalCoreError("invalid","서재에서 이 논문의 PDF를 읽지 못했어요.");
   const bytes=new Uint8Array(await response.arrayBuffer());
   if(!live(client,g))return;
   setStatus("로컬 Sundark로 PDF를 보내고 있어요…");
   const meta=await client.uploadPdf(bytes,fileName,(n,total)=>{if(live(client,g))setSent(Math.round(n/total*100));});
   if(!live(client,g))return;
   setDoc({id:meta.doc_id,pages:Number(meta.num_pages)||0});setResults({});setPhase("ready");setStatus("로컬 Sundark가 PDF를 열었어요. 레이아웃 분석은 로컬에서 이어집니다.");
  }catch(err){if(!live(client,g))return;setPhase("connected");setStatus("");setError(message(err));}
 }
 async function run(kind:"summary"|"anatomy"|"translation"){
  const client=core.current,g=generation.current;if(!client||!doc)return;
  const lang=coreLanguage(language);
  if(kind==="translation"&&doc.pages&&page>doc.pages){setError(`로컬 Sundark가 연 PDF는 ${doc.pages}페이지까지 있어요.`);return;}
  setPhase("working");setError("");setStatus(kind==="summary"?"로컬 Sundark가 요약하고 있어요…":kind==="anatomy"?"로컬 Sundark가 Research Anatomy를 만들고 있어요…":`로컬 Sundark가 ${page}페이지를 번역하고 있어요…`);
  try{
   if(kind==="summary"){const r=await client.summarize(doc.id,lang);if(!live(client,g))return;setResults(v=>({...v,summary:typeof r.summary==="string"?r.summary:""}));}
   else if(kind==="anatomy"){const r=await client.anatomy(doc.id,lang);if(!live(client,g))return;setResults(v=>({...v,anatomy:r}));}
   else{const r=await client.translatePage(doc.id,page-1,lang);if(!live(client,g))return;const segments=Array.isArray(r.segments)?(r.segments as {src?:unknown;tr?:unknown}[]).map(s=>({src:String(s.src??""),tr:String(s.tr??"")})):[];setResults(v=>({...v,translation:{page,segments}}));}
   setStatus("완료됐어요. 결과는 이 화면에만 표시되고 서재에 저장되지 않아요.");
  }catch(err){if(!live(client,g))return;setStatus("");setError(message(err));if(err instanceof LocalCoreError&&err.kind==="closed"){core.current=null;setDoc(null);setPhase("idle");return;}}
  setPhase("ready");
 }

 const evidence=(results.anatomy?.evidence&&typeof results.anatomy.evidence==="object"?results.anatomy.evidence:{}) as Record<string,unknown>;
 return <details className="saved-analysis-panel local-core-panel" onToggle={()=>setOrigin(window.location.origin)}><summary><span className="eyebrow">OPTIONAL · YOUR COMPUTER</span><span className="local-core-title"><Laptop size={16} aria-hidden="true"/>로컬 Sundark로 분석하기</span></summary>
  <div aria-busy={busy}>
   <p className="local-core-intro">내 컴퓨터에서 실행 중인 Sundark가 레이아웃 분석·번역·요약을 맡아요. 로컬에서 고른 AI(ChatGPT 로그인 포함)를 그대로 쓰며, 사이트 서버나 서재에는 토큰과 결과를 저장하지 않습니다.</p>
   {phase==="idle"||phase==="connecting"?<form className="local-core-form" onSubmit={connect}>
    <p className="local-core-help">터미널에서 <code>uv run python -m app.mcp_server --http --site-origin {origin||"https://<이 사이트>"}</code> 를 실행하고, 출력된 토큰을 붙여 넣으세요.</p>
    <label>포트<input type="number" inputMode="numeric" min={1024} max={65535} value={port} onChange={e=>setPort(e.target.value)} disabled={busy} required/></label>
    <label>연결 토큰<input type="password" autoComplete="off" spellCheck={false} value={token} onChange={e=>setToken(e.target.value)} disabled={busy} required aria-describedby={`local-core-token-note-${paperId}`}/></label>
    <button className="primary-button" type="submit" disabled={busy||!token.trim()}>{phase==="connecting"?<LoaderCircle size={13} className="spin" aria-hidden="true"/>:<Plug size={13} aria-hidden="true"/>}연결</button>
    <small id={`local-core-token-note-${paperId}`}>토큰은 이 탭의 메모리에만 있고, 연결을 끊거나 페이지를 닫으면 사라집니다.</small>
   </form>:<div className="local-core-actions">
    <button className="artifact-refresh" onClick={sendPdf} disabled={busy}><Upload size={13} aria-hidden="true"/>{doc?"PDF 다시 보내기":"이 논문 PDF 보내기"}</button>
    <button className="artifact-refresh" onClick={()=>run("summary")} disabled={busy||!doc}>요약</button>
    <button className="artifact-refresh" onClick={()=>run("anatomy")} disabled={busy||!doc}>Research Anatomy</button>
    <button className="artifact-refresh" onClick={()=>run("translation")} disabled={busy||!doc}>{page}페이지 번역</button>
    <button className="artifact-refresh" onClick={disconnect} disabled={phase==="sending"}><Unplug size={13} aria-hidden="true"/>연결 끊기</button>
   </div>}
   {phase==="sending"&&<progress className="local-core-progress" max={100} value={sent} aria-label="PDF 전송 진행률"/>}
   <p className="reader-status" role="status" aria-live="polite">{status}</p>
   {error&&<p className="reader-alert" role="alert">{error}</p>}
   {results.summary!==undefined&&<section className="local-core-result" aria-label="로컬 Sundark 요약"><h4>요약</h4>{results.summary?<LocalMarkdown text={results.summary}/>:<p className="artifact-text">요약 내용이 비어 있어요.</p>}</section>}
   {results.anatomy&&<section className="local-core-result anatomy-v2" aria-label="로컬 Sundark Research Anatomy"><h4>Research Anatomy</h4><div className="anatomy-card-grid">{anatomyCards.map(([key,label])=><LocalAnatomyCard key={key} title={label} value={results.anatomy?.[key]}/>)}</div><div className="anatomy-evidence-heading"><h4>검증 증거</h4></div><div className="anatomy-card-grid">{evidenceCards.map(([key,label])=><LocalAnatomyCard key={key} title={label} value={evidence[key]}/>)}</div><LocalAnatomyCard title="한계" value={results.anatomy.limitations}/></section>}
   {results.translation&&<section className="local-core-result" aria-label={`로컬 Sundark ${results.translation.page}페이지 번역`}><h4>{results.translation.page}페이지 번역</h4>{results.translation.segments.length?<><div className="parallel-labels" aria-hidden="true"><span>원문</span><span>번역</span></div>{results.translation.segments.map((s,i)=><div key={i} className="parallel-segment"><div className="parallel-source"><p>{s.src}</p></div><div className="paragraph-translation"><p className="artifact-text">{s.tr}</p></div></div>)}</>:<p className="reader-inline-note">이 페이지에서 번역할 문장을 찾지 못했어요.</p>}</section>}
   <p className="analysis-disclaimer">로컬 Sundark 결과는 이 화면에만 표시되며 서재에 저장되지 않습니다. 원문은 PDF에서 다시 읽은 로컬 레이아웃 기준이라 위의 추출 원문과 문장 구분이 다를 수 있어요. AI 결과의 중요한 내용은 원문에서 확인하세요.</p>
  </div>
 </details>;
}
