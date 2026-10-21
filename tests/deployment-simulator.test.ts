import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DeploymentSimulator } from '../src/deployment-simulator.ts';

test('canary, health, promotion and persisted operation deduplication', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pi-sim-'));
  try {
    const path = join(dir, 'production.json'); let sim = new DeploymentSimulator(path, 'healthy');
    await sim.create_rollback_point('prepare', 'v2', 1);
    await Promise.all([sim.deploy_canary('deploy', 'v2', 10), sim.deploy_canary('deploy', 'v2', 10)]);
    assert.deepEqual((await sim.read()).versions, { v1: 90, v2: 10 });
    assert.deepEqual(await sim.get_production_health(), { errorRate: 0.01, latencyP95: 220, healthy: true });
    sim = new DeploymentSimulator(path, 'healthy');
    await sim.promote_release('promote', 'v2');
    await sim.deploy_canary('deploy', 'v2', 10); // Replay cannot undo a later promotion.
    assert.deepEqual((await sim.read()).versions, { v1: 0, v2: 100 });
    assert.equal(Object.keys((await sim.read()).operations).length, 3);
    await assert.rejects(sim.deploy_canary('deploy', 'v2', 100), /different arguments/);
    assert.throws(() => sim.deploy_canary('bad', 'v2', 50), /10% or 100%/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
test('an unhealthy first canary restores baseline; the second candidate can become healthy', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pi-sim-'));
  try {
    const sim = new DeploymentSimulator(join(dir, 'state.json'), 'rollback-once');
    await sim.create_rollback_point('p1', 'v2', 1); await sim.deploy_canary('d1', 'v2', 10);
    assert.equal((await sim.get_production_health()).healthy, false);
    await assert.rejects(sim.promote_release('invalid', 'v2'), /No healthy canary/);
    await sim.rollback_release('rollback');
    assert.deepEqual((await sim.read()).versions, { v2: 0, v1: 100 });
    assert.equal((await sim.get_production_health()).healthy, true);
    await sim.create_rollback_point('p2', 'v3', 2); await sim.deploy_canary('d2', 'v3', 10);
    assert.equal((await sim.get_production_health()).healthy, true);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
