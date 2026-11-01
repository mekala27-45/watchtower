import test from 'node:test';
import assert from 'node:assert/strict';
import {Readable} from 'node:stream';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createApp} from '../apps/api/server.mjs';
async function request(app,method,url,value={},headers={}) {
 const req=Readable.from(method==='POST'?[Buffer.from(JSON.stringify(value))]:[]);
 Object.assign(req,{method,url,headers:{'content-type':'application/json',...headers},socket:{remoteAddress:'127.0.0.1'}});
 let status,data;const out={};
 const res={setHeader(k,v){out[k]=v;},writeHead(s,h){status=s;Object.assign(out,h);},end(v){data=v;}};
 await app.handler(req,res);
 return {status,headers:out,data:typeof data==='string'?JSON.parse(data):data};
}
test('in-process API demo survives fresh store and recovers one receipt',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'watchtower-api-'));const dbPath=join(dir,'test.sqlite');
 let app=createApp({dbPath});
 try {
  const health=await request(app,'GET','/health');
  assert.equal(health.data.ready,true);assert.equal(health.data.productionReady,false);
  const created=await request(app,'POST','/api/demo/sessions');assert.equal(created.status,201);
  const {id,capability}=created.data;const headers={authorization:'Bearer '+capability};
  const base='/api/demo/sessions/'+id;
  const prepared=await request(app,'POST',base+'/prepare',{},headers);
  assert.equal(prepared.status,200);assert.equal(prepared.data.method,'deterministic_baseline');
  const digest=prepared.data.digest;
  assert.equal((await request(app,'POST',base+'/publish',{digest,operationKey:'test-operation'},headers)).status,409);
  assert.equal((await request(app,'POST',base+'/approve',{digest},headers)).status,200);
  const first=await request(app,'POST',base+'/publish',{digest,operationKey:'test-operation'},headers);
  assert.equal(first.status,200);assert.ok(first.data.receiptId);
  await app.close();app=createApp({dbPath});
  const recovered=await request(app,'POST',base+'/publish',{digest,operationKey:'test-operation'},headers);
  assert.equal(recovered.data.receiptId,first.data.receiptId);assert.equal(recovered.data.recovered,true);
  const other=await request(app,'POST','/api/demo/sessions');
  assert.equal((await request(app,'GET',base,{}, {authorization:'Bearer '+other.data.capability})).status,404);
  assert.equal((await request(app,'GET','/api/evidence/guessed')).status,404);
  assert.deepEqual((await request(app,'GET','/api/briefings')).data.briefings,[]);
 } finally {await app.close();rmSync(dir,{recursive:true,force:true});}
});
test('in-process API refuses origin injection schemas empty bodies and capabilities',async()=>{
 const app=createApp({dbPath:':memory:'});
 try{
  assert.equal((await request(app,'POST','/api/demo/sessions',{}, {origin:'https://untrusted.invalid'})).status,403);
  assert.equal((await request(app,'POST','/api/demo/sessions',{namespace:'live'})).status,400);
  assert.equal((await request(app,'POST','/api/demo/sessions',null)).status,400);
  assert.equal((await request(app,'POST','/api/demo/sessions',{x:'a'.repeat(9000)})).status,413);
  assert.equal((await request(app,'POST','/api/demo/sessions',{}, {'content-type':'text/plain'})).status,415);
  assert.equal((await request(app,'POST','/api/demo/sessions/guessed/prepare')).status,401);
  for(let i=0;i<5;i++)assert.equal((await request(app,'POST','/api/demo/sessions')).status,201);
  assert.equal((await request(app,'POST','/api/demo/sessions')).status,429);
 }finally{await app.close();}
});
test('local adapter refuses production startup',()=>{
 process.env.WATCHTOWER_DEPLOYMENT='production';
 try{assert.throws(()=>createApp(),/postgres_adapter_required/);}finally{delete process.env.WATCHTOWER_DEPLOYMENT;}
});
