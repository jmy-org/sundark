"""ChatGPT attachment import against the real local workerd dev server. Synthetic PDFs and
synthetic identities only; never run against production.

Start the dev server with the local fixture origin (honoured only in dev builds):
  SUNDARK_DEV_FILE_ORIGIN=http://127.0.0.1:5199 CLOUDFLARE_INCLUDE_PROCESS_ENV=true npm run dev -- --port 5175 --strictPort
Apply drizzle/ migrations to .wrangler/state, then run: python3 -I tests/local-pdf-import.py [dev-log-path]
"""
import base64,hashlib,http.server,json,os,shutil,subprocess,sys,tempfile,threading,time,urllib.error,urllib.request,uuid
from concurrent.futures import ThreadPoolExecutor
ROOT=os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BASE='http://127.0.0.1:5175';FIXTURE='http://127.0.0.1:5199';SECRET='sig=SYNTHETIC-SIGNED-TOKEN-7f3a'
OWNER='local_seedy'  # build/sites-vite-plugin.ts mock identity
checks=[]
def check(name,condition):
 assert condition,name
 checks.append(name)
work=tempfile.mkdtemp(prefix='sundark-import-')
subprocess.run(['node',os.path.join(ROOT,'tests/fixtures/synthetic-pdf.mjs'),work],check=True)
pdfs={n:open(os.path.join(work,n),'rb').read() for n in os.listdir(work)}
if shutil.which('qpdf'):
 subprocess.run(['qpdf','--encrypt','synthetic-user','synthetic-owner','256','--',os.path.join(work,'two-page.pdf'),os.path.join(work,'encrypted.pdf')],check=True)
 pdfs['encrypted.pdf']=open(os.path.join(work,'encrypted.pdf'),'rb').read()
hits={}
class Fixture(http.server.BaseHTTPRequestHandler):
 def log_message(self,*a):pass
 def do_GET(self):
  path=self.path.split('?')[0].lstrip('/');hits[path]=hits.get(path,0)+1
  if path=='redirect':self.send_response(302);self.send_header('Location','/two-page.pdf?'+SECRET);self.end_headers();return
  if path=='big-declared':self.send_response(200);self.send_header('Content-Length',str(20*1024*1024+1));self.end_headers();self.wfile.write(b'%PDF-1.4\n');return
  if path=='big-stream':
   self.send_response(200);self.end_headers()
   try:
    for _ in range(21):self.wfile.write(b'%PDF-1.4\n'+b' '*(1024*1024))
   except (BrokenPipeError,ConnectionResetError):pass
   return
  body={'notpdf':b'<html>not a pdf</html>','badpdf':b'%PDF-1.4\nthis is not a real document\n%%EOF\n'}.get(path) or pdfs.get(path)
  if body is None:self.send_response(404);self.end_headers();return
  self.send_response(200);self.send_header('Content-Type','application/pdf');self.send_header('Content-Length',str(len(body)));self.end_headers();self.wfile.write(body)
server=http.server.ThreadingHTTPServer(('127.0.0.1',5199),Fixture);threading.Thread(target=server.serve_forever,daemon=True).start()
def call(path,method='GET',data=None,user='qa-owner-a',headers=None):
 h={'Origin':BASE}
 if user=='qa-owner-a':h['Cookie']='__sites_local_auth=1'
 if isinstance(data,dict):data=json.dumps(data).encode();h['Content-Type']='application/json'
 h.update(headers or {})
 try:
  with urllib.request.urlopen(urllib.request.Request(BASE+path,data=data,headers=h,method=method),timeout=120) as r:return r.status,r.read(),dict(r.headers)
 except urllib.error.HTTPError as e:return e.code,e.read(),dict(e.headers)
raw=[]
def mcp(name,args,user='qa-owner-a',headers=None):
 s,b,h=call('/mcp','POST',{'jsonrpc':'2.0','id':1,'method':'tools/call','params':{'name':name,'arguments':args}},user=user,headers=headers)
 raw.append(b.decode('utf8','replace'))
 if s>=400:return {'isError':True,'httpStatus':s}
 r=json.loads(b)['result']
 return r if r.get('isError') else json.loads(r['content'][0]['text'])
