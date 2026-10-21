import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fixture, runToEnd, getIncident } from './helpers.ts';

test('step findings and production snapshots stay historical after promotion and reopen', { timeout: 40000 }, async () => {
  const f = await fixture(); let app = await f.open();
  try {
    const d = await runToEnd(app);
    assert.equal(d.status, 'RESOLVED');
    const red = d.stepHistory!.find(s => s.status === 'REPRODUCING')!;
    const verifying = d.stepHistory!.find(s => s.status === 'VERIFYING')!;
    const canary = d.stepHistory!.find(s => s.status === 'OBSERVING')!;
    assert.ok(red.endedAt); assert.equal(red.fixSummary, '');
    assert.equal(red.evidenceIds.length, 1);
    assert.equal(verifying.evidenceIds.length, 3);
    assert.ok(d.stepHistory!.find(s => s.status === 'FIXING')!.changedFiles.includes('src/checkout.ts'));
    assert.equal(red.deployment.currentProductionVersion, 'v1');
    assert.equal(canary.deployment.canaryPercentage, 10);
    assert.equal(d.deployment.canaryPercentage, 100);
    assert.equal(d.stepHistory!.find(s => s.status === 'AWAITING_DEPLOY_APPROVAL')!.gate!.approvedAt.length > 0, true);
    const saved = JSON.stringify(d.stepHistory);
    await app.close(); app = await f.open();
    assert.equal(JSON.stringify((await getIncident(app)).stepHistory), saved);
  } finally { await app.close(); await f.clean(); }
});

test('rollback creates separate historical runs without replacing first-cycle evidence', { timeout: 40000 }, async () => {
  const f = await fixture('rollback-once'); const app = await f.open();
  try {
    const d = await runToEnd(app);
    const runs = d.stepHistory!.filter(s => s.status === 'REPRODUCING');
    assert.equal(runs.length, 2); assert.notEqual(runs[0].id, runs[1].id);
    assert.deepEqual(runs.map(s => s.cycle), [1, 2]);
    assert.equal(runs[0].evidenceIds.length, 1);
    assert.equal(runs[1].evidenceIds.length, 4);
    assert.ok(d.stepHistory!.find(s => s.status === 'ROLLING_BACK')!.endedAt);
  } finally { await app.close(); await f.clean(); }
});
