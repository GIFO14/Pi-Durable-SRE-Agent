import { createStepView } from './step-view.js';
import './demo-controls.js';
const $ = id => document.getElementById(id);
let state = null, busy = false, connected = false, renderingKey = '', evidenceKey = '';
const labels = { DETECTED:'Detected', TRIAGING:'Triaging', INVESTIGATING:'Investigating', REPRODUCING:'Reproducing', FIXING:'Fixing', VERIFYING:'Verifying', AWAITING_DEPLOY_APPROVAL:'Awaiting deploy approval', PREPARING_DEPLOYMENT:'Preparing deployment', CANARY_DEPLOYED:'Canary deployed', OBSERVING:'Observing', AWAITING_PROMOTION_APPROVAL:'Awaiting promotion approval', ROLLING_BACK:'Rolling back', PROMOTING:'Promoting', FINAL_VERIFY:'Final verification', RESOLVED:'Resolved', FAILED:'Failed' };
const node = (tag, text, cls) => { const el = document.createElement(tag); if (text !== undefined) el.textContent = text; if (cls) el.className = cls; return el; };
const icon = name => { const el = node('i', undefined, 'icon'); el.setAttribute('aria-hidden','true'); el.style.setProperty('--icon', `url('/icons/${name}.svg')`); return el; };
document.querySelectorAll('[data-icon]').forEach(el => { el.style.setProperty('--icon', `url('/icons/${el.dataset.icon}.svg')`); el.setAttribute('aria-hidden','true'); });
const time = value => value ? new Date(value).toLocaleTimeString([], {hour:'2-digit',minute:'2-digit',second:'2-digit'}) : '—';
const stepView=createStepView({ $,node,icon,labels,time,getState:()=>state,isBusy:()=>busy,isConnected:()=>connected,post });