def attach(name,file_id=None,query=SECRET):return {'download_url':f'{FIXTURE}/{name}?{query}','file_id':file_id or 'file-'+uuid.uuid4().hex,'mime_type':'application/pdf','file_name':name}
def imp(name,request=None,file_id=None,**extra):return mcp('import_paper_pdf',{'file':attach(name,file_id),'requestId':request or str(uuid.uuid4()),**extra})
def papers():return json.loads(call('/api/papers')[1])['papers']
r2dir=os.path.join(ROOT,'.wrangler/state/v3/r2')
def r2_objects():return sum(len(f) for d,_,f in os.walk(r2dir) if os.path.basename(d)=='blobs')
d1conf=os.path.join(work,'d1.json');json.dump({'name':'site-creator-vinext-starter','compatibility_date':'2026-05-15','d1_databases':[{'binding':'DB','database_name':'site-creator-d1','database_id':'00000000-0000-4000-8000-000000000000'}]},open(d1conf,'w'))
def sql(command,*flags):return subprocess.run(['node',os.path.join(ROOT,'node_modules/wrangler/bin/wrangler.js'),'d1','execute','DB','--local','--config',d1conf,'--persist-to',os.path.join(ROOT,'.wrangler/state'),'--command',command,*flags],check=True,capture_output=True,text=True,env={**os.environ,'WRANGLER_SEND_METRICS':'false'}).stdout
def rows(command):return json.loads(sql(command,'--json'))[0]['results']

# Tool contract: ChatGPT file params declare the complete official file object.
tools={t['name']:t for t in json.loads(call('/mcp','POST',{'jsonrpc':'2.0','id':1,'method':'tools/list'})[1])['result']['tools']}
t=tools['import_paper_pdf'];fp=t['inputSchema']['properties']['file']
check('fileParams declared',t['_meta']['openai/fileParams']==['file'])
check('file schema declares all four fields',set(fp['properties'])=={'download_url','file_id','mime_type','file_name'} and set(fp['required'])=={'download_url','file_id'} and fp['additionalProperties'] is False)
check('extract tool present',tools['extract_paper_pages']['inputSchema']['properties']['pages']['maxItems']<=8)
check('import_paper_text no longer sends PDFs to the Site','open the Site reader URL' not in tools['import_paper_text']['description'])

# 1. Happy path: exact original bytes, server text extraction, geometry and parity.
before_papers,before_r2=len(papers()),r2_objects()
request=str(uuid.uuid4());fid='file-'+uuid.uuid4().hex
r=imp('two-page.pdf',request,fid);pid=r['paperId']
check('import saved paper',r['idempotent'] is False and len(papers())==before_papers+1 and r2_objects()==before_r2+1)
check('original sha256 reported',r['sha256']==hashlib.sha256(pdfs['two-page.pdf']).hexdigest() and r['size']==len(pdfs['two-page.pdf']))
s,b,h=call('/api/papers/'+pid+'/file');check('original bytes byte-identical',s==200 and b==pdfs['two-page.pdf'])
e=r['extraction'];check('both pages extracted on import',e['extractedPages']==[1,2] and e['missingPages']==[] and e['complete'] is True and r['numPages']==2)
check('reader URL returned',r['readerUrl'].endswith('/?paper='+pid))
src=mcp('list_paper_sources',{'id':pid});check('sources list text pages',[(p['page'],p['method']) for p in src['pages']]==[(1,'text'),(2,'text')])
src=mcp('read_paper_source',{'id':pid,'pages':[1,2]});segs=[s for p in src['pages'] for s in p['segments']]
check('fixture sentences extracted','Plants use light to grow.' in [s['text'] for s in segs] and any(s['text'].startswith('This synthetic sentence wraps across two lines') for s in segs))
check('segment geometry non-zero',all(s['bbox'][2]>0 and s['bbox'][3]>0 and s['rects'] and s['geometryPrecision']=='pdf-item' for s in segs))
expected=json.loads(subprocess.run(['node','--input-type=module','-e',"""
import {readFileSync} from 'node:fs';import * as pdf from 'pdfjs-dist/build/pdf.mjs';import {buildSentenceSegments,pdfTextAtoms} from './lib/source-geometry.ts';
Uint8Array.prototype.toHex??=function(){return Buffer.from(this).toString('hex')};globalThis.pdfjsWorker=await import('pdfjs-dist/build/pdf.worker.mjs');const t=pdf.getDocument({data:new Uint8Array(readFileSync(process.argv[1])),useWorkerFetch:false,isEvalSupported:false,disableFontFace:true});const d=await t.promise;const out=[];
for(let n=1;n<=d.numPages;n++){const p=await d.getPage(n);const v=p.getViewport({scale:1});out.push(buildSentenceSegments(pdfTextAtoms(await p.getTextContent(),v,pdf.Util.transform,n),n,'text'))}console.log(JSON.stringify(out));await t.destroy()
""",os.path.join(work,'two-page.pdf')],cwd=ROOT,check=True,capture_output=True,text=True).stdout)
check('server segments equal browser pdf.js build',[p['segments'] for p in src['pages']]==expected)
s,b,h=call('/api/papers/'+pid+'/content?page=1');check('browser reader sees server extraction',json.loads(b)['content']['method']=='text' and json.loads(b)['fileVersion']==r['fileVersion'])

