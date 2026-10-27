"""Ephemeral ChatGPT attachment reader against the real local workerd runtime. Synthetic PDFs,
synthetic identities and a 127.0.0.1 fixture origin only; never run against production, a real
AI provider or real papers. It starts and stops its own server process on a free port.

  python3 -I tests/local-attachment.py dev   # vinext dev (Cloudflare Vite plugin, workerd), DEV=true
  python3 -I tests/local-attachment.py prod  # wrangler dev --local on the built dist/ (run `npm run build` first)

dev applies drizzle/ migrations to .wrangler/state when they are missing, seeds one synthetic
paper through the legacy import, and proves every attachment call leaves D1 and R2 unchanged.
prod proves the production bundle ignores SUNDARK_DEV_FILE_ORIGIN (import.meta.env.DEV=false).
"""
import base64,glob,hashlib,http.server,json,os,signal,socket,sqlite3,subprocess,sys,tempfile,threading,time,urllib.error,urllib.request,uuid
from concurrent.futures import ThreadPoolExecutor
ROOT=os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
MODE=sys.argv[1] if len(sys.argv)>1 else 'dev'
assert MODE in ('dev','prod'),'mode is dev or prod'
SECRET='sig=SYNTHETIC-SIGNED-TOKEN-a7c1';FILE_HOST='files.oaiusercontent.com';URI='ui://sundark/attachment-reader-v4.html'
ALIASES=('ui://sundark/attachment-reader.html','ui://sundark/attachment-reader-v2.html','ui://sundark/attachment-reader-v3.html');CHUNK=2*1024*1024
checks=[];chunk_heads=[]
def check(name,condition,detail:object=''):
 if not condition:raise AssertionError(f'{name} {detail}'.strip())
 checks.append(name)
def free_port():
 with socket.socket() as s:s.bind(('127.0.0.1',0));return s.getsockname()[1]
work=tempfile.mkdtemp(prefix='sundark-attachment-')
subprocess.run(['node','--input-type=module','-e',"""
import {writeFileSync} from 'node:fs';import {twoPagePdf,manyPagePdf,mixedScanPdf,scannedPdf} from './tests/fixtures/synthetic-pdf.mjs';
const d=process.argv[1];for(const [n,b] of Object.entries({'two-page.pdf':twoPagePdf(),'many-page.pdf':manyPagePdf(12),'long.pdf':manyPagePdf(205),'mixed-scan.pdf':mixedScanPdf(),'scanned.pdf':scannedPdf()}))writeFileSync(`${d}/${n}`,b);
""",work],cwd=ROOT,check=True)
pdfs={n:open(os.path.join(work,n),'rb').read() for n in os.listdir(work)}
pdfs['swap.pdf']=pdfs['two-page.pdf']
# Over one chunk: the two-page PDF padded with comment lines after %%EOF, so the original takes two chunks.
pdfs['big.pdf']=pdfs['two-page.pdf']+(b'%'+b'p'*1022+b'\n')*2600
hits={}
class Fixture(http.server.BaseHTTPRequestHandler):
 def log_message(self,format,*args):pass
 def do_GET(self):
  path=self.path.split('?')[0].lstrip('/');hits[path]=hits.get(path,0)+1
  if path.startswith('expired'):self.send_response(403);self.end_headers();return
  body=pdfs.get(path)
  if body is None:self.send_response(404);self.end_headers();return
  self.send_response(200);self.send_header('Content-Type','application/pdf');self.send_header('Content-Length',str(len(body)));self.end_headers();self.wfile.write(body)
