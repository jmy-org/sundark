import {env} from 'cloudflare:workers';
/** Opt-in MCP protocol telemetry (SUNDARK_MCP_DIAGNOSTICS=1, default off): one console line per
 * /mcp request, `{"event":"sundark_mcp_observation",...}`, so a live probe shows which methods reach
 * the Site and how each ended, although HTTP is 200 even for an RPC error. Every field is a known
 * enum, a date-formatted version or a byte count: never params, arguments, URIs, file ids, headers,
 * identity, paper text or error messages. It never throws and never changes the response. */
const METHODS=new Set(['initialize','server/discover','ping','notifications/initialized','tools/list','tools/call','resources/list','resources/read','resources/templates/list','prompts/list']);
const TOOLS:Record<string,string>={read_attached_pdf:'read_attached',render_attached_reader:'render_attached',prepare_attachment_task:'prepare',open_attachment_reader:'open',open_pdf_file:'open',read_attachment_original:'original',render_paper_reader:'saved_render'};
const REASONS=new Set(['missing','malformed','unsupported_host','unsafe_url','expired','download','size','not_pdf','encrypted','invalid_pages','invalid_arguments','invalid_translation','invalid_analysis','source_changed','extract_failed']);
const STATUS:Record<number,string>={400:'invalid',401:'auth',403:'origin',404:'not_found',413:'too_large',415:'content_type',503:'unavailable'};
const UI='io.modelcontextprotocol/ui',APP_MIME='text/html;profile=mcp-app';
const date=(v:unknown)=>typeof v==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(v)?v:undefined;
const obj=(v:unknown):Record<string,unknown>|undefined=>v&&typeof v==='object'&&!Array.isArray(v)?v as Record<string,unknown>:undefined;
function ui(params:Record<string,unknown>|undefined){
 const caps=obj(params?.capabilities)??obj(obj(params?._meta)?.['io.modelcontextprotocol/clientCapabilities']);
 const cap=obj(obj(caps?.extensions)?.[UI]);
 return !caps?undefined:!cap?'absent':Array.isArray(cap.mimeTypes)&&cap.mimeTypes.includes(APP_MIME)?'mcp_app':'other';
}
type Fields=Record<string,string|number>;
const quiet={rpc(){},done(){},fail(){}};
const enabled=()=>{try{return (env as unknown as Record<string,string|undefined>).SUNDARK_MCP_DIAGNOSTICS==='1'}catch{return false}};
export function observer(request:Request,resources:{attachment:string,saved:string}){
 if(!enabled())return quiet;
 const f:Fields={event:'sundark_mcp_observation',method:'other'};
 const header=date(request.headers.get('mcp-protocol-version'));
 const emit=(outcome:string,extra:Fields={})=>{try{const line=JSON.stringify({...f,outcome,...extra});if(outcome==='ok')console.info(line);else console.error(line)}catch{}};
 return {
  rpc(rpc:unknown){try{const r=obj(rpc),p=obj(r?.params),m=r?.method;
   if(typeof m==='string'&&METHODS.has(m))f.method=m;
   if(f.method==='tools/call')f.tool=typeof p?.name==='string'&&Object.hasOwn(TOOLS,p.name)?TOOLS[p.name]:'other';
   if(f.method==='resources/read')f.resource=p?.uri===resources.attachment?'attachment':p?.uri===resources.saved?'saved':'other';
   const requested=f.method==='initialize'?date(p?.protocolVersion):date(obj(p?._meta)?.['io.modelcontextprotocol/protocolVersion'])??header;
   if(requested)f.requestedVersion=requested;
   const cap=ui(p);if(cap)f.uiCapability=cap;
  }catch{}},
  done(result?:unknown){try{const r=obj(result);
   if(!r)return emit('unsupported',{reason:'method_not_found'});
   const replied=date(r.protocolVersion)??(Array.isArray(r.supportedVersions)?date(r.supportedVersions[0]):undefined);
   const text=obj((r.contents as unknown[]|undefined)?.[0])?.text;
   emit(r.isError===true?'error':'ok',{...(replied?{protocolVersion:replied}:{}),...(typeof text==='string'?{bytes:new TextEncoder().encode(text).length}:{})});
  }catch{}},
  fail(e:unknown){try{const x=obj(e),status=typeof x?.status==='number'&&Number.isInteger(x.status)&&x.status>=400&&x.status<600?x.status:undefined;
   const reason=typeof x?.reason==='string'&&REASONS.has(x.reason)?x.reason:e instanceof SyntaxError?'parse':status?STATUS[status]??'api':'internal';
   emit('error',{...(status?{status}:{}),reason});
  }catch{}},
 };
}
