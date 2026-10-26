"""Local-only synthetic identities and synthetic PDF integration test. Never run against production."""
import urllib.request,urllib.error,json,os
BASE='http://127.0.0.1:5175'
checks=[]
def call(path,method='GET',data=None,user='qa-owner-a',headers=None):
 h={'Origin':BASE}
 if user=='qa-owner-a':h.update({'Cookie':'__sites_local_auth=1'})
 if isinstance(data,dict):data=json.dumps(data).encode();h['Content-Type']='application/json'
 h.update(headers or {})
 try:
  with urllib.request.urlopen(urllib.request.Request(BASE+path,data=data,headers=h,method=method)) as r:return r.status,r.read(),dict(r.headers)
 except urllib.error.HTTPError as e:return e.code,e.read(),dict(e.headers)
def check(name,condition):
 assert condition,name
 checks.append(name)
s,b,h=call('/api/papers',user=None);check('anonymous API rejected',s==401)
s,b,h=call('/api/papers','POST',{'title':'SYNTHETIC QA PDF','authors':'Test only','collection':'QA','notes':'<script>alert(1)</script>'});check('create D1 record',s==201);paper=json.loads(b)['paper'];id=paper['id'];path='/api/papers/'+id
s,b,h=call(path,user='qa-owner-b');check('unsigned identity cannot read',s in (401,404))
s,b,h=call(path,'PATCH',{'title':'stolen'},user='qa-owner-b');check('unsigned identity cannot edit',s in (401,404))
s,b,h=call(path,'PATCH',{'page':4,'zoom':125,'notes':'Synthetic note'});check('save notes reading state',s==200)
s,b,h=call(path);p=json.loads(b)['paper'];check('read persistent state',p['page']==4 and p['notes']=='Synthetic note')
s,b,h=call(path,'PATCH',{'owner':'qa-owner-b','id':'wrong','title':'Safe'});check('client cannot reassign owner',s==200)
s,b,h=call(path,'PATCH',{'title':'csrf'},headers={'Origin':'https://evil.example'});check('cross-origin write rejected',s==403)
s,b,h=call(path,'PATCH',{'page':-1});check('bad pagination rejected',s==400)
s,b,h=call(path+'/file','POST',b'not a pdf',headers={'Content-Type':'application/pdf'});check('invalid PDF signature rejected',s==415)
s,b,h=call(path+'/file','POST',b'%PDF-1.4\n',headers={'Content-Type':'text/html'});check('invalid PDF MIME rejected',s==415)
# Minimal deterministic PDF fixture; contains no real research or user data.
parts=[b'%PDF-1.4\n'];offsets=[0]
objects=[b'<< /Type /Catalog /Pages 2 0 R >>',b'<< /Type /Pages /Kids [3 0 R] /Count 1 >>',b'<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 300] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',b'<< /Length 54 >>\nstream\nBT /F1 14 Tf 30 250 Td (SYNTHETIC QA SAMPLE ONLY) Tj ET\nendstream',b'<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>']
for n,o in enumerate(objects,1):offsets.append(sum(map(len,parts)));parts.append(str(n).encode()+b' 0 obj\n'+o+b'\nendobj\n')
xref=sum(map(len,parts));parts.append(b'xref\n0 6\n0000000000 65535 f \n'+b''.join(f'{o:010} 00000 n \n'.encode() for o in offsets[1:])+f'trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n'.encode());pdf=b''.join(parts)
s,b,h=call(path+'/file','POST',pdf,headers={'Content-Type':'application/pdf','X-File-Name':'synthetic-qa.pdf'});check('upload to R2',s==200)
s,b,h=call(path+'/file');check('R2 bytes preserved',s==200 and b==pdf);check('private non-cacheable PDF',next((v for k,v in h.items() if k.lower()=='cache-control'),None)=='private, no-store')
s,b,h=call(path+'/file',user='qa-owner-b');check('unsigned identity R2 blocked',s in (401,404))
s,b,h=call(path+'/file',user=None);check('anonymous R2 blocked',s==401)
s,b,h=call('/mcp','POST',{'jsonrpc':'2.0','id':1,'method':'tools/call','params':{'name':'search_library','arguments':{'query':'Safe'}}});check('MCP authenticated search',json.loads(b)['result']['content'])
s,b,h=call('/mcp','POST',{'jsonrpc':'2.0','id':2,'method':'tools/call','params':{'name':'read_paper_notes','arguments':{'id':id}}},user='qa-owner-b');check('MCP unsigned identity blocked',json.loads(b)['result']['isError'])
s,b,h=call('/api/papers/..%2F..%2Fsecret/file');check('traversal rejected',s in (400,404))
s,b,h=call('/api/papers/00000000-0000-4000-8000-000000000111');check('foreign owner record inaccessible',s==404)
s,b,h=call('/api/papers/00000000-0000-4000-8000-000000000111/file');check('foreign owner PDF inaccessible',s==404)
s,b,h=call('/api/papers/00000000-0000-4000-8000-000000000111','PATCH',{'notes':'attempt'});check('foreign owner update inaccessible',s==404)
s,b,h=call(path+'/content?page=1');check('empty content cache',s==200 and json.loads(b)['content'] is None);v=json.loads(b)['fileVersion']
content={'fileVersion':v,'page':1,'method':'ocr','confidence':95,'width':600,'height':800,'segments':[{'id':'p1-o0','text':'SYNTHETIC OCR <script>not executable</script>','bbox':[0.1,0.1,0.7,0.05]}]}
s,b,h=call(path+'/content','PUT',content);check('persist extraction cache',s==200)
s,b,h=call(path+'/content?page=1');check('reread OCR cache',json.loads(b)['content']['segments'][0]['text']==content['segments'][0]['text'])
s,b,h=call(path+'/content','PUT',{**content,'fileVersion':'stale'});check('stale file version blocked',s==409)
s,b,h=call(path+'/content','PUT',{**content,'page':201});check('extraction page cap',s==400)
s,b,h=call(path+'/content','PUT',{**content,'segments':[{'id':'x','text':'a','bbox':[2,0,0,0]}]});check('invalid extraction geometry blocked',s==400)
s,b,h=call('/api/papers/00000000-0000-4000-8000-000000000111/content?page=1');check('foreign-owner extraction blocked',s==404)
s,b,h=call('/mcp','POST',{'jsonrpc':'2.0','id':3,'method':'tools/call','params':{'name':'read_paper_page','arguments':{'id':id,'page':1}}});check('MCP reads real saved extraction', 'SYNTHETIC OCR' in json.loads(b)['result']['content'][0]['text'])
open('/tmp/sundark-test-paper-id','w').write(id)
print(json.dumps({'passed':len(checks),'checks':checks,'synthetic_paper_id':id},indent=2))
import uuid