fixture=http.server.ThreadingHTTPServer(('127.0.0.1',0),Fixture);threading.Thread(target=fixture.serve_forever,daemon=True).start()
FIXTURE=f'http://127.0.0.1:{fixture.server_address[1]}'
PORT=free_port();BASE=f'http://127.0.0.1:{PORT}'
log_path=os.path.join(work,'server.log');log=open(log_path,'w')
env={**os.environ,'WRANGLER_SEND_METRICS':'false','CLOUDFLARE_CF_FETCH_ENABLED':'false','SUNDARK_FILE_HOSTS':FILE_HOST,'SUNDARK_DEV_FILE_ORIGIN':FIXTURE}
if MODE=='dev':
 env['CLOUDFLARE_INCLUDE_PROCESS_ENV']='true'
 cmd=['node','node_modules/vinext/dist/cli.js','dev','-p',str(PORT),'-H','127.0.0.1']
else:
 bundle=os.path.join(ROOT,'dist/server');check('production bundle exists',os.path.isfile(os.path.join(bundle,'wrangler.json')),'(run npm run build first)')
 env.update({'SITES_RUNTIME_ROOT':os.path.join(work,'runtime'),'WRANGLER_WRITE_LOGS':'false'})
 cmd=['node','--import','./scripts/sites-env.mjs','./node_modules/wrangler/bin/wrangler.js','dev','--config','dist/server/wrangler.json','--local','--persist-to',os.path.join(work,'state'),
  '--ip','127.0.0.1','--port',str(PORT),'--inspector-port','0','--var',f'SUNDARK_DEV_FILE_ORIGIN:{FIXTURE}','--var',f'SUNDARK_FILE_HOSTS:{FILE_HOST}']
# Own process group: only this task's server is stopped, never anything else on the machine.
proc=subprocess.Popen(cmd,cwd=ROOT,env=env,stdout=log,stderr=subprocess.STDOUT,start_new_session=True)
def stop():
 if proc.poll() is None:
  os.killpg(proc.pid,signal.SIGTERM)
  try:proc.wait(20)
  except subprocess.TimeoutExpired:os.killpg(proc.pid,signal.SIGKILL);proc.wait()
 fixture.shutdown()
def call(path,method='GET',data=None,user=True,headers=None):
 h={'Origin':BASE}
 if user:
  # dev: the Sites mock-auth cookie; prod (no mock plugin): the platform's identity headers.
  if MODE=='dev':h['Cookie']='__sites_local_auth=1'
  else:h.update({'oai-authenticated-user-id':'synthetic-user','oai-authenticated-user-email':'synthetic@example.invalid'})
 if isinstance(data,dict):data=json.dumps(data).encode();h['Content-Type']='application/json'
 h.update(headers or {})
 try:
  with urllib.request.urlopen(urllib.request.Request(BASE+path,data=data,headers=h,method=method),timeout=180) as r:return r.status,r.read()
 except urllib.error.HTTPError as e:return e.code,e.read()
raw=[]
def rpc(method,params=None,**kw):
 s,b=call('/mcp','POST',{'jsonrpc':'2.0','id':1,'method':method,'params':params or {}},**kw);raw.append(b.decode('utf8','replace'))
 return s,json.loads(b)
def tool(name,args,**kw):
 s,r=rpc('tools/call',{'name':name,'arguments':args},**kw);r=r['result']
 return r if r.get('isError') else {**json.loads(r['content'][0]['text']),'_structured':'structuredContent' in r}
def original(args,**kw):
 s,r=rpc('tools/call',{'name':'read_attachment_original','arguments':args},**kw);return r['result']
def attach(name,query=SECRET):return {'download_url':f'{FIXTURE}/{name}?{query}','file_id':'file-SYNTHETIC-'+uuid.uuid4().hex[:8],'mime_type':'application/pdf','file_name':name}
def reason(r):return r.get('isError') and r['content'][0]['text'].split('(')[1].split(')')[0].split(',')[0] if r.get('isError') else None
def wait_ready():
 deadline=time.time()+240
 while time.time()<deadline:
  if proc.poll() is not None:raise AssertionError(f'server exited {proc.returncode}; see {log_path}')
  try:
   s,b=call('/mcp','POST',{'jsonrpc':'2.0','id':0,'method':'tools/list'})
   if s==200 and b'read_attached_pdf' in b:return
  except (urllib.error.URLError,ConnectionError,TimeoutError,json.JSONDecodeError):pass
  time.sleep(1)
 raise AssertionError('server not ready in 240s')

