import {METHOD_LABELS, printable, timestamp, shortId, coverageLabel, metricValue, safeSourceUrl, normalizeSources, findingText, evidenceFields, modelCaseId, reportMetrics} from './view-model.mjs';
const $ = id => document.getElementById(id);
const state = {session:null,briefing:null,receipt:null,report:null,operationKey:null,lastRead:null,busy:false};
const apiBase = document.documentElement.dataset.apiBase ?? '';
function el(tag,text,className) { const node=document.createElement(tag); if(text!==undefined)node.textContent=text; if(className)node.className=className; return node; }
function status(id,message,type='') { const node=$(id); node.textContent=message; node.className='status-line '+type; }
function toggleBusy(busy) {state.busy=busy; for(const id of ['start-demo','new-demo','approve','publish','recover']) $(id).disabled=busy || (id==='publish' && !state.briefing?.approved) || (id==='approve' && (!state.briefing || state.briefing.approved || state.receipt));}
async function api(path,body) {
  const controller=new AbortController(); const timeout=setTimeout(()=>controller.abort(),12000);
  try {
    const headers={Accept:'application/json'};
    if(body!==undefined)headers['Content-Type']='application/json';
    if(path.startsWith('/api/demo/sessions/') && state.session)headers.Authorization='Bearer '+state.session.capability;
    const response=await fetch(apiBase+path,{method:body===undefined?'GET':'POST',headers,body:body===undefined?undefined:JSON.stringify(body),signal:controller.signal,cache:'no-store'});
    let data;try{data=await response.json()}catch{throw new Error('The API returned an unreadable response.');}
    if(!response.ok) {const err=new Error(data.error?.message ?? data.message ?? data.error?.code ?? 'Request failed');err.code=data.error?.code ?? data.error;throw err;}
    return data;
  } finally {clearTimeout(timeout);}
}
function route(name,focus=false) {
  if(!['sources','briefings','trace','evidence'].includes(name))name='sources';
  for(const tab of document.querySelectorAll('[data-view]')) {const selected=tab.dataset.view===name; if(selected)tab.setAttribute('aria-current','page');else tab.removeAttribute('aria-current');}
  for(const view of document.querySelectorAll('.view'))view.hidden=view.id!=='view-'+name;
  if(focus)$('main').focus({preventScroll:true});
}
for(const button of document.querySelectorAll('[data-view]'))button.addEventListener('click',()=>{history.replaceState(null,'','#'+button.dataset.view);route(button.dataset.view,true);});
window.addEventListener('hashchange',()=>route(location.hash.slice(1)));
$('theme-toggle').addEventListener('click',()=>{const dark=document.documentElement.dataset.theme!=='dark';document.documentElement.dataset.theme=dark?'dark':'light';$('theme-toggle').textContent=dark?'Use light theme':'Use dark theme';$('theme-toggle').setAttribute('aria-pressed',String(dark));});
function renderSources(data) {
  const rows=normalizeSources(data); const tbody=$('source-rows');tbody.replaceChildren();
  for(const row of rows) {
    const tr=el('tr'); const th=el('th');th.scope='row';
    const link=safeSourceUrl(row.url ?? 'https://github.com/'+row.label+'/releases');
    if(link){const a=el('a',row.label);a.href=link;a.target='_blank';a.rel='noopener noreferrer';th.append(a);}else th.append(el('span',row.label));
    th.append(el('span',row.sourceId ? 'Repository ID '+row.sourceId : 'Numeric identity not verified','source-id'));tr.append(th);
    const coverage=el('td');const badge=el('span',coverageLabel(row.coverage),'badge'+(['captured','complete'].includes(row.coverage)?' good':row.coverage==='unavailable'?' bad':''));coverage.append(badge);tr.append(coverage);
    const attempt=row.lastAttempt;
    const usable=row.lastUsableEvidence;
    for(const value of [attempt,usable]) {const td=el('td');td.append(el('span',timestamp(typeof value==='object'?value?.at:value),'mono'));tr.append(td);}
    const outcome=el('td',row.outcome ?? row.comparisonOutcome ?? 'Insufficient evidence');tr.append(outcome);tbody.append(tr);
  }
  const complete=rows.every(r=>['captured','complete'].includes(r.coverage));
  $('sources-summary').replaceChildren(el('span',complete?'+':'?','state-icon'));
  const content=el('div');content.append(el('strong',complete?'The declared source procedures completed.':'Incomplete coverage remains unknown.'),el('p',complete?'Captured scope is bounded. Complete release history is not implied.':'No successful no-change claim can be made for an unobserved scope.'));$('sources-summary').append(content);
}
async function refresh() {
  $('refresh').disabled=true;status('global-status','Reading source status...');
  const responses=await Promise.allSettled([api('/health'),api('/api/sources'),api('/api/reports/current')]);
  if(responses[0].status==='fulfilled'){const health=responses[0].value;$('readiness').textContent=(health.ready ?? health.readiness ?? health.status==='ok')?'API connected / local candidate':'API responding / persistence not ready';}
  else $('readiness').textContent='API unavailable';
  if(responses[1].status==='fulfilled'){renderSources(responses[1].value);state.lastRead=new Date().toISOString();$('source-read-time').textContent='Last successful status read: '+state.lastRead;}
  if(responses[2].status==='fulfilled')renderReport(responses[2].value);
  const failed=responses.filter(r=>r.status==='rejected');
  status('global-status',failed.length ? 'Some evidence could not be read. Use Refresh source status to retry.'+(state.lastRead?' Retained data was read at '+state.lastRead+'.':' No observed source state is available.'):'Source status and evidence reports refreshed.',failed.length?'error':'');
  $('refresh').disabled=false;
}
$('refresh').addEventListener('click',refresh);
function metricsTable(record,caption) {
  const table=el('table',undefined,'metrics');table.append(el('caption',caption));const body=el('tbody');
  const candidates=reportMetrics(record);
  if(candidates?.length)for(const metric of candidates){const tr=el('tr');const th=el('th',metric.label ?? metric.id ?? 'Metric');th.scope='row';tr.append(th,el('td',metricValue(metric)));body.append(tr);}
  else {
    for(const [key,value] of Object.entries(record ?? {})) {
      if(!['attempted','planned','executed','total','passed','failed','unexecuted','supported','supportedProposals','expectedFindings','emittedFindings','matchedFindings','precision','recall','status','state','method'].includes(key))continue;
      const tr=el('tr');const th=el('th',key.replace(/([A-Z])/g,' $1'));th.scope='row';tr.append(th,el('td',typeof value==='object'?metricValue(value):printable(value)));body.append(tr);
    }
  }
  if(!body.children.length) {const tr=el('tr');const td=el('td','Measured summary unavailable. Inspect the source manifest for execution state.');td.colSpan=2;tr.append(td);body.append(tr);}
  table.append(body);return table;
}
function renderReport(report) {
  state.report=report;$('report-json').textContent=JSON.stringify(report,null,2);$('download-report').disabled=false;
  const baseline=report.baseline ?? report.methods?.deterministic_baseline ?? report.deterministic_baseline;
  const baselineSubset=report.baseline_subset;
  const model=report.model ?? report.methods?.local_agent ?? report.local_agent;
  $('baseline-results').replaceChildren(metricsTable(baseline,'Full deterministic held-out set; see manifest for dataset and denominator.'));
  $('baseline-subset-results').replaceChildren(metricsTable(baselineSubset,'Deterministic results on the same registered cases as the local-model subset.'));
  $('agent-results').replaceChildren(metricsTable(model,'Registered local-model subset. Missing inference is not a baseline result.'));
  $('model-json').textContent=model?JSON.stringify(model,null,2):'Actual model report unavailable.';
  $('report-summary').replaceChildren();
  if(report.planDigest ?? report.plan_digest){const line=el('p','Evaluation plan: ','micro');line.append(el('code',report.planDigest ?? report.plan_digest));$('report-summary').append(line);}
  if(report.generatedAt ?? report.generated_at)$('report-summary').append(el('p','Report generated: '+timestamp(report.generatedAt ?? report.generated_at),'micro'));
  const modelAttempted=model?.attempted ?? model?.actualAttempts ?? model?.attemptedCount ?? model?.summary?.attempted ?? 0;
  const message=el('div');message.append(el('strong',modelAttempted>0?'Actual model outcomes are recorded separately.':'Actual model execution is unavailable.'),el('p',modelAttempted>0?'Inspect attempted, failed and supported outcomes in the model report.':'Baseline outputs are excluded from this method. Unexecuted cases remain visible.'));
  $('model-state').replaceChildren(el('span',modelAttempted>0?'!':'?','state-icon'),message);
  $('model-results').replaceChildren();
  const rows=model?.rows ?? model?.cases;
  if(Array.isArray(rows) && rows.length) {
    const table=el('table',undefined,'metrics');table.append(el('caption','Every declared model case, including unexecuted rows.'));const head=el('thead');const hr=el('tr');for(const t of ['Sequence','Outcome','Method']){const th=el('th',t);th.scope='col';hr.append(th);}head.append(hr);table.append(head);const body=el('tbody');
    for(const row of rows){const tr=el('tr');const th=el('th',modelCaseId(row));th.scope='row';tr.append(th,el('td',row.outcome ?? row.status ?? 'Unavailable'),el('td',row.method ?? 'local_agent'));body.append(tr);}table.append(body);$('model-results').append(table);
  }
}
$('download-report').addEventListener('click',()=>{if(!state.report)return;const blob=new Blob([JSON.stringify(state.report,null,2)],{type:'application/json'});const url=URL.createObjectURL(blob);const a=el('a');a.href=url;a.download='watchtower-current-report.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);});
function renderFields(id,fields,other) {
  const container=$(id);container.replaceChildren();
  for(const [label,value] of fields){container.append(el('dt',label));const dd=el('dd',value);if(other && other.find(([key])=>key===label)?.[1]!==value)dd.className='changed';container.append(dd);}
}
function renderBriefing(briefing) {
  state.briefing={...briefing,approved:briefing.approved ?? briefing.state==='approved'};
  $('briefing').hidden=false;$('briefing-state').textContent=briefing.state ?? 'Prepared';
  $('briefing-digest').textContent=briefing.digest;
  $('coverage-warning').textContent=briefing.coverage?.warning ?? (briefing.coverage?.complete?'Captured synthetic scope only. No live-source conclusion.':'Coverage is partial or unknown. This limitation is part of the reviewed revision.');
  $('briefing-json').textContent=JSON.stringify(briefing,null,2);
  $('findings').replaceChildren();
  for(const finding of briefing.findings ?? []){const line=el('p',findingText(finding),'finding');line.append(el('code',finding.kind ?? finding.findingKind));$('findings').append(line);}
  const first=briefing.findings?.[0];
  const before=briefing.before ?? (first ? {evidenceId:first.beforeEvidenceId,tag:first.before} : null);
  const after=briefing.after ?? (first ? {evidenceId:first.afterEvidenceId,tag:first.after} : null);
  $('before-id').textContent=shortId(before?.id ?? before?.evidenceId);$('after-id').textContent=shortId(after?.id ?? after?.evidenceId);
  const bf=evidenceFields(before),af=evidenceFields(after);renderFields('before-fields',bf,af);renderFields('after-fields',af,bf);
  $('receipt').hidden=!state.receipt;toggleBusy(false);
}
async function startDemo() {
  toggleBusy(true);status('demo-status','Creating an isolated synthetic session...');
  try {
    if(!state.session){state.session=await api('/api/demo/sessions',{});state.operationKey='publication-'+crypto.randomUUID();state.receipt=null;}
    $('session-state').textContent='Synthetic session '+shortId(state.session.id)+' / expires '+timestamp(state.session.expiresAt);
    const response=await api('/api/demo/sessions/'+encodeURIComponent(state.session.id)+'/prepare',{});
    renderBriefing(response.briefing ?? response);
    $('start-demo').hidden=true;$('new-demo').hidden=false;$('recover').hidden=true;$('receipt').hidden=true;
    status('demo-status','Briefing prepared. Inspect the evidence and revision digest before approval.');
  } catch(error){handleDemoError(error);} finally {toggleBusy(false);}
}
$('start-demo').addEventListener('click',startDemo);
$('new-demo').addEventListener('click',()=>{state.session=null;state.briefing=null;state.receipt=null;$('briefing').hidden=true;startDemo();});
function handleDemoError(error) {
  const code=String(error.code ?? '');
  if(/review_required|stale/i.test(code)){if(state.briefing)state.briefing.approved=false;$('briefing-state').textContent='Review required';}
  if(/expired|capability|session/i.test(code)) {if(state.briefing)state.briefing.approved=false;$('session-state').textContent='Session unavailable or expired. Start a new session.';}
  status('demo-status',error.name==='AbortError'?'The request timed out. Publication may have committed; use receipt recovery after reconnecting.':error.message,'error');
}
$('approve').addEventListener('click',async()=>{toggleBusy(true);try{await api('/api/demo/sessions/'+encodeURIComponent(state.session.id)+'/approve',{digest:state.briefing.digest});state.briefing.approved=true;$('briefing-state').textContent='Approved';status('demo-status','This exact synthetic revision is approved. Publication remains a separate action.');}catch(error){handleDemoError(error)}finally{toggleBusy(false)}});
async function publish() {
  toggleBusy(true);status('demo-status','Checking the approved revision and internal publication key...');
  try {
    const response=await api('/api/demo/sessions/'+encodeURIComponent(state.session.id)+'/publish',{digest:state.briefing.digest,operationKey:state.operationKey});
    const receipt=response.receipt ?? response;state.receipt=receipt;
    $('receipt').hidden=false;$('receipt-title').textContent=response.recovered ?? receipt.recovered?'Existing receipt recovered':'One internal briefing committed';
    $('briefing-state').textContent='Published';
    renderFields('receipt-fields',[['Receipt',printable(receipt.receiptId ?? receipt.id)],['Committed at',timestamp(receipt.publishedAt ?? receipt.createdAt)],['Briefing digest',printable(receipt.briefingDigest)],['Method',METHOD_LABELS[receipt.method] ?? 'Deterministic baseline']]);
    $('recover').hidden=false;status('demo-status',response.recovered ?? receipt.recovered?'The existing receipt was returned. No second publication was created.':'Publication committed. Recover the same receipt to exercise an identical retry.','success');
  } catch(error){$('recover').hidden=false;handleDemoError(error);}finally{toggleBusy(false);}
}
$('publish').addEventListener('click',publish);$('recover').addEventListener('click',publish);
$('copy-digest').addEventListener('click',async()=>{try{await navigator.clipboard.writeText(state.briefing.digest);status('demo-status','Revision digest copied.');}catch{status('demo-status','Copy unavailable. The full digest remains selectable above.');}});
route(location.hash.slice(1));renderSources({sources:[]});refresh();