# 2. No website preparation: prepare -> ChatGPT translation saved -> reader.
for page in (1,2):
 prep=mcp('prepare_paper_task',{'id':pid,'pages':[page],'kind':'translation','language':'ko'})
 check(f'prepare translation page {page}',prep['translation']['total']>0)
 one=mcp('read_paper_source',{'id':pid,'pages':[page]})
 out=mcp('save_paper_analysis',{'id':pid,'requestId':str(uuid.uuid4()),'kind':'translation','language':'ko','sourceHash':one['sourceHash'],'sourcePages':[page],'content':{'scope':'page','segments':[{'id':s['id'],'text':f'합성 번역 문장 {n}이다.'} for n,s in enumerate(one['pages'][0]['segments'])]}})
 check(f'save translation page {page}',out.get('saved'))
 check(f'translation complete page {page}',mcp('prepare_paper_task',{'id':pid,'pages':[page],'kind':'translation','language':'ko'})['translation']['completed']==prep['translation']['total'])
view=mcp('render_paper_reader',{'id':pid,'page':1});check('render reader with saved translation',view['readerUrl'].endswith('/?paper='+pid) and any(a['kind']=='translation' for a in view['artifacts']))
s,b,h=call('/?paper='+pid);check('reader page served',s==200)

# 3. Idempotency: replay with a fresh signed URL never re-downloads; conflicts are rejected.
n_hits,n_papers,n_r2=hits['two-page.pdf'],len(papers()),r2_objects()
again=mcp('import_paper_pdf',{'file':attach('two-page.pdf',fid,'sig=ROTATED'),'requestId':request})
check('replay idempotent',again.get('idempotent') is True and again['paperId']==pid and again['sha256']==r['sha256'])
check('replay did not download',hits['two-page.pdf']==n_hits)
conflict=mcp('import_paper_pdf',{'file':attach('many-page.pdf'),'requestId':request})
check('same requestId different file rejected',conflict.get('isError') and hits.get('many-page.pdf',0)==0)
check('no side effects from replay/conflict',len(papers())==n_papers and r2_objects()==n_r2)
check('requestId must be a UUID',imp('two-page.pdf','not-a-uuid').get('isError'))
crequest=str(uuid.uuid4());cfid='file-'+uuid.uuid4().hex
with ThreadPoolExecutor(4) as pool:same=list(pool.map(lambda _:imp('two-page.pdf',crequest,cfid),range(4)))
ids={x.get('paperId') for x in same}
check('concurrent same requestId yields one paper',len(ids)==1 and None not in ids and len(papers())==n_papers+1 and r2_objects()==n_r2+1)

