import { stepGroups, stepDescriptions, getStepRuns, selectedRun, stepEvidence } from './step-data.js';
export function createStepView({ $, node, icon, labels, getState, isBusy, isConnected, post, time }) {
  let followCurrent=true, selectedStep=null, selectedRunId=null, lastCurrentStep=null;
  const chosenStep=d=>followCurrent ? d?.status ?? 'DETECTED' : selectedStep ?? 'DETECTED';
  const terminalState=status=>['RESOLVED','FAILED'].includes(status);
  function appearance(d,status,run) {
    if(!d||!run)return {label:d?'Not reached':'Not started',cls:'',icon:'circle'};
    if(status==='FAILED'||run.nextStatus==='FAILED')return {label:'Stopped',cls:'failed',icon:'triangle-alert'};
    if(run.current&&status!=='RESOLVED')return {label:status.startsWith('AWAITING_')?'Needs approval':'In progress',cls:'current',icon:'circle-dot'};
    return {label:'Completed',cls:'done',icon:'circle-check'};
  }
  function selectStep(status,runId=null) {
    const state=getState();followCurrent=false;selectedStep=status;
    selectedRunId=runId??selectedRun(state?.incident,status,null).run?.id??null;
    renderWorkflow(state,state?.incident);renderInspector(state?.incident);
    if(window.innerWidth<=700)document.querySelector('.step-inspector').scrollIntoView({block:'start',behavior:'smooth'});
  }
  function renderWorkflow(snapshot,d) {
    const selected=chosenStep(d),allRuns=getStepRuns(d),focusStatus=document.activeElement?.dataset.step;
    const completed=new Set(allRuns.filter(r=>r===allRuns.findLast(latest=>latest.status===r.status)
      &&((r.endedAt&&r.nextStatus!=='FAILED')||r.status==='RESOLVED')).map(r=>r.status));
    $('journey-title').textContent=d?d.incidentId+' · Incident journey':'One incident, every step.';
    $('follow-current').classList.toggle('following',followCurrent);
    $('follow-current').lastElementChild.textContent=followCurrent?'Following current step':'Follow current step';
    $('stage-overview').replaceChildren(...stepGroups.map(group=>{
      const visible=group.states.filter(s=>!['ROLLING_BACK','FAILED'].includes(s)||allRuns.some(r=>r.status===s));
      const count=visible.filter(s=>completed.has(s)).length,current=group.states.includes(d?.status);
      const button=node('button',undefined,'stage-summary '+(current?'current ':'')+(count===visible.length?'complete':''));button.type='button';
      const symbol=node('span',undefined,'stage-symbol');symbol.append(icon(count===visible.length?'check':group.icon));
      const label=node('span');label.append(node('strong',group.name),node('small',count+' / '+visible.length+' steps'));
      button.append(symbol,label);button.addEventListener('click',()=>{
        const target=current?d.status:visible[0];selectStep(target);
        const row=$('workflow').querySelector('[data-step="'+target+'"]');if(row)$('workflow').scrollTop+=row.getBoundingClientRect().top-$('workflow').getBoundingClientRect().top-50;
      });return button;
    }));
    let number=0;
    const oldScroll=$('workflow').scrollTop;
    $('workflow').replaceChildren(...stepGroups.map(group=>{
      const section=node('section',undefined,'timeline-group');
      const title=node('h3',undefined,'timeline-group-title');title.append(icon(group.icon),node('span',group.name));
      const list=node('ol',undefined,'timeline-list');
      list.append(...group.states.filter(s=>!['ROLLING_BACK','FAILED'].includes(s)||allRuns.some(r=>r.status===s)).map(status=>{
        number++;const run=selectedRun(d,status,null).run,a=appearance(d,status,run);
        const li=node('li'),button=node('button',undefined,'step-row '+a.cls+(selected===status?' selected':''));
        button.type='button';button.dataset.step=status;button.setAttribute('aria-pressed',String(selected===status));
        if(d?.status===status)button.setAttribute('aria-current','step');
        const marker=node('span',undefined,'step-marker');marker.append(a.cls==='done'||a.cls==='failed'?icon(a.icon):node('span',String(number).padStart(2,'0')));
        const text=node('span',undefined,'step-row-main');text.append(node('span',labels[status],'step-row-name'),node('span',stepDescriptions[status],'step-row-note'));
        const badge=node('span',undefined,'step-row-state');badge.append(icon(a.icon),node('span',a.label));
        button.append(marker,text,badge,icon('chevron-right'));button.addEventListener('click',()=>selectStep(status));li.append(button);return li;
      }));section.append(title,list);return section;
    }));
    $('workflow').scrollTop=oldScroll;
    $('workflow-progress').textContent=d?completed.size+' steps completed':'Waiting to begin';
    if(focusStatus)$('workflow').querySelector('[data-step="'+focusStatus+'"]')?.focus({preventScroll:true});
    if(followCurrent&&d?.status!==lastCurrentStep){
      const row=$('workflow').querySelector('[aria-current="step"]');
      if(row)$('workflow').scrollTop+=row.getBoundingClientRect().top-$('workflow').getBoundingClientRect().top-100;
    }
    lastCurrentStep=d?.status;
  }
  function renderInspector(d) {
    const status=chosenStep(d),{runs,run}=selectedRun(d,status,followCurrent?null:selectedRunId);
    const a=appearance(d,status,run),saved=run?.saved,content=$('step-detail-content');
    $('step-title').textContent=labels[status];$('step-description').textContent=stepDescriptions[status];
    $('inspector-mode').textContent=followCurrent?'Following live':'Inspecting step';
    $('step-status').className='inspector-status '+a.cls;
    $('step-status').replaceChildren(icon(a.icon),node('span',a.label));
    $('step-run-field').hidden=runs.length<2;
    const optionsKey=runs.map(r=>r.id+':'+r.attempt).join('|');
    if($('step-run').dataset.key!==optionsKey){
      $('step-run').replaceChildren(...runs.map((r,i)=>{const option=node('option','Visit '+(i+1)+' · cycle '+r.cycle+(r.attempt&&['FIXING','VERIFYING'].includes(status)?' · attempt '+r.attempt:''));option.value=r.id;return option;}));$('step-run').dataset.key=optionsKey;
    }
    if(run)$('step-run').value=run.id;
    const openCommands=new Set([...content.querySelectorAll('details[open][data-proof]')].map(el=>el.dataset.proof));
    content.replaceChildren();
    const section=title=>{const el=node('section',undefined,'step-section');el.append(node('h3',title));content.append(el);return el;};
    const paragraph=(title,text)=>{if(text)section(title).append(node('p',text));};
    const facts=(title,values)=>{
      const pairs=values.filter(([,v])=>v!==undefined&&v!==null&&v!=='');if(!pairs.length)return;
      const list=node('dl',undefined,'step-facts');
      for(const [key,value]of pairs){const row=node('div');row.append(node('dt',key),node('dd',String(value)));list.append(row);}section(title).append(list);
    };
    const fileList=(title,values)=>{if(!values?.length)return;const list=node('ul',undefined,'step-detail-files');list.append(...values.map(f=>node('li',f)));section(title).append(list);};
    if(!run){
      content.append(node('div',d?'This step has not run yet. Its findings and evidence will appear here when it executes.':'Inject an incident to begin. Select any step to explore its role in the workflow.','step-empty'));
    }else{
      facts('Execution',[['Cycle',run.cycle],['Fix attempt',['FIXING','VERIFYING'].includes(status)?run.attempt||'—':''],['Started',time(run.startedAt)],['Finished',run.endedAt?time(run.endedAt):terminalState(status)?time(d.updatedAt):'Still active']]);
      if(status==='DETECTED'){
        facts('Alert',[['Incident',d.incidentId],['Service',d.service],['Route',d.route],['Users affected',d.usersAffected]]);
        paragraph('Reported error',d.error);paragraph('Stack trace',d.stack);
      }
      if(status==='TRIAGING'){
        facts('Assessment',[['Severity',saved?.severity??d.severity],['Suspected area',saved?.suspectedArea]]);
        paragraph('Initial hypothesis',saved?.initialHypothesis??(run.cycle===1?d.initialHypothesis:''));
      }
      if(status==='INVESTIGATING'){
        paragraph('Root-cause hypothesis',saved?.rootCauseHypothesis);paragraph('Root cause',saved?.rootCause);fileList('Relevant files',saved?.relevantFiles);
      }
      if(status==='REPRODUCING')paragraph('Regression test',d.regressionTest);
      if(status==='FIXING'){paragraph('Fix summary',saved?.fixSummary);paragraph('Root cause',saved?.rootCause);fileList('Changed files',saved?.changedFiles);}
      if(['AWAITING_DEPLOY_APPROVAL','AWAITING_PROMOTION_APPROVAL'].includes(status)){
        const receipt=d.approvals.find(a=>a.id===d.incidentId+':'+run.cycle+':'+status);
        facts('Approval',[['Candidate',saved?.gate?.version??receipt?.version],['Decision',receipt?.approvedAt?'Approved':run.current?'Awaiting approval':'Not recorded'],['Approved at',receipt?.approvedAt?time(receipt.approvedAt):'']]);
      }
      if(['PREPARING_DEPLOYMENT','CANARY_DEPLOYED','OBSERVING','ROLLING_BACK','PROMOTING','FINAL_VERIFY','RESOLVED'].includes(status)&&saved?.deployment){
        const p=saved.deployment;
        facts(run.current?'Production at this step':'Production snapshot',[['Version',p.currentProductionVersion],['Candidate',p.candidateVersion],['Rollback point',p.rollbackVersion],['Traffic',Object.entries(p.versions).map(([v,pct])=>v+' '+pct+'%').join(' · ')],['Error rate',(p.errorRate*100).toFixed(1)+'%'],['p95 latency',p.latencyP95+'ms'],['Health',p.healthy?'Healthy':'Unhealthy']]);
      }
      if(status==='RESOLVED'){paragraph('Outcome','Final production verification passed. The incident is resolved.');paragraph('Verified fix',saved?.fixSummary);}
      if(status==='FAILED')paragraph('Failure',saved?.failure??d.failure);
      const evidence=stepEvidence(d,run);
      if(evidence.length){
        const target=section('Test evidence');
        for(const e of evidence){
          const details=node('details',undefined,'step-command');details.dataset.proof=e.id;details.open=openCommands.has(e.id);
          const summary=node('summary');summary.append(node('span',(e.kind==='red'?'Before fix':e.kind==='regression'?'Regression':'Component')+' · '+e.result),node('span','exit '+(e.exitCode??'interrupted')));
          details.append(summary,node('code',e.command),node('pre',e.output));target.append(details);
        }
      }
      if(!saved&&['INVESTIGATING','FIXING','PREPARING_DEPLOYMENT','CANARY_DEPLOYED','OBSERVING','ROLLING_BACK','PROMOTING','FINAL_VERIFY','RESOLVED'].includes(status))paragraph('Saved detail','Detailed findings were not saved for this earlier visit. The event history below is the record available for this step.');
      const events=node('ol',undefined,'step-event-list');
      for(const e of run.events){const li=node('li'),stamp=node('time',time(e.at));stamp.dateTime=e.at;li.append(stamp,node('span',e.message));events.append(li);}section('Step events').append(events);
    }
    const canApprove=run?.current&&d?.status===status&&status.startsWith('AWAITING_')&&d.gate&&!d.gate.approvedAt;
    $('approve-selected').hidden=!canApprove;$('approve-selected').disabled=isBusy()||!isConnected();
    $('approve-selected').textContent=status==='AWAITING_DEPLOY_APPROVAL'?'Approve 10% canary':'Approve promotion to 100%';
    $('selected-approval-result').textContent=isBusy()?'Sending approval…':run?.current&&d?.gate?.approvedAt&&status.startsWith('AWAITING_')?'Approval saved. Waiting for the next step.':'';
  }
  $('follow-current').addEventListener('click',()=>{const s=getState();followCurrent=true;selectedRunId=null;lastCurrentStep=null;renderWorkflow(s,s?.incident);renderInspector(s?.incident);});
  $('step-run').addEventListener('change',()=>{const d=getState()?.incident;selectedStep=chosenStep(d);followCurrent=false;selectedRunId=$('step-run').value;renderInspector(d);});
  $('approve-selected').addEventListener('click',()=>{const d=getState()?.incident;if(d?.gate&&chosenStep(d)===d.status)post('/api/approval',{incidentId:d.incidentId,gateId:d.gate.id,action:d.gate.action});});
  return {renderWorkflow,renderInspector};
}
