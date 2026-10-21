export const stepGroups = [
  {name:'Investigate',icon:'search',states:['DETECTED','TRIAGING','INVESTIGATING']},
  {name:'Fix & verify',icon:'flask-conical',states:['REPRODUCING','FIXING','VERIFYING']},
  {name:'Deploy & observe',icon:'rocket',states:['AWAITING_DEPLOY_APPROVAL','PREPARING_DEPLOYMENT','CANARY_DEPLOYED','OBSERVING','ROLLING_BACK']},
  {name:'Resolve',icon:'circle-check',states:['AWAITING_PROMOTION_APPROVAL','PROMOTING','FINAL_VERIFY','RESOLVED','FAILED']},
];
export const stepDescriptions = {
  DETECTED:'Receive the alert and open a durable incident.',
  TRIAGING:'Assess impact, severity and the area to investigate.',
  INVESTIGATING:'Inspect the repository and establish a root-cause hypothesis.',
  REPRODUCING:'Create a regression test and demonstrate the original failure.',
  FIXING:'Apply the smallest source change for the reproduced failure.',
  VERIFYING:'Run regression and component tests against the candidate fix.',
  AWAITING_DEPLOY_APPROVAL:'Wait for human approval of this verified candidate.',
  PREPARING_DEPLOYMENT:'Verify the candidate and prepare the canary rollout.',
  CANARY_DEPLOYED:'Route 10% of simulated traffic to the candidate.',
  OBSERVING:'Observe the canary and evaluate production health.',
  AWAITING_PROMOTION_APPROVAL:'Wait for human approval to promote the healthy canary.',
  ROLLING_BACK:'Restore the rollback version and verify baseline health.',
  PROMOTING:'Move the approved candidate to 100% of simulated traffic.',
  FINAL_VERIFY:'Verify production health after full promotion.',
  RESOLVED:'Close the incident after final production verification.',
  FAILED:'Stop the workflow and preserve its failure evidence.',
};
export function getStepRuns(d) {
  if(!d)return [];
  const runs=[];let cycle=1,attempt=0;
  for(const e of d.events){
    const previous=runs.at(-1);
    if(previous?.status==='ROLLING_BACK'&&e.status==='INVESTIGATING')cycle++;
    const match=/Fix attempt (\d+)/.exec(e.message);if(match)attempt=Number(match[1]);
    let run=previous;
    if(!run||run.status!==e.status||e.id.startsWith('transition:')){
      if(run){run.endedAt=e.at;run.nextStatus=e.status;}
      run={id:`step:${e.id}`,status:e.status,cycle,attempt,startedAt:e.at,endedAt:'',events:[],saved:null};runs.push(run);
    }
    run.attempt=attempt;run.events.push(e);
  }
  for(const run of runs){
    const saved=d.stepHistory?.find(s=>s.id===run.id);
    if(saved)Object.assign(run,{saved,cycle:saved.cycle,attempt:saved.attempt,startedAt:saved.startedAt,endedAt:saved.endedAt});
  }
  // Current state is reliable even for incidents created before snapshots existed.
  const current=runs.at(-1);
  if(current&&current.status===d.status&&!current.endedAt){
    current.current=true;current.cycle=d.deploymentCycle;current.attempt=d.fixAttempts;
    current.saved={...d,evidenceIds:d.evidence.map(e=>e.id)};
  }
  return runs;
}
export function stepEvidence(d,run){
  if(!d||!run)return [];
  const kinds=run.status==='REPRODUCING'?['red']:run.status==='VERIFYING'?['regression','component']:[];
  return d.evidence.filter(e=>{
    const parts=e.id.split(':');
    return kinds.includes(e.kind)&&Number(parts[1])===run.cycle
      &&(run.status==='REPRODUCING'||Number(parts[2])===run.attempt)
      &&(!run.saved?.evidenceIds||run.saved.evidenceIds.includes(e.id));
  });
}
export function selectedRun(d,status,runId){
  const runs=getStepRuns(d).filter(r=>r.status===status);
  return {runs,run:runs.find(r=>r.id===runId)??runs.at(-1)??null};
}