function files(id, values) { $(id).replaceChildren(...(values.length ? values : ['—']).map(f => node('li', f))); }
function render(snapshot) {
  state = snapshot;
  const d = snapshot.incident;
  $('inject').disabled = busy || !snapshot.configuration.ready;
  $('inject-label').textContent = d ? 'Resume incident' : 'Inject incident';
  $('incident-count').textContent=d?'1':'0';
  $('session-status').textContent=snapshot.configuration.executionMode==='scripted-test'?'Scripted test':snapshot.configuration.ready?'ChatGPT connected':'Not connected';
  if (!snapshot.configuration.ready) { $('notice').hidden = false; $('notice').textContent = 'Sign in with ChatGPT using npm run auth:login, then restart the server. An active Codex ChatGPT session is also supported.'; }
  else if (snapshot.diagnostics.length) { $('notice').hidden = false; $('notice').textContent = snapshot.diagnostics.at(-1); }
  else $('notice').hidden = true;
  const key = JSON.stringify([d?.updatedAt, d?.status, d?.gate, snapshot.configuration.executionMode]);
  if (renderingKey === key) { renderApprovals(d); $('approve-selected').disabled=busy||!connected; return; } renderingKey = key;
  stepView.renderWorkflow(snapshot,d);
  stepView.renderInspector(d);
  if (!d) return;
  $('incident-id').textContent=d.incidentId; $('severity').hidden=false; $('severity').textContent=d.severity.toUpperCase();
  $('service').textContent=`${d.service} · ${d.usersAffected} affected users`; $('error').textContent=d.error;
  $('current-state').textContent=labels[d.status]; $('time-info').textContent=`Started ${time(d.startedAt)} · updated ${time(d.updatedAt)}`;
  $('cycle').textContent=`CYCLE ${d.deploymentCycle} / 2`;
  $('hypothesis').textContent=d.rootCauseHypothesis || d.initialHypothesis || 'Waiting for investigation.';
  $('hypothesis').classList.toggle('placeholder',!d.rootCauseHypothesis && !d.initialHypothesis);
  $('root-cause').textContent=d.rootCause || 'Waiting for repository evidence.'; $('root-cause').classList.toggle('placeholder',!d.rootCause);
  files('relevant-files',d.relevantFiles); files('changed-files',d.changedFiles);
  for(const [id,value] of [['test-red',d.verification.beforeFix],['test-green',d.verification.afterFix],['test-component',d.verification.relevantTests]]) {
    $(id).textContent=value; $(id).className=`result ${value==='PASS'?'pass':value==='FAIL'||value==='INVALID'?'fail':''}`;
  }
  $('attempts').textContent=`${d.fixAttempts} / 3 attempts`;
  $('regression').textContent=d.evidence.length?d.regressionTest:'No regression test yet'; $('fix-summary').textContent=d.fixSummary||'—';
  $('agent-mode').textContent=d.executionMode==='real'?'REAL AGENT':'SCRIPTED TEST — NO AI';
  const ek=d.evidence.map(e=>e.id).join(',');
  if(ek!==evidenceKey){ evidenceKey=ek; $('executions').replaceChildren(...d.evidence.map(e=>{
    const block=node('div',undefined,'command'); block.append(node('strong',`${e.kind.toUpperCase()} · ${e.result} · exit ${e.exitCode??'interrupted'}`),node('p',e.command),node('pre',e.output)); return block;
  })); }
  $('evidence-count').textContent=`${d.evidence.length} commands`;
  $('evidence-total').textContent=String(d.evidence.length);
  const p=d.deployment;
  for(const [id,v]of [['production-version',p.currentProductionVersion],['candidate-version',p.candidateVersion],['rollback-version',p.rollbackVersion]]) $(id).textContent=v;
  const traffic=Object.entries(p.versions);
  $('traffic-bar').replaceChildren(...traffic.filter(([,pct])=>pct>0).map(([v,pct])=>{const s=node('div',undefined,`traffic-segment ${v===p.candidateVersion?'candidate':''}`);s.style.width=`${pct}%`;return s;}));
  $('traffic-bar').setAttribute('aria-label',traffic.map(([v,pct])=>`${v}: ${pct}%`).join(', '));
  $('traffic-legend').replaceChildren(...traffic.map(([v,pct])=>node('span',`${v} ${pct}%`,v===p.candidateVersion?'candidate':'')));
  $('error-rate').textContent=`${(p.errorRate*100).toFixed(1)}%`; $('latency').textContent=`${p.latencyP95}ms`;
  $('health').textContent=p.healthy?'Healthy':'Unhealthy'; $('health').className=`health ${p.healthy?'good':'bad'}`;
  $('traffic-total').textContent=p.canaryPercentage===100?'100% production':p.canaryPercentage?`${p.canaryPercentage}% canary`:'Baseline';
  $('stage').textContent=labels[p.stage]||p.stage;
  $('events').replaceChildren(...d.events.slice(-14).map(e=>{const li=node('li');const t=node('time',time(e.at));t.dateTime=e.at;li.append(t,node('span',e.message));return li;}));
  $('events').scrollTop=$('events').scrollHeight;
  $('task-id').textContent=`TASK ${d.workflowTaskId} · ${d.rollbackCount} / 1 rollbacks`;
  $('failure').hidden=!d.failure; $('failure').textContent=d.failure;
  $('report').hidden=!['RESOLVED','FAILED'].includes(d.status);
  renderApprovals(d);
}
function renderApprovals(d){
  const deploy=d?.status==='AWAITING_DEPLOY_APPROVAL', promote=d?.status==='AWAITING_PROMOTION_APPROVAL';
  $('deploy').hidden=!deploy; $('promote').hidden=!promote;
  $('deploy').disabled=busy||!connected||!!d?.gate?.approvedAt; $('promote').disabled=busy||!connected||!!d?.gate?.approvedAt;
  $('approval-title').textContent=deploy?'Ready for a 10% canary.':promote?'Canary healthy. Promote?':d?.status==='RESOLVED'?'Incident resolved.':d?.status==='FAILED'?'Workflow stopped.':'You control the rollout.';
  $('approval-copy').textContent=deploy?'The regression and component tests passed. Approve this candidate to send 10% of simulated traffic to it.':promote?'The observed canary is healthy. Your approval moves this candidate to 100% of simulated traffic.':'The agent investigates and verifies. Canary deployment and full promotion each wait for your approval.';
  $('approval-status').textContent=busy?'Sending request…':d?.gate?.approvedAt&&!d.gate.consumedAt?'Approval saved. Waiting for backend transition.':deploy||promote?`Awaiting your approval for ${d.gate.version}.`:'No approval requested.';
}
async function post(path,body){
  busy=true; renderApprovals(state?.incident); stepView.renderInspector(state?.incident); $('inject').disabled=true;
  try { const response=await fetch(path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});const result=await response.json();if(!response.ok)throw new Error(result.error||'Request failed'); }
  catch(e){$('notice').hidden=false;$('notice').textContent=e.message;}
  finally{busy=false;renderApprovals(state?.incident);stepView.renderInspector(state?.incident);$('inject').disabled=!connected||!state?.configuration.ready;}
}
$('inject').addEventListener('click',()=>post('/api/incident',{}));
for(const action of ['deploy','promote']) $(action).addEventListener('click',()=>{
  const d=state?.incident;if(!d?.gate)return;post('/api/approval',{incidentId:d.incidentId,gateId:d.gate.id,action});
});
async function poll(){
  try{
    const response=await fetch('/api/state',{cache:'no-store',signal:AbortSignal.timeout(5000)});
    if(!response.ok)throw new Error('Backend unavailable');
    const snapshot=await response.json();connected=true;render(snapshot); $('connection').textContent='Backend connected';$('connection').className='connection online';
  }catch{
    connected=false;$('connection').textContent='Disconnected · state retained';$('connection').className='connection offline';
    $('inject').disabled=true;$('deploy').disabled=true;$('promote').disabled=true;$('approve-selected').disabled=true;
  }finally{setTimeout(poll,1000);}
}
poll();

