"""Local-only synthetic identities and synthetic PDF integration test. Never run against production."""
import urllib.request,urllib.error,json,os
BASE='http://127.0.0.1:8787'
checks=[]
def call(path,method='GET',data=None,user='qa-owner-a',headers=None):
 h={'Origin':BASE}
 if user:h.update({'oai-authenticated-user-id':user,'oai-authenticated-user-email':user+'@example.test'})
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
s,b,h=call(path,user='qa-owner-b');check('other identity cannot read',s==404)
s,b,h=call(path,'PATCH',{'title':'stolen'},user='qa-owner-b');check('other identity cannot edit',s==404)
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
s,b,h=call(path+'/file');check('R2 bytes preserved',s==200 and b==pdf);check('private non-cacheable PDF',h.get('Cache-Control')=='private, no-store')
s,b,h=call(path+'/file',user='qa-owner-b');check('cross-user R2 blocked',s==404)
s,b,h=call(path+'/file',user=None);check('anonymous R2 blocked',s==401)
s,b,h=call('/mcp','POST',{'jsonrpc':'2.0','id':1,'method':'tools/call','params':{'name':'search_library','arguments':{'query':'Safe'}}});check('MCP authenticated search',json.loads(b)['result']['content'])
s,b,h=call('/mcp','POST',{'jsonrpc':'2.0','id':2,'method':'tools/call','params':{'name':'read_paper_notes','arguments':{'id':id}}},user='qa-owner-b');check('MCP cross-user blocked',json.loads(b)['result']['isError'])
s,b,h=call('/api/papers/..%2F..%2Fsecret/file');check('traversal rejected',s in (400,404))
open('/tmp/sundark-test-paper-id','w').write(id)
print(json.dumps({'passed':len(checks),'checks':checks,'synthetic_paper_id':id},indent=2))