# 4. Owner isolation and origin checks.
check('other identity cannot read imported paper',mcp('read_paper_source',{'id':pid,'pages':[1]},user='qa-owner-b').get('isError'))
check('other identity cannot extract',mcp('extract_paper_pages',{'id':pid,'pages':[1]},user='qa-owner-b').get('isError'))
check('anonymous cannot import',mcp('import_paper_pdf',{'file':attach('two-page.pdf'),'requestId':str(uuid.uuid4())},user=None).get('isError'))
s,b,h=call('/api/papers/'+pid+'/file',user='qa-owner-b');check('other identity cannot read original',s in (401,404))
check('cross-origin import rejected',mcp('import_paper_pdf',{'file':attach('two-page.pdf'),'requestId':str(uuid.uuid4())},headers={'Origin':'https://evil.example'}).get('isError'))

# 5. Unsafe or invalid files: rejected with no paper, no R2 object.
n_papers,n_r2,h0=len(papers()),r2_objects(),hits.get('two-page.pdf',0)
bad=[('non-allowlisted host',{'download_url':'https://evil.example/x.pdf?'+SECRET,'file_id':'file-x'}),
 ('http non-local',{'download_url':'http://files.oaiusercontent.com/x?'+SECRET,'file_id':'file-x'}),
 ('credentials in URL',{'download_url':'https://u:p@files.oaiusercontent.com/x?'+SECRET,'file_id':'file-x'}),
 ('IP literal',{'download_url':'https://169.254.169.254/latest?'+SECRET,'file_id':'file-x'}),
 ('other local port',{'download_url':'http://127.0.0.1:5175/api/papers?'+SECRET,'file_id':'file-x'}),
 ('missing file_id',{'download_url':FIXTURE+'/two-page.pdf?'+SECRET}),
 ('redirect',attach('redirect')),('oversize by header',attach('big-declared')),('oversize by stream',attach('big-stream')),
 ('non-PDF signature',attach('notpdf')),('unparseable PDF',attach('badpdf')),('not found',attach('nothing.pdf'))]
for label,f in bad:
 out=mcp('import_paper_pdf',{'file':f,'requestId':str(uuid.uuid4())})
 check('rejected: '+label,out.get('isError') and 'SYNTHETIC-SIGNED-TOKEN' not in json.dumps(out) and FIXTURE not in json.dumps(out))
check('redirect target and pre-validation failures never fetched',hits.get('two-page.pdf',0)==h0)
check('rejections left no paper or R2 object',len(papers())==n_papers and r2_objects()==n_r2)

# 6. Scanned (image-only) PDF: original kept, no invented source, honest OCR flag.
r=imp('scanned.pdf');sid=r['paperId']
check('scanned original stored',call('/api/papers/'+sid+'/file')[1]==pdfs['scanned.pdf'])
check('scanned reports needs OCR',r['extraction']['needsOcrPages']==[1] and r['extraction']['extractedPages']==[] and r['extraction']['complete'] is False)
check('scanned has no fake source',mcp('list_paper_sources',{'id':sid})['pages']==[] and mcp('prepare_paper_task',{'id':sid,'pages':[1],'kind':'translation','language':'ko'}).get('isError'))
if 'encrypted.pdf' in pdfs:
 erq,efid=str(uuid.uuid4()),'file-'+uuid.uuid4().hex;r=imp('encrypted.pdf',erq,efid)
 check('encrypted original stored, reported honestly',not r.get('isError') and r['extraction']['encrypted'] is True and r['extraction']['extractedPages']==[] and call('/api/papers/'+r['paperId']+'/file')[1]==pdfs['encrypted.pdf'])
 check('encrypted extraction errors',mcp('extract_paper_pages',{'id':r['paperId'],'pages':[1]}).get('isError'))
 again=imp('encrypted.pdf',erq,efid);check('encrypted replay keeps the encrypted flag',again.get('idempotent') is True and again['extraction']['encrypted'] is True)

# 7. Whole document by repeated bounded calls; never reported complete early.
r=imp('many-page.pdf');mid=r['paperId'];e=r['extraction']
check('import extracts only a first batch',r['numPages']==12 and e['complete'] is False and e['extractedPages']==[1,2,3,4] and e['nextPages'][0]==5)
check('oversized batch rejected',mcp('extract_paper_pages',{'id':mid,'pages':list(range(1,10))}).get('isError'))
check('out-of-document page rejected',mcp('extract_paper_pages',{'id':mid,'pages':[13]}).get('isError'))
calls=0
while not e['complete'] and calls<5:e=mcp('extract_paper_pages',{'id':mid,'pages':e['nextPages']});calls+=1
check('repeated calls finish the whole PDF',e['complete'] and e['extractedPages']==list(range(1,13)) and e['missingPages']==[] and e['nextPages']==[])
check('re-extract keeps saved pages',mcp('extract_paper_pages',{'id':mid,'pages':[1]})['alreadySavedPages']==[1])