state=os.path.join(ROOT,'.wrangler/state/v3')
def d1_files():return [f for f in glob.glob(os.path.join(state,'d1/**/*.sqlite'),recursive=True) if 'metadata' not in os.path.basename(f)]
def d1_counts():
 out={}
 for f in d1_files():
  with sqlite3.connect(f'file:{f}?mode=ro',uri=True) as c:
   for (t,) in c.execute("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%'"):out[f'{os.path.basename(f)[:8]}.{t}']=c.execute(f'SELECT count(*) FROM "{t}"').fetchone()[0]
 return out
def r2_objects():return sum(len(f) for d,_,f in os.walk(os.path.join(state,'r2')) if os.path.basename(d)=='blobs')
def migrate():
 conf=os.path.join(work,'d1.json');json.dump({'name':'site-creator-vinext-starter','compatibility_date':'2026-05-15','d1_databases':[{'binding':'DB','database_name':'site-creator-d1','database_id':'00000000-0000-4000-8000-000000000000'}]},open(conf,'w'))
 if any('papers' in k for k in d1_counts()):return
 for f in sorted(glob.glob(os.path.join(ROOT,'drizzle/*.sql'))):
  subprocess.run(['node','node_modules/wrangler/bin/wrangler.js','d1','execute','DB','--local','--config',conf,'--persist-to',os.path.join(ROOT,'.wrangler/state'),'--file',f,'--yes'],cwd=ROOT,check=True,capture_output=True,env={**os.environ,'WRANGLER_SEND_METRICS':'false'})

