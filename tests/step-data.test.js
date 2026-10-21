import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getStepRuns, selectedRun, stepEvidence } from '../public/step-data.js';
const event=(id,status,message='')=>({id,status,message,at:'2026-10-21T08:00:00Z'});
const incident=extra=>({status:'VERIFYING',deploymentCycle:1,fixAttempts:2,events:[],evidence:[],stepHistory:[],rootCause:'Latest finding',...extra});

test('a repeated phase keeps separate visits and selected historical run',()=>{
  const d=incident({status:'FIXING',events:[event('transition:1','FIXING'),event('attempt:1','FIXING','Fix attempt 1 of 3'),event('transition:2','FIXING'),event('attempt:2','FIXING','Fix attempt 2 of 3')]});
  const runs=getStepRuns(d);
  assert.equal(runs.length,2);assert.notEqual(runs[0].id,runs[1].id);
  assert.equal(runs[0].attempt,1);assert.equal(runs[1].attempt,2);
  assert.ok(!selectedRun(d,'FIXING',runs[0].id).run.current);
  assert.equal(selectedRun(d,'FIXING',runs[1].id).run.current,true);
});
test('verification evidence is scoped to the selected cycle and attempt',()=>{
  const d=incident({events:[event('transition:1','VERIFYING')],evidence:[
    {id:'INC-1:1:1:a',kind:'regression'},{id:'INC-1:1:2:b',kind:'regression'},
    {id:'INC-1:1:2:c',kind:'component'},{id:'INC-1:2:2:d',kind:'regression'},{id:'INC-1:1:0:e',kind:'red'},
  ]});
  assert.deepEqual(stepEvidence(d,selectedRun(d,'VERIFYING').run).map(e=>e.id),['INC-1:1:2:b','INC-1:1:2:c']);
});
test('older steps without snapshots never borrow later findings',()=>{
  const d=incident({events:[event('transition:1','INVESTIGATING'),event('transition:2','VERIFYING')]});
  assert.equal(selectedRun(d,'INVESTIGATING').run.saved,null);
  assert.equal(selectedRun(d,'VERIFYING').run.saved.rootCause,'Latest finding');
  assert.equal(selectedRun(d,'PROMOTING').run,null);
});