# 7b. 20 pages with 16 scanned first: continuation reaches the text pages, ends, never repeats.
mrq,mfid=str(uuid.uuid4()),'file-'+uuid.uuid4().hex;r=imp('mixed-scan.pdf',mrq,mfid);xid=r['paperId'];e=r['extraction'];offered=[1,2,3,4];calls=0
while e['nextPages'] and calls<8:offered+=e['nextPages'];e=mcp('extract_paper_pages',{'id':xid,'pages':e['nextPages']});calls+=1
check('mixed scan: text pages after a long scanned run are extracted',e['extractedPages']==list(range(17,21)) and e['nextPages']==[])
check('mixed scan: scanned pages reported, never offered twice',e['needsOcrPages']==list(range(1,17)) and e['complete'] is False and len(offered)==len(set(offered)))
check('mixed scan: no invented source',[p['page'] for p in mcp('list_paper_sources',{'id':xid})['pages']]==list(range(17,21)))
again=imp('mixed-scan.pdf',mrq,mfid)['extraction'];check('mixed scan replay is honest',again['needsOcrPages']==list(range(1,17)) and again['nextPages']==[] and again['extractedPages']==list(range(17,21)))
s,b,h=call('/api/papers/'+xid+'/file','POST',pdfs['two-page.pdf'],headers={'Content-Type':'application/pdf','X-File-Name':'replacement.pdf'})
check('replacing the PDF clears old outcomes and pages',s==200 and rows(f"SELECT count(*) AS n FROM page_outcomes WHERE paper_id='{xid}'")[0]['n']==0 and rows(f"SELECT count(*) AS n FROM page_contents WHERE paper_id='{xid}'")[0]['n']==0)
e=mcp('extract_paper_pages',{'id':xid,'pages':[1,2]});check('replacement extracts fresh',e['extractedPages']==[1,2] and e['needsOcrPages']==[] and e['complete'] is True)

# 8. Library quotas, also under concurrency.
n_papers,n_r2=len(papers()),r2_objects()
sql(f"INSERT INTO papers (id,owner,title,size,updated_at) VALUES ('quota-size','{OWNER}','SYNTHETIC QUOTA',{500*1024*1024-sum(p['size'] for p in papers())-1000},'2000-01-01')")
try:check('500 MiB library quota',imp('two-page.pdf').get('isError') and r2_objects()==n_r2)
finally:sql("DELETE FROM papers WHERE id='quota-size'")
free=2000-len(papers())-1
sql(f"WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<{free}) INSERT INTO papers (id,owner,title,updated_at) SELECT 'quota-'||i,'{OWNER}','SYNTHETIC QUOTA','2000-01-01' FROM n")
try:
 with ThreadPoolExecutor(2) as pool:race=list(pool.map(lambda n:imp(n),['two-page.pdf','scanned.pdf']))
 check('2,000 paper quota holds under concurrency',sum(1 for x in race if not x.get('isError'))==1 and r2_objects()==n_r2+1)
finally:sql("DELETE FROM papers WHERE id LIKE 'quota-%'")

# 9. Secrecy: no signed URL or token in any response or dev log.
check('no token in any MCP response',not any('SYNTHETIC-SIGNED-TOKEN' in x for x in raw))
if len(sys.argv)>1:check('no token in dev server log','SYNTHETIC-SIGNED-TOKEN' not in open(sys.argv[1],encoding='utf8',errors='replace').read())
server.shutdown();shutil.rmtree(work,ignore_errors=True)
print(json.dumps({'passed':len(checks),'encrypted_fixture':'encrypted.pdf' in pdfs,'checks':checks},indent=1,ensure_ascii=False))