first_failure=None
try:
 wait_ready()
 # The DEV=false policy first, so a bundle built before later contract changes still proves it.
 if MODE=='prod':
  bundle_js=''.join(open(f,encoding='utf8',errors='replace').read() for f in glob.glob(os.path.join(ROOT,'dist/server/**/*.js'),recursive=True))
  check('prod bundle carries the attachment tools','read_attached_pdf' in bundle_js and 'SUNDARK_FILE_HOSTS' in bundle_js)
  check('prod bundle dropped the DEV-only origin (import.meta.env.DEV=false)','SUNDARK_DEV_FILE_ORIGIN' not in bundle_js)
  r=tool('read_attached_pdf',{'file':attach('two-page.pdf')})
  check('prod: fixture origin refused although SUNDARK_DEV_FILE_ORIGIN is set',reason(r)=='unsafe_url',r)
  r=original({'file':attach('two-page.pdf'),'pdfSha256':hashlib.sha256(pdfs['two-page.pdf']).hexdigest(),'offset':0})
  check('prod: original refuses the fixture origin too',reason(r)=='unsafe_url' and '_meta' not in r,r)
  check('prod: nothing fetched from the fixture',sum(hits.values())==0,hits)
  check('prod: anonymous refused',tool('read_attached_pdf',{'file':attach('two-page.pdf')},user=False).get('isError'))
 s,init=rpc('initialize',{'protocolVersion':'2026-07-28','capabilities':{},'clientInfo':{'name':'synthetic','version':'0'}});init=init['result']
 check('initialize: standard keys only, with instructions',sorted(init)==['capabilities','instructions','protocolVersion','serverInfo'],sorted(init))
 check('initialize: an attached PDF routes to read, save only on request','read_attached_pdf' in init['instructions'] and 'without asking' in init['instructions'] and 'explicitly' in init['instructions'])
 tools={t['name']:t for t in rpc('tools/list')[1]['result']['tools']}
 for n in ('read_attached_pdf','render_attached_reader','prepare_attachment_task'):
  t=tools[n];a=t['annotations']
  check(f'{n}: read-only, non-destructive, open-world hints',a['readOnlyHint'] is True and a['destructiveHint'] is False and a['openWorldHint'] is True,a)
  check(f'{n}: fileParams file',t['_meta']['openai/fileParams']==['file'] and t['inputSchema']['properties']['file']['required']==['download_url','file_id'])
 for n in ('read_attached_pdf','render_attached_reader','open_attachment_reader'):
  m=tools[n]['_meta'];check(f'{n}: reader template',m['ui']['resourceUri']==URI and m['openai/outputTemplate']==URI,m)
 check('launcher: thread entrypoint, read-only',tools['open_attachment_reader']['_meta']['openai/ui']=={'entrypoints':[{'type':'thread'}]} and tools['open_attachment_reader']['annotations']['readOnlyHint'] is True)
 e=tools['open_pdf_file'];em=e['_meta']
 check('file entrypoint: app-only PDF entrypoint on the reader',em['ui']=={'resourceUri':URI,'visibility':['app']} and em['openai/ui']=={'entrypoints':[{'type':'file','extensions':['.pdf']}]} and 'openai/fileParams' not in em,em)
 check('file entrypoint: injected {name,resourceUri} input, read-only',e['inputSchema']['properties']['file']['required']==['name','resourceUri'] and e['annotations']['readOnlyHint'] is True and e['annotations']['openWorldHint'] is False)
 check('read: unreadPages declared',tools['read_attached_pdf']['inputSchema']['properties']['unreadPages']['maxItems']==200)
 o=tools['read_attachment_original'];om=o['_meta'];oi=o['inputSchema']
 check('original: app-only, no template of its own',om['ui']=={'visibility':['app']} and 'openai/outputTemplate' not in om and 'ui/resourceUri' not in om,om)
 check('original: fileParams file, widget-callable',om['openai/fileParams']==['file'] and om.get('openai/widgetAccessible') is True,om)
 check('original: exactly file, pdfSha256, offset',sorted(oi['required'])==['file','offset','pdfSha256'] and sorted(oi['properties'])==['file','offset','pdfSha256'] and oi['additionalProperties'] is False,oi)
 check('original: sha pattern and non-negative integer offset',oi['properties']['pdfSha256']['pattern']=='^[0-9a-f]{64}$' and oi['properties']['offset']=={**oi['properties']['offset'],'type':'integer','minimum':0},oi)
 check('original: read-only, non-destructive, open-world hints',o['annotations']['readOnlyHint'] is True and o['annotations']['destructiveHint'] is False and o['annotations']['openWorldHint'] is True)
 check('original: description says app-only',all(w in o['description'] for w in ('App-only','not for the model')))
 res=rpc('resources/list')[1]['result']['resources'];ar=next((r for r in res if r['uri']==URI),None)
 check('resource listed as an MCP App',ar is not None and ar['mimeType']=='text/html;profile=mcp-app',ar)
 c=rpc('resources/read',{'uri':URI})[1]['result']['contents'][0];meta=c['_meta']
 check('resource read: uri, mime, html body',c['uri']==URI and c['mimeType']=='text/html;profile=mcp-app' and '<' in c['text'] and len(c['text'])>1000)
 check('resource CSP: no widget egress at all',meta['ui']['csp']=={'connectDomains':[],'resourceDomains':[]} and meta['openai/widgetCSP']=={'connect_domains':[],'resource_domains':[]},meta)
 for alias in ALIASES:
  ac=rpc('resources/read',{'uri':alias})[1]['result']['contents'][0]
  check(f'alias {alias}: same body, empty CSP',ac['text']==c['text'] and ac['_meta']['ui']['csp']=={'connectDomains':[],'resourceDomains':[]} and ac['_meta']['openai/widgetCSP']=={'connect_domains':[],'resource_domains':[]},ac['_meta'])
 resource_meta={k:(sorted(v) if isinstance(v,dict) else v) for k,v in meta.items()}

 if MODE=='dev':
  # Synthetic library fixture through the legacy import, then measure: attachments must not change it.
  migrate()
  seeded=tool('import_paper_pdf',{'file':attach('two-page.pdf'),'requestId':str(uuid.uuid4())})
  check('fixture: legacy import seeds D1 and R2',not seeded.get('isError') and r2_objects()>=1,seeded)
  before_rows,before_r2=d1_counts(),r2_objects();before_hits=dict(hits)
  check('fixture: D1 tables counted',any(v>0 for v in before_rows.values()),before_rows)

  r=tool('read_attached_pdf',{'file':attach('two-page.pdf')})
  seg=r['pages'][0]['segments']
  check('read: page 1 by default, ephemeral, structured',r['mode']=='ephemeral' and r['persistent'] is False and r['page']==1 and r['_structured'],r.get('content'))
  check('read: synthetic text with geometry',any('Plants use light to grow.' in s['text'] for s in seg) and all(s['bbox'][2]>0 and s['rects'] for s in seg))
  check('read: original sha256',r['attachment']['pdfSha256']==hashlib.sha256(pdfs['two-page.pdf']).hexdigest())
  check('read: progress fields',[r['nextPages'],r['attemptedPages'],r['unreadPages'],r['complete'],r['reportedComplete'],r['progressBasis'],r['pageLimit'],r['extractablePages']]==[[2],[1],[],False,False,'caller-reported',200,2])
  check('read: batches carry the language',all(b['language']=='Korean' for b in r['translation']['batches']) and 'same language' in r['translation']['instructions'])
  h1=r['sourceHash']
  ko=[{'id':s['id'],'text':f'합성 번역 문장 {i}이다.'} for i,s in enumerate(seg)]
  v=tool('render_attached_reader',{'file':attach('two-page.pdf'),'page':1,'sourceHash':h1,'translations':ko[:1],'language':'Korean'})
  check('render: translation prefix shown',v.get('translations')==ko[:1] and v['_structured'],v)
  ja=tool('read_attached_pdf',{'file':attach('two-page.pdf'),'language':'Japanese'})
  check('read: Japanese target in batches',all(b['language']=='Japanese' for b in ja['translation']['batches']) and 'Japanese' in ja['translation']['instructions'])
  jt=[{'id':s['id'],'text':f'合成された翻訳文{i}です。'} for i,s in enumerate(seg)]
  v=tool('render_attached_reader',{'file':attach('two-page.pdf'),'page':1,'sourceHash':h1,'translations':jt,'language':'Japanese'})
  check('render: Japanese translation shown',v.get('translations')==jt and v['translation']['language']=='Japanese',v)
  long=next(i for i,s in enumerate(seg) if s['text'].startswith('This synthetic sentence wraps'))
  es=[{'id':s['id'],'text':f'Esta es la frase sintética número {i} que envuelve dos líneas para las comprobaciones de geometría del lector.'} for i,s in enumerate(seg)]
  bad=tool('render_attached_reader',{'file':attach('two-page.pdf'),'page':1,'sourceHash':h1,'translations':es[:long+1]})
  check('render: language omitted names the fix',reason(bad)=='invalid_translation' and 'language' in bad['content'][0]['text'])
  check('render: Spanish with its language accepted',tool('render_attached_reader',{'file':attach('two-page.pdf'),'page':1,'sourceHash':h1,'translations':es,'language':'Spanish'}).get('translations')==es)

  # Source binding.
  both=tool('read_attached_pdf',{'file':attach('two-page.pdf'),'pages':[1,2]})
  check('render: page 1 hash refused for page 2',reason(tool('render_attached_reader',{'file':attach('two-page.pdf'),'page':2,'sourceHash':h1}))=='source_changed')
  check('render: fabricated segments refused',reason(tool('render_attached_reader',{'file':attach('two-page.pdf'),'page':1,'sourceHash':h1,'segments':[{'id':'x','text':'fabricated'}]}))=='invalid_arguments')
  sw=tool('read_attached_pdf',{'file':attach('swap.pdf')});pdfs['swap.pdf']=pdfs['many-page.pdf']
  check('render: bytes swapped behind the same URL refused',reason(tool('render_attached_reader',{'file':attach('swap.pdf'),'page':1,'sourceHash':sw['sourceHash']}))=='source_changed')

  # Analysis bound to its own pages, shown beside another page.
  t=tool('prepare_attachment_task',{'file':attach('two-page.pdf'),'pages':[2],'kind':'summary'})
  s2=next(s for s in t['pages'][0]['segments'] if 'It has a second sentence.' in s['text'])
  an={'kind':'summary','sourcePages':[2],'sourceHash':t['task']['sourceHash'],'content':{'text':'합성 요약이다. 두 번째 문장이 있다.','citations':[{'page':2,'segmentId':s2['id'],'quote':'It has a second sentence.'}]}}
  v=tool('render_attached_reader',{'file':attach('two-page.pdf'),'page':1,'sourceHash':h1,'analysis':an})
  check('analysis: cross-page analysis shown with its scope',v.get('page')==1 and v['analysis']['sourcePages']==[2] and v['analysis']['coversShownPage'] is False,v)
  forged={**an,'content':{**an['content'],'citations':[{'page':2,'segmentId':s2['id'],'quote':'Invented quote.'}]}}
  check('analysis: invented quote refused',reason(tool('render_attached_reader',{'file':attach('two-page.pdf'),'page':1,'sourceHash':h1,'analysis':forged}))=='invalid_analysis')
  check('analysis: other source pages refused',reason(tool('render_attached_reader',{'file':attach('two-page.pdf'),'page':1,'sourceHash':h1,'analysis':{**an,'sourcePages':[1]}}))=='source_changed')

  # Whole document by caller-echoed state: finite, each page once, honest completion.
  def loop(name,limit=40):
   r={'nextPages':[1],'attemptedPages':[],'unreadPages':[]};read=[];calls=0
   while r['nextPages'] and calls<limit:
    r=tool('read_attached_pdf',{'file':attach(name),'pages':r['nextPages'],'attemptedPages':r['attemptedPages'],'unreadPages':r['unreadPages']});calls+=1
    check(f'{name}: call {calls} ok',not r.get('isError'),r);read+=[p['page'] for p in r['pages']]
   return r,read,calls
  r,read,calls=loop('many-page.pdf')
  check('whole document: 12 pages read once each, reported complete only',read==list(range(1,13)) and r['reportedComplete'] is True and r['complete'] is False and r['nextPages']==[] and calls==3,(read,calls))
  r=tool('read_attached_pdf',{'file':attach('two-page.pdf'),'pages':[1,2]})
  check('one call reading every page: verified complete',r['complete'] is True and r['reportedComplete'] is True)
  r=tool('read_attached_pdf',{'file':attach('two-page.pdf'),'pages':[2],'attemptedPages':[1]})
  check('caller-reported page 1: not verified complete',r['complete'] is False and r['reportedComplete'] is True and r['progressBasis']=='caller-reported')
  r,read,calls=loop('mixed-scan.pdf')
  check('mixed scan: finite, scanned pages unread, never complete',r['nextPages']==[] and r['unreadPages']==list(range(1,17)) and r['complete'] is False and r['reportedComplete'] is False and len(read)==len(set(read))==20 and calls==4,(r['unreadPages'],calls))
  r=tool('read_attached_pdf',{'file':attach('long.pdf'),'pages':list(range(193,201)),'attemptedPages':list(range(1,193))})
  check('over 200 pages: limit reported, never complete',r['nextPages']==[] and [r['attachment']['numPages'],r['pageLimit'],r['extractablePages'],r['complete']]==[205,200,200,False])
  r=tool('read_attached_pdf',{'file':attach('many-page.pdf'),'pages':[7,8],'attemptedPages':list(range(1,9))})
  check('caller listing requested pages as attempted is harmless',r['attemptedPages']==list(range(1,9)) and r['nextPages']==list(range(9,13)))

  # Repeat and concurrent calls are identical; each re-downloads (nothing cached).
  n=hits.get('two-page.pdf',0);args={'file':{**attach('two-page.pdf'),'file_id':'file-SYNTHETIC-SAME'},'pages':[1,2]}
  with ThreadPoolExecutor(4) as pool:same=list(pool.map(lambda _:tool('read_attached_pdf',args),range(4)))
  check('repeat/concurrent reads identical',all(x==same[0] for x in same) and not same[0].get('isError'))
  check('every call downloaded again (no server cache)',hits['two-page.pdf']==n+4)

  # Errors: reason only, never the URL or signature.
  e=tool('read_attached_pdf',{'file':attach('expired-1.pdf')})
  check('expired reference asks for a fresh one',reason(e)=='expired' and 'fresh' in e['content'][0]['text'])
  e=tool('read_attached_pdf',{'file':{'download_url':f'https://cdn.example.com/p/x.pdf?{SECRET}','file_id':'file-x'}})
  check('unsupported host names only the host',e['content'][0]['text'].startswith('Attachment error (unsupported_host, host cdn.example.com)') and '/p/x.pdf' not in e['content'][0]['text'])
  n=sum(hits.values());fe=tool('open_pdf_file',{'file':{'name':'synthetic.pdf','resourceUri':'synthetic-resource://file/SYNTHETIC-RESOURCE-ID'}})
  check('file entrypoint call: nothing fetched or echoed',fe.get('fileEntrypoint')=={'fileName':'synthetic.pdf'} and fe['_structured'] and sum(hits.values())==n and 'SYNTHETIC-RESOURCE-ID' not in json.dumps(fe),fe)
  check('scanned page: no invented text',tool('read_attached_pdf',{'file':attach('scanned.pdf')})['unreadPages']==[1])
  check('anonymous refused',tool('read_attached_pdf',{'file':attach('two-page.pdf')},user=False).get('isError'))
  s,b=call('/mcp','POST',{'jsonrpc':'2.0','id':1,'method':'tools/call','params':{'name':'read_attached_pdf','arguments':{'file':attach('two-page.pdf')}}},headers={'Origin':'https://evil.example'})
  # The dev Sites plugin or the route refuses it: an HTTP 403, or a JSON-RPC error result.
  check('cross-origin refused',s==403 or (s==200 and json.loads(b)['result'].get('isError')),s)

  # The original PDF in chunks, bytes only in _meta; the model-visible parts stay small.
  bsha=hashlib.sha256(pdfs['big.pdf']).hexdigest();n=hits.get('big.pdf',0);parts=[];offset=0;results=[]
  while True:
   r=original({'file':attach('big.pdf'),'pdfSha256':bsha,'offset':offset});results.append(r)
   check(f'original chunk {offset}: ok',not r.get('isError') and isinstance(r.get('_meta',{}).get('sundark/originalChunk'),str),r.get('content'))
   chunk_heads.append(r['_meta']['sundark/originalChunk'][:48]);sc=r['structuredContent'];data=base64.b64decode(r['_meta']['sundark/originalChunk'],validate=True);parts.append(data)
   check(f'original chunk {offset}: fields',sorted(sc)==['done','fileId','length','offset','pdfSha256','total'] and sc['offset']==offset and sc['length']==len(data) and sc['total']==len(pdfs['big.pdf']) and sc['pdfSha256']==bsha,sc)
   check(f'original chunk {offset}: content text is the small object, no bytes',json.loads(r['content'][0]['text'])==sc and len(r['content'])==1 and len(r['content'][0]['text'])<1024 and len(json.dumps(sc))<1024 and r['_meta']['sundark/originalChunk'][:64] not in json.dumps(r['content'])+json.dumps(sc))
   offset+=sc['length']
   if sc['done']:break
   check('original: bounded call count',len(parts)<10)
  check('original: two chunks of 2 MiB, done on the last only',[x['structuredContent']['offset'] for x in results]==[0,CHUNK] and [x['structuredContent']['done'] for x in results]==[False,True])
  check('original: chunks reconstruct the exact file',b''.join(parts)==pdfs['big.pdf'])
  check('original: each chunk downloaded the file again (no cache)',hits['big.pdf']==n+2,(n,hits.get('big.pdf')))
  one=original({'file':attach('two-page.pdf'),'pdfSha256':hashlib.sha256(pdfs['two-page.pdf']).hexdigest(),'offset':0})
  check('original: a small file is one done chunk',one['structuredContent']['done'] is True and base64.b64decode(one['_meta']['sundark/originalChunk'])==pdfs['two-page.pdf'])
  bad=original({'file':attach('big.pdf'),'pdfSha256':'0'*64,'offset':0})
  check('original: hash mismatch is source_changed, no bytes',reason(bad)=='source_changed' and '_meta' not in bad and 'structuredContent' not in bad,bad)
  for args,why in (({'offset':1},'unaligned'),({'offset':-CHUNK},'negative'),({'offset':CHUNK*2},'past the end'),({'offset':0.5},'non-integer'),({'pdfSha256':'ABC'},'bad sha'),({'extra':1},'unknown argument')):
   r=original({'file':attach('big.pdf'),'pdfSha256':bsha,'offset':0,**args})
   check(f'original: {why} refused without bytes',r.get('isError') and '_meta' not in r,r)
  check('original: expired reference asks for a fresh one',reason(original({'file':attach('expired-2.pdf'),'pdfSha256':bsha,'offset':0}))=='expired')
  n=sum(hits.values())
  check('original: anonymous refused before any download',original({'file':attach('big.pdf'),'pdfSha256':bsha,'offset':0},user=False).get('isError') and sum(hits.values())==n)

  after_rows,after_r2=d1_counts(),r2_objects()
  check('D1 rows unchanged by every attachment call',after_rows==before_rows,{k:(before_rows.get(k),after_rows.get(k)) for k in set(before_rows)|set(after_rows) if before_rows.get(k)!=after_rows.get(k)})
  check('R2 objects unchanged by every attachment call',after_r2==before_r2,(before_r2,after_r2))
  check('fixture was really downloaded',sum(hits.values())>sum(before_hits.values()))
 check('no signed query or fixture URL in any MCP response',not any('SYNTHETIC-SIGNED-TOKEN' in x or FIXTURE in x for x in raw))
except Exception as e:
 first_failure=f'{type(e).__name__}: {e}'
finally:
 stop();log.close()
log_text=open(log_path,encoding='utf8',errors='replace').read()
if first_failure is None:
 try:
  check('no signed query in the server log','SYNTHETIC-SIGNED-TOKEN' not in log_text)
  check('no download_url or fixture file URL in the server log','download_url' not in log_text and FIXTURE+'/' not in log_text)
  # Base64 of a PDF starts JVBERi0 (%PDF-); every chunk's own head is checked too.
  check('no PDF bytes in the server log','JVBERi0' not in log_text and not any(h in log_text for h in chunk_heads))
 except AssertionError as e:first_failure=str(e)
summary={'mode':MODE,'runtime':'vinext dev (Cloudflare Vite plugin, workerd)' if MODE=='dev' else 'wrangler dev --local on dist/ (workerd)','passed':len(checks),'firstFailure':first_failure,'checks':checks,'serverLog':log_path}
if MODE=='dev' and first_failure is None:summary.update({'d1Counts':after_rows,'r2Objects':after_r2,'resourceMeta':resource_meta})
print(json.dumps(summary,indent=1,ensure_ascii=False))
if first_failure:print(log_text[-4000:],file=sys.stderr);sys.exit(1)
