import http from 'node:http';
import {readFileSync,existsSync,mkdirSync} from 'node:fs';
import {dirname,resolve,extname} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
import {Store} from '../../packages/workflow/store.mjs';
import {DISCLAIMER} from '../../packages/reports/index.mjs';
const ROOT=resolve(dirname(fileURLToPath(import.meta.url)),'../..');
export const CONTRACT='watchtower-local-v1';
const mime={'.html':'text/html; charset=utf-8','.css':'text/css; charset=utf-8','.mjs':'text/javascript; charset=utf-8','.js':'text/javascript; charset=utf-8','.json':'application/json'};
function error(code,status=400){return Object.assign(Error(code),{code,status});}
async function body(req){
 if(!String(req.headers['content-type']||'').startsWith('application/json')) throw error('json_required',415);
 let size=0; const chunks=[];
 for await(const chunk of req) {size+=chunk.length;if(size>8192) throw error('request_too_large',413);chunks.push(chunk);}
 let value;try{value=JSON.parse(Buffer.concat(chunks).toString());}catch{throw error('invalid_json');}
 if(!value||Array.isArray(value)||typeof value!=='object')throw error('object_required');
 return value;
}
function fields(value,allowed){if(Object.keys(value).some(k=>!allowed.includes(k)))throw error('unknown_field');}
export function createApp({dbPath=resolve(ROOT,'state/local.sqlite'),revision=process.env.BUILD_REVISION||'local-unreleased',origins=[]}={}){
 if(process.env.WATCHTOWER_DEPLOYMENT==='production') throw error('postgres_adapter_required_for_production',503);
 if(dbPath!==':memory:') mkdirSync(dirname(dbPath),{recursive:true});
 const store=new Store(dbPath);
 const handler=async(req,res)=>{
  const send=(status,value)=>{
   res.writeHead(status,{'content-type':'application/json; charset=utf-8','cache-control':'no-store','x-content-type-options':'nosniff'});
   res.end(JSON.stringify(value));
  };
  try{
   const origin=req.headers.origin;
   const address=server.address();
   const allowed=new Set([...origins,'http://localhost:'+address?.port,'http://127.0.0.1:'+address?.port]);
   if(origin&&!allowed.has(origin))throw error('origin_rejected',403);
   if(origin){res.setHeader('access-control-allow-origin',origin);res.setHeader('vary','Origin');}
   if(req.method==='OPTIONS'){res.writeHead(204,{'access-control-allow-methods':'GET, POST, OPTIONS','access-control-allow-headers':'content-type, authorization'});res.end();return;}
   const url=new URL(req.url,'http://localhost');
   const path=url.pathname;
   if(req.method==='GET'&&path==='/health') {
    let ready=true;try{store.listSources('live');}catch{ready=false;}
    return send(ready?200:503,{namespace:'system',mode:'local_candidate',alive:true,ready,productionReady:false,database:{state:ready?'connected':'unavailable',backend:'sqlite_local_candidate'},revision,contract:CONTRACT});
   }
   if(req.method==='GET'&&path==='/api/sources') {
    const sources=store.listSources('live');return send(200,{namespace:'live',mode:'live_source',sources,coverage:'unknown',lastAttempt:null,lastUsableEvidence:null,notice:'No actual collection dispatch has been verified.'});
   }
   if(req.method==='GET'&&path==='/api/reports/current'){
    const p=resolve(ROOT,'reports/current.json');
    return send(200,existsSync(p)?JSON.parse(readFileSync(p,'utf8')):{namespace:'reports',mode:'separate_methods',baseline:{status:'unavailable'},model:{status:'not_executed'},disclaimer:DISCLAIMER});
   }
   if(req.method==='GET'&&path==='/api/briefings')return send(200,{namespace:'live',mode:'live_source',briefings:store.listBriefings('live')});
   const read=path.match(/^\/api\/(runs|evidence|briefings)\/([a-zA-Z0-9_-]{1,128})$/);
   if(req.method==='GET'&&read) {
    const value=read[1]==='runs'?store.getRun('live',read[2]):read[1]==='evidence'?store.getEvidence('live',read[2]):store.getBriefing('live',read[2]);
    if(!value)throw error('not_found',404);return send(200,{namespace:'live',mode:'live_source',...value});
   }
   if(req.method==='POST'&&path==='/api/demo/sessions'){
    const input=await body(req);fields(input,[]);
    const clientKey=createHash('sha256').update(req.socket.remoteAddress||'local').digest('hex');
    return send(201,store.createDemoSession({clientKey}));
   }
   const demo=path.match(/^\/api\/demo\/sessions\/([a-zA-Z0-9_-]{1,128})(?:\/(prepare|approve|publish))?$/);
   if(demo){
    const cap=(req.headers.authorization||'').match(/^Bearer ([a-zA-Z0-9_-]{20,200})$/)?.[1];
    if(!cap)throw error('unauthorized',401);
    const [,id,action]=demo;
    if(req.method==='GET'&&!action)return send(200,store.getDemoSession(id,cap));
    if(req.method==='POST'&&action) {
     const input=await body(req);
     if(action==='prepare'){fields(input,[]);return send(200,store.prepareDemo(id,cap));}
     if(action==='approve'){fields(input,['digest']);if(typeof input.digest!=='string')throw error('digest_required');return send(200,store.approveDemo(id,cap,{briefingDigest:input.digest}));}
     fields(input,['digest','operationKey']);
     if(typeof input.digest!=='string'||typeof input.operationKey!=='string'||input.operationKey.length<1||input.operationKey.length>128)throw error('invalid_publication');
     return send(200,store.publishDemo(id,cap,{briefingDigest:input.digest,operationKey:input.operationKey}));
    }
   }
   if(req.method==='GET'&&!path.startsWith('/api/')){
    const safe=path==='/'?'index.html':path.slice(1);
    if(!/^[a-zA-Z0-9_./-]+$/.test(safe)||safe.includes('..'))throw error('not_found',404);
    const file=resolve(ROOT,'apps/site',safe);
    if(!existsSync(file))throw error('not_found',404);
    res.writeHead(200,{'content-type':mime[extname(file)]||'application/octet-stream','x-content-type-options':'nosniff','content-security-policy':"default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'"});res.end(readFileSync(file));return;
   }
   throw error('not_found',404);
  }catch(e){
   const code=typeof e.code==='string'&&/^[a-z_]{2,80}$/.test(e.code)?e.code:'internal_error';
   send(e.status||500,{namespace:'request',mode:'local_candidate',error:{code,message:code.replaceAll('_',' ')}});
  }
 };
 const server=http.createServer(handler);
 server.requestTimeout=10000;server.headersTimeout=10000;server.keepAliveTimeout=3000;
 return {server,store,handler,close:()=>new Promise(resolve=>server.close(()=>{store.close?.();resolve();}))};
}
if(process.argv[1]&&pathToFileURL(resolve(process.argv[1])).href===import.meta.url){
 const app=createApp({dbPath:process.env.WATCHTOWER_DB||resolve(ROOT,'state/local.sqlite'),origins:(process.env.WATCHTOWER_ORIGINS||'').split(',').filter(Boolean)});
 app.server.listen(Number(process.env.PORT||4318),'127.0.0.1',()=>console.log('Watchtower local candidate at http://127.0.0.1:'+app.server.address().port));
 process.on('SIGTERM',()=>app.close().then(()=>process.exit(0)));
}