def mcp(name,args,user='qa-owner-a',headers=None):
 s,b,h=call('/mcp','POST',{'jsonrpc':'2.0','id':99,'method':'tools/call','params':{'name':name,'arguments':args}},user=user,headers=headers)
 if s>=400:return {'isError':True,'httpStatus':s}
 r=json.loads(b)['result']
 return r if r.get('isError') else json.loads(r['content'][0]['text'])
r=mcp('import_paper_text',{'title':'SYNTHETIC PLUGIN QA ONLY','pages':[{'text':'Plants use light to grow.\n\nThis synthetic example is not a real study.'}]});tid=r['id'];check('MCP text import',bool(tid))
r=mcp('list_paper_sources',{'id':tid});check('MCP enumerate source pages',len(r['pages'])==1)
src=mcp('read_paper_source',{'id':tid,'pages':[1]});check('source hash returned',len(src['sourceHash'])==64)
a={'id':tid,'requestId':str(uuid.uuid4()),'kind':'translation','language':'ko','sourceHash':src['sourceHash'],'sourcePages':[1],'content':{'segments':[{'id':s['id'],'text':'합성 테스트 번역 '+str(n)} for n,s in enumerate(src['pages'][0]['segments'])]}}
r=mcp('save_paper_analysis',a);check('save immutable translation',r.get('saved'))
r=mcp('save_paper_analysis',a);check('identical retry idempotent',r.get('idempotent'))
r=mcp('save_paper_analysis',{**a,'language':'en'});check('request UUID conflict',r.get('isError'))
r=mcp('save_paper_analysis',{**a,'requestId':str(uuid.uuid4()),'sourceHash':'bad'});check('stale source hash rejected',r.get('isError'))
r=mcp('save_paper_analysis',{**a,'requestId':str(uuid.uuid4()),'content':{'segments':[{'id':'invented','text':'bad'}]}});check('invented/missing segment rejected',r.get('isError'))
r=mcp('save_paper_analysis',{**a,'requestId':str(uuid.uuid4()),'kind':'anatomy','content':{'sections':[{'label':'Finding','text':'Finding','citations':[{'page':1,'segmentId':'p1-t0','quote':'Not present'}]}]}});check('false citation rejected',r.get('isError'))
for kind,output in [('summary',{'text':'Synthetic summary','citations':[{'page':1,'segmentId':'p1-t0','quote':'Plants use light'}]}),('anatomy',{'sections':[{'label':'Finding','text':'Synthetic anatomy','citations':[{'page':1,'segmentId':'p1-t0','quote':'Plants use light'}]}]}),('qa',{'question':'What do plants use?','answer':'Light','citations':[{'page':1,'segmentId':'p1-t0','quote':'Plants use light'}]})]:
 r=mcp('save_paper_analysis',{**a,'requestId':str(uuid.uuid4()),'kind':kind,'content':output});check('save '+kind,r.get('saved'))
