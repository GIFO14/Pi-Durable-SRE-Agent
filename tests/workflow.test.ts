import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fixture, incident, waitStatus, waitFor, getIncident, approveCurrent, runToEnd } from './helpers.ts';
import { receiveIncident } from '../src/incident-trigger.ts';
import { approve } from '../src/approval-api.ts';
import type { TaskId } from '@earendil-works/pi-durable';

test('real Pi tools reproduce, edit and verify; both approvals gate rollout', { timeout: 40000 }, async () => {
  const f = await fixture(); const app = await f.open();
  try {
    const triggers = await Promise.all(Array.from({ length: 4 }, () => receiveIncident(app, incident)));
    assert.equal(new Set(triggers.map(t => t.taskId)).size, 1);
    let d = await waitStatus(app, 'AWAITING_DEPLOY_APPROVAL');
    assert.equal(d.events.filter(e => e.id === 'received').length, 1);
    assert.deepEqual(d.verification, { beforeFix: 'FAIL', afterFix: 'PASS', relevantTests: 'PASS' });
    assert.equal(d.evidence.length, 3);
    assert.equal((await app.simulator.read()).canaryPercentage, 0);
    await assert.rejects(approve(app, { incidentId: incident.id, gateId: 'stale', action: 'promote' }), /does not match/);
    const gate = d.gate!;
    await Promise.all([approveCurrent(app), approveCurrent(app)]);
    d = await waitStatus(app, 'AWAITING_PROMOTION_APPROVAL');
    assert.equal(d.deployment.canaryPercentage, 10);
    assert.equal(d.deployment.healthy, true);
    await assert.rejects(approve(app, { incidentId: incident.id, gateId: gate.id, action: gate.action }), /does not match/);
    await approveCurrent(app);
    d = await waitStatus(app, 'RESOLVED');
    await app.harness.waitForTask(d.workflowTaskId as TaskId<null>, app.context);
    assert.equal(d.deployment.canaryPercentage, 100);
    assert.equal(d.deployment.currentProductionVersion, 'v2');
    assert.match(await readFile(join(app.dataDir, 'incident-report.md'), 'utf8'), /Missing session validation/);
    assert.match(await readFile(join(f.repo, 'tests/incident.test.ts'), 'utf8'), /expired session without a user/);
    assert.equal(d.approvals.length, 2);
    assert.equal(d.executionMode, 'scripted-test');
  } finally { await app.close(); await f.clean(); }
});
for (const mode of ['no-red', 'bad-setup']) test(`${mode}: reproduction blocks fixing`, { timeout: 30000 }, async () => {
  const f = await fixture('healthy', mode); const app = await f.open();
  try {
    await receiveIncident(app, incident); const d = await waitStatus(app, 'FAILED');
    assert.equal(d.fixAttempts, 0); assert.equal(d.verification.beforeFix, 'INVALID');
    assert.equal((await app.simulator.read()).canaryPercentage, 0);
  } finally { await app.close(); await f.clean(); }
});
test('failed verification stops after exactly three global fix attempts', { timeout: 50000 }, async () => {
  const f = await fixture('healthy', 'broken-fix'); const app = await f.open();
  try {
    await receiveIncident(app, incident); const d = await waitStatus(app, 'FAILED');
    assert.equal(d.fixAttempts, 3); assert.equal(d.approvals.length, 0); assert.match(d.failure, /three fix attempts/);
  } finally { await app.close(); await f.clean(); }
});
for (const scenario of ['rollback-once', 'second-canary-fails', 'second-final-fails', 'baseline-fails']) test(`${scenario}: bounded recovery`, { timeout: 60000 }, async () => {
  const f = await fixture(scenario); const app = await f.open();
  try {
    const d = await runToEnd(app);
    assert.equal(d.rollbackCount, 1);
    assert.ok(d.fixAttempts <= 3); assert.ok(d.deploymentCycle <= 2);
    if (scenario === 'rollback-once') {
      assert.equal(d.status, 'RESOLVED'); assert.equal(d.fixAttempts, 2);
      assert.equal(d.deployment.currentProductionVersion, 'v3'); assert.equal(d.approvals.length, 3);
      assert.equal(d.evidence.filter(e => e.kind === 'red' && e.result === 'FAIL').length, 2);
    } else {
      assert.equal(d.status, 'FAILED');
      assert.equal(d.deployment.healthy, false);
      if (scenario === 'baseline-fails') assert.equal(d.deploymentCycle, 1);
    }
    assert.equal(Object.keys((await app.simulator.read()).operations).filter(k => k.endsWith(':rollback')).length, 1);
  } finally { await app.close(); await f.clean(); }
});
test('changing the verified source while awaiting approval blocks deployment', { timeout: 30000 }, async () => {
  const f = await fixture(); const app = await f.open();
  try {
    await receiveIncident(app, incident); await waitStatus(app, 'AWAITING_DEPLOY_APPROVAL');
    const path = join(f.repo, 'src/checkout.ts'); await writeFile(path, (await readFile(path, 'utf8')) + '// changed after verification\n');
    await approveCurrent(app); const d = await waitStatus(app, 'FAILED');
    assert.match(d.failure, /changed while waiting/); assert.equal((await app.simulator.read()).canaryPercentage, 0);
  } finally { await app.close(); await f.clean(); }
});
