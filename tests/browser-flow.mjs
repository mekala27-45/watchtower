import {chromium,expect} from '@playwright/test';
import {createServer} from 'node:http';
import {readFile,mkdir,writeFile} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {resolve,extname} from 'node:path';
import {execFileSync} from 'node:child_process';
import {createApp} from '../apps/api/server.mjs';
import {PostgresStore} from '../packages/workflow/postgres.mjs';

const root=resolve(import.meta.dirname,'..');
const label=process.env.WATCHTOWER_BROWSER_LABEL||'local';
if(!/^[a-z0-9_-]+$/.test(label))throw Error('invalid_report_label');
const output=resolve(root,'reports/browser');await mkdir(output,{recursive:true});
const rows=[],frames=[],errors=[];
const report={schema:'watchtower-browser-verification-v1',label,started_at:new Date().toISOString(),source_revision:execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim(),backend:null,tests:rows,screenshots:frames,errors};
let app,staticServer,browser,page;
async function check(name,fn){try{const detail=await fn();rows.push({name,status:'passed',...(detail?{detail}:{})});}catch(error){rows.push({name,status:'failed',error:error.message});throw error;}}
async function capture(name){const file=`${label}-${name}.png`;await page.screenshot({path:resolve(output,file),fullPage:true,animations:'disabled'});frames.push(file);}
async function contrast(){return page.evaluate(()=>{
  const rgba=s=>s.match(/[\d.]+/g)?.map(Number),luminance=rgb=>{const values=rgb.slice(0,3).map(v=>v/255).map(v=>v<=.04045?v/12.92:((v+.055)/1.055)**2.4);return values[0]*.2126+values[1]*.7152+values[2]*.0722;};
  const failures=[];let checked=0,worst=100;
  for(const element of document.querySelectorAll('body *')){
    if(!element.checkVisibility() || ![...element.childNodes].some(n=>n.nodeType===3&&n.textContent.trim()))continue;
    const style=getComputedStyle(element),fg=rgba(style.color);if(!fg)continue;
    let node=element,bg;
    while(node){const color=rgba(getComputedStyle(node).backgroundColor);if(color && (color.length===3||color[3]===1)){bg=color;break;}node=node.parentElement;}
    if(!bg)continue;
    const lum=[luminance(fg),luminance(bg)].sort((a,b)=>b-a),ratio=(lum[0]+.05)/(lum[1]+.05);
    const large=parseFloat(style.fontSize)>=24||(parseFloat(style.fontSize)>=18.66&&Number(style.fontWeight)>=700),minimum=large?3:4.5;
    checked++;worst=Math.min(worst,ratio);if(ratio+0.01<minimum)failures.push({tag:element.tagName,id:element.id,text:element.textContent.slice(0,60),ratio,minimum});
  }
  return {checked,worst,failures};
});}
try{
  let siteURL=process.env.WATCHTOWER_BROWSER_URL;
  if(!siteURL){
    const store=process.env.WATCHTOWER_BROWSER_POSTGRES==='1'?await PostgresStore.create({connectionString:process.env.DATABASE_URL}):undefined;
    app=createApp({dbPath:':memory:',store,revision:report.source_revision});
    await new Promise(r=>app.server.listen(0,'127.0.0.1',r));
    const apiURL='http://127.0.0.1:'+app.server.address().port;
    staticServer=createServer(async(req,res)=>{
      try{
        if(req.url==='/health'||req.url.startsWith('/api/')){
          const chunks=[];for await(const chunk of req)chunks.push(chunk);
          const headers={...req.headers};delete headers.host;delete headers.connection;delete headers.origin;
          const response=await fetch(apiURL+req.url,{method:req.method,headers,...(chunks.length?{body:Buffer.concat(chunks)}:{})});
          res.writeHead(response.status,Object.fromEntries(response.headers));res.end(Buffer.from(await response.arrayBuffer()));return;
        }
        const path=decodeURIComponent(new URL(req.url,'http://localhost').pathname);
        if(path.includes('..')){res.writeHead(400).end();return;}
        const file=resolve(root,'dist/site',path==='/'?'index.html':path.slice(1));
        const content=await readFile(file);res.writeHead(200,{'content-type':({'.html':'text/html','.js':'text/javascript','.css':'text/css','.json':'application/json','.woff2':'font/woff2'})[extname(file)]||'application/octet-stream'});res.end(content);
      }catch{res.writeHead(404).end();}
    });
    await new Promise(r=>staticServer.listen(0,'127.0.0.1',r));siteURL='http://127.0.0.1:'+staticServer.address().port;
  }
  report.site_url=siteURL;
  const executable=process.env.WATCHTOWER_BROWSER_EXECUTABLE||['C:/Program Files/Google/Chrome/Application/chrome.exe','C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].find(existsSync);
  browser=await chromium.launch({headless:true,...(executable?{executablePath:executable}:{})});
  report.browser_version=browser.version();
  const context=await browser.newContext({viewport:{width:1440,height:1000},reducedMotion:'reduce'});page=await context.newPage();
  page.on('pageerror',e=>errors.push({kind:'pageerror',message:e.message}));
  await page.goto(siteURL);await expect(page.locator('#readiness')).toContainText('API connected');
  const configured=await page.locator('html').getAttribute('data-api-base'),apiURL=configured||new URL(siteURL).origin;
  const health=await (await fetch(apiURL+'/health')).json();report.backend=health.database?.backend;report.api_revision=health.revision;report.api_url=apiURL;
  await check('compiled site loads local fonts and four labeled views',async()=>{
    await page.evaluate(()=>document.fonts.ready);
    for(const font of ['Bodoni Moda','Noto Sans','Fira Mono'])expect(await page.evaluate(font=>document.fonts.check(`16px "${font}"`),font)).toBeTruthy();
    for(const name of ['Sources','Briefings','Agent Trace','Evidence'])await expect(page.getByRole('button',{name,exact:true})).toBeVisible();
    expect(await page.locator('h1').evaluate(el=>getComputedStyle(el).fontFamily)).toContain('Bodoni Moda');
    return {fontFaces:await page.evaluate(()=>[...document.fonts].map(f=>({family:f.family,status:f.status}))) };
  });
  await check('keyboard skip link and section focus are visible',async()=>{
    await page.keyboard.press('Tab');await expect(page.getByRole('link',{name:'Skip to evidence'})).toBeFocused();
    expect(await page.getByRole('link',{name:'Skip to evidence'}).evaluate(el=>getComputedStyle(el).outlineWidth)).toBe('3px');
    await page.keyboard.press('Enter');await expect(page.locator('#main')).toBeFocused();
    await page.locator('#tab-briefings').focus();await page.keyboard.press('Enter');await expect(page.locator('#main')).toBeFocused();
  });
  let session,receipt,receiptFields;
  await check('real HTTP prepare approve publish and identical receipt recovery',async()=>{
    const sessionResponse=page.waitForResponse(r=>r.request().method()==='POST'&&r.url().endsWith('/api/demo/sessions'));
    await page.getByRole('button',{name:'Prepare a synthetic briefing'}).click();session=await (await sessionResponse).json();
    await expect(page.locator('#briefing')).toBeVisible();await expect(page.locator('#publish')).toBeDisabled();
    await expect(page.locator('#briefing-digest')).toHaveText(/^[a-f0-9]{64}$/);
    await expect(page.locator('#before-fields')).toContainText('Exact tag');await expect(page.locator('#after-fields')).toContainText('Exact tag');
    await capture('briefing-review');
    await page.getByRole('button',{name:'Approve this revision'}).click();await expect(page.locator('#briefing-state')).toHaveText('Approved');
    await capture('briefing-approved');
    const publicationResponse=page.waitForResponse(r=>r.url().endsWith('/publish'));
    await page.getByRole('button',{name:'Publish internal briefing'}).click();const payload=await (await publicationResponse).json();receipt=payload.receipt||payload;
    await expect(page.locator('#receipt')).toBeVisible();receiptFields=await page.locator('#receipt-fields').innerText();
    await capture('briefing-published');
    await page.getByRole('button',{name:'Recover the same receipt'}).click();await expect(page.locator('#receipt-title')).toHaveText('Existing receipt recovered');
    expect(await page.locator('#receipt-fields').innerText()).toBe(receiptFields);await capture('briefing-recovered');
    return {receipt_id:receipt.receiptId,published_at:receipt.publishedAt,briefing_digest:receipt.briefingDigest,namespace:receipt.namespace};
  });
  await check('separate HTTP client sees exactly one committed receipt',async()=>{
    const response=await fetch(apiURL+'/api/demo/sessions/'+session.id,{headers:{Authorization:'Bearer '+session.capability}});expect(response.status).toBe(200);
    const persisted=await response.json();expect(persisted.receipts).toHaveLength(1);expect(persisted.receipts[0].receiptId).toBe(receipt.receiptId);
    return {receipt_count:persisted.receipts.length,receipt_id:persisted.receipts[0].receiptId};
  });
  for(const theme of ['light','dark'])await check(theme+' theme real rendered text contrast and four views',async()=>{
    if(await page.locator('html').getAttribute('data-theme')!==theme)await page.locator('#theme-toggle').click();
    const checks=[];
    for(const name of ['sources','briefings','trace','evidence']){await page.locator('#tab-'+name).click();const c=await contrast();expect(c.failures).toEqual([]);expect(c.checked).toBeGreaterThan(10);checks.push({view:name,checked:c.checked,worst:c.worst});await capture(theme+'-'+name);}
    return checks;
  });
  await check('narrow mobile layout keeps controls and aligned evidence readable',async()=>{
    await page.setViewportSize({width:390,height:844});await page.locator('#tab-briefings').click();
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBeTruthy();
    const before=await page.locator('.compare>section').first().boundingBox(),after=await page.locator('.compare>section').last().boundingBox();expect(after.y).toBeGreaterThan(before.y+before.height-2);
    await expect(page.locator('#recover')).toBeVisible();await capture('mobile-briefing');
    await page.locator('#tab-sources').click();expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBeTruthy();await capture('mobile-sources');
  });
  await check('reduced motion and screen reader labels',async()=>{
    expect(await page.evaluate(()=>matchMedia('(prefers-reduced-motion:reduce)').matches)).toBeTruthy();
    for(const id of ['global-status','demo-status'])await expect(page.locator('#'+id)).toHaveAttribute('aria-live','polite');
    await expect(page.locator('nav')).toHaveAttribute('aria-label','Watchtower sections');
    expect(await page.locator('.sources-table th[scope="col"]').count()).toBe(5);
  });
    if(app){
    await page.setViewportSize({width:1440,height:1000});
    await check('unknown and empty source states keep successful negative claims absent',async()=>{
      await page.locator('#tab-sources').click();await expect(page.locator('#sources-summary')).toContainText('Incomplete coverage remains unknown');
      expect(await page.locator('#source-rows tr').count()).toBe(4);await expect(page.locator('#source-rows')).not.toContainText('unchanged');
    });
    await check('loading and partial source response remain labeled',async()=>{
      let release;const gate=new Promise(r=>release=r);
      await page.route('**/api/sources',async route=>{await gate;await route.fulfill({json:{sources:[{label:'vercel/eve',sourceId:23,coverage:'partial',latestAttempt:{status:'partial',capturedAt:Date.now()},comparisonHead:{capturedAt:Date.now()-60000}}]}});});
      await page.locator('#refresh').click();await expect(page.locator('#global-status')).toHaveText('Reading source status...');await expect(page.locator('#refresh')).toBeDisabled();release();
      await expect(page.locator('#refresh')).toBeEnabled();await expect(page.locator('#source-rows')).toContainText('Partial');await expect(page.locator('#sources-summary')).toContainText('Incomplete coverage remains unknown');await page.unroute('**/api/sources');
      return {kind:'controlled_browser_response',scope:'UI loading and partial-state boundary'};
    });
    await check('failed API refresh offers retry and timestamps retained data',async()=>{
      await page.route('**/api/sources',route=>route.abort('failed'));await page.locator('#refresh').click();await expect(page.locator('#global-status')).toContainText('Retained data was read at');await expect(page.locator('#refresh')).toBeEnabled();await page.unroute('**/api/sources');
      return {kind:'controlled_network_failure'};
    });
    await check('stale approval names source and blocks publish until a fresh review',async()=>{
      await page.locator('#tab-briefings').click();
      const sessionResponse=page.waitForResponse(r=>r.request().method()==='POST'&&r.url().endsWith('/api/demo/sessions'));
      await page.locator('#new-demo').click();const stale=await (await sessionResponse).json();await expect(page.locator('#approve')).toBeEnabled();await page.locator('#approve').click();await expect(page.locator('#publish')).toBeEnabled();
      const lease=await app.store.acquireLease(stale.namespace,23,'browser-stale-review');
      await app.store.recordObservation({namespace:stale.namespace,sourceId:23,lease,expectedHead:lease.expectedHead,evidence:[],status:'captured',coverage:{complete:true,scope:'authored source changed after browser approval'},runId:'browser-stale-after-review'});
      const publicationResponse=page.waitForResponse(r=>r.url().endsWith('/publish'));
      await page.locator('#publish').click();const rejected=await publicationResponse;expect(rejected.status()).toBe(409);
      await expect(page.locator('#demo-status')).toContainText('authored/watchtower-demo');await expect(page.locator('#publish')).toBeDisabled();await expect(page.locator('#approve')).toBeDisabled();
      const persisted=await app.store.getDemoSession(stale.id,stale.capability);expect(persisted.receipts).toHaveLength(0);
      return {kind:'actual_backend_head_change',backend:app.store.backend,namespace:stale.namespace,publication_status:rejected.status(),receipt_count:persisted.receipts.length};
    });
    await check('real expired session is rejected and UI asks for a fresh session',async()=>{
      const sessionResponse=page.waitForResponse(r=>r.request().method()==='POST'&&r.url().endsWith('/api/demo/sessions'));
      await page.locator('#new-demo').click();const expiring=await (await sessionResponse).json();await expect(page.locator('#approve')).toBeEnabled();
      if(app.store.backend==='postgres')await app.store.db.query('UPDATE watchtower.demo_sessions SET expires_at=to_timestamp(0) WHERE namespace=$1 AND id=$2',[expiring.namespace,expiring.id]);
      else app.store.db.prepare('UPDATE sessions SET expires_at=0 WHERE id=?').run(expiring.id);
      await page.locator('#approve').click();await expect(page.locator('#session-state')).toContainText('expired');await expect(page.locator('#publish')).toBeDisabled();await expect(page.locator('#approve')).toBeDisabled();
    });
  }
  await check('no uncaught browser errors',()=>expect(errors).toEqual([]));
  report.status='passed';
}catch(error){report.status='failed';report.error=error.message;process.exitCode=1;}
finally{
  report.finished_at=new Date().toISOString();report.passed=rows.filter(x=>x.status==='passed').length;report.failed=rows.filter(x=>x.status==='failed').length;
  await writeFile(resolve(output,label+'.json'),JSON.stringify(report,null,2)+'\n');
  await browser?.close();if(staticServer)await new Promise(r=>staticServer.close(r));await app?.close();
  console.log(JSON.stringify({status:report.status,passed:report.passed,failed:report.failed,artifact:'reports/browser/'+label+'.json',error:report.error}));
}