r=mcp('read_paper_analysis',{'id':tid});check('read all artifacts',len(r['artifacts'])==4 and not any(x['stale'] for x in r['artifacts']))
s,b,h=call('/api/papers/'+tid+'/analysis');check('Site shares plugin results',s==200 and len(json.loads(b)['artifacts'])==4)
r=mcp('read_paper_analysis',{'id':'00000000-0000-4000-8000-000000000111'});check('foreign analysis read blocked',r.get('isError'))
r=mcp('save_paper_analysis',{**a,'id':'00000000-0000-4000-8000-000000000111','requestId':str(uuid.uuid4())});check('foreign analysis write blocked',r.get('isError'))
r=mcp('import_paper_text',{'title':'CSRF','pages':[{'text':'test'}]},headers={'Origin':'https://evil.example'});check('cross-origin MCP write blocked',r.get('isError'))
s,b,h=call('/mcp','POST',b'{}',headers={'Content-Type':'text/plain'});check('simple content-type MCP blocked',json.loads(b)['result']['isError'])
# Save a PDF-backed result then edit its source, which must mark it stale.
pdfsrc=mcp('read_paper_source',{'id':id,'pages':[1]})
r=mcp('save_paper_analysis',{'id':id,'requestId':str(uuid.uuid4()),'kind':'summary','language':'ko','sourceHash':pdfsrc['sourceHash'],'sourcePages':[1],'content':{'text':'Synthetic summary','citations':[]}});check('PDF source analysis saved',r.get('saved'))
content['segments'][0]['text']='Changed synthetic OCR source'
s,b,h=call(path+'/content','PUT',content);check('source edited',s==200)
r=mcp('read_paper_analysis',{'id':id});check('edited source flags old result stale',r['artifacts'][0]['stale'])
print(json.dumps({'total_passed':len(checks),'new_checks':checks[30:]},indent=2))
# Retry must confirm a prior success even if source changed after the response.
src2=mcp('read_paper_source',{'id':id,'pages':[1]})
retry={'id':id,'requestId':str(uuid.uuid4()),'kind':'summary','language':'ko','sourceHash':src2['sourceHash'],'sourcePages':[1],'content':{'text':'Idempotency fixture','citations':[]}}
check('initial retry fixture save',mcp('save_paper_analysis',retry).get('saved'))
content['segments'][0]['text']='Changed again';call(path+'/content','PUT',content)
check('retry after source change confirms saved',mcp('save_paper_analysis',retry).get('idempotent'))
# Twenty-one source pages must not exceed D1 bound-parameter limit.
for page in range(2,22):
 c={**content,'page':page,'segments':[{'id':'same-id','text':'Same source quote','bbox':[0,0,1,1]}]}
 s,b,h=call(path+'/content','PUT',c);check('create source page '+str(page),s==200)
