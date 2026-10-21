import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { join } from 'node:path';
import { fixture, fakeModel, incident, getIncident, waitStatus, approveCurrent, waitFor } from './helpers.ts';
import { receiveIncident } from '../src/incident-trigger.ts';
import { openRuntime } from '../src/pi-runtime.ts';
import type { TaskId } from '@earendil-works/pi-durable';

test('both approval gates survive reopen without approval or extra model calls', { timeout: 50000 }, async () => {
  const f = await fixture(); let app = await f.open();
  try {
    await receiveIncident(app, incident);
    let d = await waitStatus(app, 'AWAITING_DEPLOY_APPROVAL');
    const id = d.workflowTaskId; const gate = d.gate!.id; const calls = f.options.faux.state.callCount;
    for (let n = 0; n < 2; n++) {
      await app.close(); app = await f.open(); d = await waitStatus(app, 'AWAITING_DEPLOY_APPROVAL');
      assert.equal(d.workflowTaskId, id); assert.equal(d.gate!.id, gate); assert.equal(d.fixAttempts, 1);
      assert.equal(f.options.faux.state.callCount, calls); assert.equal(d.deployment.canaryPercentage, 0);
    }
    await approveCurrent(app); d = await waitStatus(app, 'AWAITING_PROMOTION_APPROVAL');
    const promotionGate = d.gate!.id;
    await app.close(); app = await f.open(); d = await waitStatus(app, 'AWAITING_PROMOTION_APPROVAL');
    assert.equal(d.workflowTaskId, id); assert.equal(d.gate!.id, promotionGate); assert.equal(d.deployment.canaryPercentage, 10);
    await approveCurrent(app); await waitStatus(app, 'RESOLVED');
  } finally { await app.close(); await f.clean(); }
});
test('approval committed before close is consumed once on reopen', { timeout: 40000 }, async () => {
  const f = await fixture(); f.options.pollMs = 1000; let app = await f.open();
  try {
    await receiveIncident(app, incident); const d = await waitStatus(app, 'AWAITING_DEPLOY_APPROVAL');
    await approveCurrent(app); await app.close(); app = await f.open();
    const next = await waitStatus(app, 'AWAITING_PROMOTION_APPROVAL');
    assert.equal(next.workflowTaskId, d.workflowTaskId); assert.equal(next.approvals.length, 1);
    assert.equal(Object.keys((await app.simulator.read()).operations).filter(k => k.endsWith(':deploy')).length, 1);
  } finally { await app.close(); await f.clean(); }
});
test('observation deadline survives reopen instead of restarting the window', { timeout: 30000 }, async () => {
  const f = await fixture(); f.options.observeMs = 1200; let app = await f.open();
  try {
    await receiveIncident(app, incident); await waitStatus(app, 'AWAITING_DEPLOY_APPROVAL');
    await approveCurrent(app); const d = await waitStatus(app, 'OBSERVING');
    const taskId = d.workflowTaskId as TaskId<null>;
    const before = (await app.harness.getTask(taskId, app.context))!;
    const deadline = (before.state as { checkpoint?: { observeUntil: number } }).checkpoint!.observeUntil;
    assert.ok(deadline > Date.now());
    await app.close(); app = await f.open();
    const after = (await app.harness.getTask(taskId, app.context))!;
    assert.equal((after.state as { checkpoint?: { observeUntil: number } }).checkpoint!.observeUntil, deadline);
    await waitStatus(app, 'AWAITING_PROMOTION_APPROVAL');
  } finally { await app.close(); await f.clean(); }
});
test('effect persisted before checkpoint is reconciled after restart', { timeout: 40000 }, async () => {
  const f = await fixture(); let app = await f.open();
  let release!: () => void, reached!: () => void;
  const held = new Promise<void>(r => { release = r; }); const effectDone = new Promise<void>(r => { reached = r; });
  const original = app.simulator.deploy_canary.bind(app.simulator);
  app.simulator.deploy_canary = async (...args) => { const p = await original(...args); reached(); await held; return p; };
  try {
    await receiveIncident(app, incident); await waitStatus(app, 'AWAITING_DEPLOY_APPROVAL');
    await approveCurrent(app); await effectDone;
    assert.equal((await getIncident(app)).status, 'PREPARING_DEPLOYMENT');
    const closing = app.close(); release(); await closing;
    app = await f.open(); const d = await waitStatus(app, 'AWAITING_PROMOTION_APPROVAL');
    assert.equal(d.fixAttempts, 1); assert.equal(d.deploymentCycle, 1);
    assert.equal(Object.keys((await app.simulator.read()).operations).filter(k => k.endsWith(':deploy')).length, 1);
  } finally { release(); await app.close(); await f.clean(); }
});
test('SIGKILL leaves the same durable task waiting for approval', { timeout: 50000 }, async () => {
  const f = await fixture(); let app: Awaited<ReturnType<typeof openRuntime>> | undefined;
  const child = fork(new URL('./crash-worker.ts', import.meta.url), [f.repo, f.options.dataDir], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  let output = ''; child.stderr?.on('data', x => { output += x; });
  try {
    const message = await Promise.race([
      once(child, 'message').then(([value]) => value as { taskId: number; gateId: string }),
      once(child, 'exit').then(() => { throw new Error(`Worker exited before gate: ${output}`); }),
      new Promise<never>((_, reject) => { const t = setTimeout(() => reject(new Error(`Worker timed out: ${output}`)), 25000); t.unref(); }),
    ]);
    const exit = once(child, 'exit'); child.kill('SIGKILL'); await exit;
    app = await openRuntime({ ...f.options, ...fakeModel() });
    const d = await waitStatus(app, 'AWAITING_DEPLOY_APPROVAL');
    assert.equal(d.workflowTaskId, message.taskId); assert.equal(d.gate!.id, message.gateId);
    await approveCurrent(app); await waitStatus(app, 'AWAITING_PROMOTION_APPROVAL');
  } finally { child.kill('SIGKILL'); await app?.close(); await f.clean(); }
});