function showView(view,focus=false){
  for(const name of ['workflow','evidence','activity','production']){
    const selected=name===view;
    $(`view-${name}`).hidden=!selected;
    $(`tab-${name}`).classList.toggle('active',selected);
    $(`tab-${name}`).setAttribute('aria-selected',String(selected));
    $(`tab-${name}`).tabIndex=selected?0:-1;
  }
  document.querySelectorAll('.nav-item[data-view]').forEach(el=>el.classList.toggle('selected',el.dataset.view===view));
  if(focus)$(`tab-${view}`).focus();
  if(window.innerWidth<=850)document.body.classList.remove('sidebar-collapsed');
}
document.querySelectorAll('[data-view]').forEach(el=>el.addEventListener('click',()=>showView(el.dataset.view)));
document.querySelectorAll('.view-tab').forEach((tab,index)=>tab.addEventListener('keydown',event=>{
  const names=['workflow','evidence','activity','production']; let next;
  if(event.key==='ArrowRight')next=(index+1)%4;
  if(event.key==='ArrowLeft')next=(index+3)%4;
  if(event.key==='Home')next=0;
  if(event.key==='End')next=3;
  if(next!==undefined){event.preventDefault();showView(names[next],true);}
}));
document.querySelector('[data-focus="production"]').addEventListener('click',()=>{
  if(window.innerWidth<=850)document.body.classList.remove('sidebar-collapsed');
  showView('production');
  $('production').scrollIntoView({block:'center',behavior:'smooth'});$('production').focus({preventScroll:true});
});
$('sidebar-toggle').addEventListener('click',()=>document.body.classList.toggle('sidebar-collapsed'));
function setTheme(theme){
  document.documentElement.dataset.theme=theme;
  $('theme-toggle').replaceChildren(icon(theme==='dark'?'sun':'moon'));
  $('theme-toggle').setAttribute('aria-label',`Switch to ${theme==='dark'?'light':'dark'} theme`);
  try{localStorage.setItem('sre-theme',theme);}catch{}
}
try{setTheme(localStorage.getItem('sre-theme')==='dark'?'dark':'light');}catch{setTheme('light');}
$('theme-toggle').addEventListener('click',()=>setTheme(document.documentElement.dataset.theme==='dark'?'light':'dark'));
showView('workflow');