allsource=mcp('read_paper_source',{'id':id,'pages':list(range(1,22))})
r=mcp('save_paper_analysis',{'id':id,'requestId':str(uuid.uuid4()),'kind':'summary','language':'ko','sourceHash':allsource['sourceHash'],'sourcePages':list(range(1,22)),'content':{'text':'21 page fixture','citations':[{'page':2,'segmentId':'same-id','quote':'Same source'},{'page':21,'segmentId':'same-id','quote':'Same source'}]}})
check('21-page save and cross-page duplicate IDs',r.get('saved'))
# Pagination keeps old translations accessible.
for n in range(21):
 mcp('save_paper_analysis',{**a,'requestId':str(uuid.uuid4()),'kind':'summary','content':{'text':'Pagination '+str(n),'citations':[]}})
r=mcp('read_paper_analysis',{'id':tid});check('analysis pagination first page',len(r['artifacts'])==20 and r['nextCursor']==20)
r=mcp('read_paper_analysis',{'id':tid,'cursor':r['nextCursor']});check('analysis pagination older artifacts',len(r['artifacts'])==5 and r['nextCursor'] is None)
print(json.dumps({'total_passed':len(checks),'latest_checks':checks[-5:]},indent=2))
r=mcp('render_paper_reader',{'id':tid,'page':1});check('embedded reader payload contains saved translation',len(r['segments'])==2 and any(a['kind']=='translation' for a in r['artifacts']))
s,b,h=call('/mcp','POST',{'jsonrpc':'2.0','id':100,'method':'resources/read','params':{'uri':'ui://sundark/reader-v1.html'}})
resource=json.loads(b)['result']['contents'][0];check('optional UI resource served',resource['mimeType']=='text/html;profile=mcp-app' and 'ui/initialize' in resource['text'])
check('resource contains no private fixture text','Plants use light' not in resource['text'])
print(json.dumps({'total_passed':len(checks),'ui_host_rendering_verified':False},indent=2))
# User-selected image crop storage and bounded review export.
from PIL import Image,ImageDraw
import io,base64,zipfile
im=Image.new('RGB',(300,90),'white');ImageDraw.Draw(im).text((15,30),'SYNTHETIC: E = mc^2',fill='black');buf=io.BytesIO();im.save(buf,format='PNG');png=buf.getvalue()
def upload_figure(data=png,version=v,origin=BASE,target=path):
 boundary='SundarkSyntheticBoundary';fields={'page':'1','fileVersion':version,'label':'SYNTHETIC EQUATION CROP','bbox':'[0.1,0.1,0.5,0.2]'};body=b''
 for k,val in fields.items():body+=f'--{boundary}\r\nContent-Disposition: form-data; name="{k}"\r\n\r\n{val}\r\n'.encode()
 body+=f'--{boundary}\r\nContent-Disposition: form-data; name="file"; filename="synthetic.png"\r\nContent-Type: image/png\r\n\r\n'.encode()+data+f'\r\n--{boundary}--\r\n'.encode()
 return call(target+'/figures','POST',body,headers={'Content-Type':'multipart/form-data; boundary='+boundary,'Origin':origin})
s,b,h=upload_figure();check('capture PNG upload',s==200);fid=json.loads(b)['id']
s,b,h=call(path+'/figures');check('figure listed',any(f['id']==fid for f in json.loads(b)['figures']))
s,b,h=call(path+'/figures/'+fid+'/file');check('private R2 figure bytes',s==200 and b==png)
s,b,h=call(path+'/figures/'+fid+'/file',user=None);check('anonymous figure blocked',s==401)
s,b,h=call('/api/papers/'+tid+'/figures/'+fid+'/file');check('cross-paper figure blocked',s==404)
s,b,h=upload_figure(origin='https://evil.example');check('figure CSRF rejected',s==403)
s,b,h=upload_figure(version='old');check('stale figure upload rejected',s==409)
s,b,h=upload_figure(data=png[:33]);check('truncated PNG rejected',s==415)
s,b,h=upload_figure(data=png[:-1]+bytes([png[-1]^1]));check('PNG CRC rejected',s==415)
s,b,h=call('/mcp','POST',{'jsonrpc':'2.0','id':110,'method':'tools/call','params':{'name':'read_paper_figure','arguments':{'id':id,'figureId':fid}}});out=json.loads(b)['result'];check('MCP returns actual image block',out['content'][1]['type']=='image' and base64.b64decode(out['content'][1]['data'])==png)
src=mcp('read_paper_source',{'id':id,'pages':[1]});eq={'id':id,'requestId':str(uuid.uuid4()),'kind':'equation','language':'en','sourceHash':src['sourceHash'],'sourcePages':[1],'content':{'latex':'E=mc^2','explanation':'SYNTHETIC test transcription, not a scientific result.','citations':[],'figureIds':[fid]}}
r=mcp('save_paper_analysis',eq);check('vision artifact references saved figure',r.get('saved'))
r=mcp('save_paper_analysis',{**eq,'requestId':str(uuid.uuid4()),'content':{**eq['content'],'figureIds':[str(uuid.uuid4())]}});check('unknown figure reference rejected',r.get('isError'))
call(path,'PATCH',{'notes':'<script>alert(1)</script> [bad](javascript:alert(1))'})
s,b,h=call(path+'/review');check('review ZIP returned',s==200)
z=zipfile.ZipFile(io.BytesIO(b));check('review ZIP CRC valid',z.testzip() is None);check('review figure preserved',z.read('figures/'+fid+'.png')==png);md=z.read('index.md').decode();check('review escapes raw HTML','<script>' not in md and '&lt;script&gt;' in md);check('review manifest exists',json.loads(z.read('manifest.json'))['paperId']==id)
s,b,h=call(path+'/review',user=None);check('anonymous export blocked',s==401)
print(json.dumps({'total_passed':len(checks),'figure_and_review_checks':True},indent=2))
# Original-derived contracts: geometry, strict batch order, shared glossary,
# explicit Anatomy absence and an actual six-section review (not a backup).
v2={**content,'segments':[{'id':'p1-v2-s0','text':'Plants use light to produce energy.','bbox':[0.1,0.1,0.6,0.1],'schemaVersion':2,'para':'p1-par0','sourceIds':['p1-t0','p1-t1'],'rects':[{'page':1,'bbox':[0.1,0.1,0.5,0.03]},{'page':1,'bbox':[0.1,0.17,0.6,0.03]}],'geometryPrecision':'pdf-item'},{'id':'p1-v2-s1','text':'This is synthetic source text.','bbox':[0.1,0.3,0.5,0.03],'schemaVersion':2,'para':'p1-par0','sourceIds':['p1-t2'],'rects':[{'page':1,'bbox':[0.1,0.3,0.5,0.03]}],'geometryPrecision':'pdf-item'}]}
s,b,h=call(path+'/content','PUT',v2);check('v2 source geometry stored',s==200)
s,b,h=call(path+'/content?page=1');check('v2 multipart geometry survives storage',len(json.loads(b)['content']['segments'][0]['rects'])==2)
bad={**v2,'segments':[{**v2['segments'][0],'rects':[{'page':2,'bbox':[0,0,1,1]}]}]};s,b,h=call(path+'/content','PUT',bad);check('false cross-page geometry rejected',s==400)
prepared=mcp('prepare_paper_task',{'id':id,'pages':[1],'kind':'translation','language':'ko'});check('original-style task contract returned',prepared['translation']['total']==2 and prepared['contractRevision']=='sundark-port-r2')
base={'id':id,'sourcePages':[1],'sourceHash':prepared['sourceHash'],'language':'ko'}
r=mcp('save_paper_analysis',{**base,'requestId':str(uuid.uuid4()),'kind':'translation','content':{'scope':'batch','segments':[{'id':'p1-v2-s0','text':'식물은 빛을 사용하여 에너지를 생산한다.'}]}});check('partial translation batch saved explicitly',r.get('saved'))
r=mcp('prepare_paper_task',{'id':id,'pages':[1],'kind':'translation','language':'ko'});check('partial completion counted honestly',r['translation']['completed']==1 and r['translation']['total']==2)
r=mcp('save_paper_analysis',{**base,'requestId':str(uuid.uuid4()),'kind':'translation','content':{'segments':[{'id':'p1-v2-s1','text':'합성 원문이다.'},{'id':'p1-v2-s0','text':'식물은 빛을 사용한다.'}]}});check('reordered translation rejected',r.get('isError'))
r=mcp('save_paper_analysis',{**base,'requestId':str(uuid.uuid4()),'kind':'glossary','content':{'field':'Synthetic biology example','abbreviations':[],'terms':[{'term':'energy','translation':'에너지'}]}});check('shared paper glossary saved',r.get('saved'))
r=mcp('prepare_paper_task',{'id':id,'pages':[1],'kind':'translation','language':'ko'});check('glossary reused in task context',r['glossary']['content']['terms'][0]['term']=='energy')
absent={'status':'not_present','points':[]};anat={'schemaVersion':2,**{k:absent for k in ['problem','gap','claim','method','limitations']},'evidence':{k:absent for k in ['dataset_test','metric','baseline','ablation']}}
anat['claim']={'status':'present','points':[{'text':'합성 예제다.','kind':'ai_interpretation','citations':[]}]}
r=mcp('save_paper_analysis',{**base,'requestId':str(uuid.uuid4()),'kind':'anatomy','content':anat});check('original Anatomy nullable interpretation accepted',r.get('saved'))
r=mcp('save_paper_analysis',{**base,'requestId':str(uuid.uuid4()),'kind':'anatomy','content':{k:v for k,v in anat.items() if k!='gap'}});check('omitted Anatomy card not mistaken for absence',r.get('isError'))
r=mcp('save_paper_analysis',{**base,'requestId':str(uuid.uuid4()),'kind':'equation','content':{'latex':'x_{','explanation':'bad','citations':[]}});check('malformed LaTeX rejected',r.get('isError'))
s,b,h=call(path+'/review?mode=review&language=ko');check('backup not substituted for generated review',s==409)
review_content={'title':'Synthetic review','paperTitle':'Synthetic source','authors':[],'venue':'','year':None,'tags':['Demo'],'summary':'합성 검증용 리뷰임','sections':[{'key':k,'heading':k,'text':'검증용 합성 메모임','citations':[]} for k in ['summary','background','contributions','method','results','limitations']],'figureIds':[fid]}
r=mcp('save_paper_analysis',{**base,'requestId':str(uuid.uuid4()),'kind':'review','content':review_content});check('six-section review saved',r.get('saved'))
s,b,h=call(path+'/review?mode=review&language=ko');check('generated review ZIP returned',s==200)
z=zipfile.ZipFile(io.BytesIO(b));manifest=json.loads(z.read('manifest.json'));check('review references only chosen figures',manifest['figureIds']==[fid] and manifest['scope']=='generated-review');check('review prose not raw artifact JSON','검증용 합성 메모임' in z.read('index.md').decode() and '"segments"' not in z.read('index.md').decode())
print(json.dumps({'total_passed':len(checks),'original_contract_checks':True},indent=2))
