import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdir, readFile, writeFile, access } from 'node:fs/promises';
import { join } from 'node:path';
import { startServer } from '../src/server.ts';
import { originalCheckout, resetDemoFiles } from '../src/demo-reset.ts';
import { fixture, waitStatus } from './helpers.ts';
import { localRequest } from './http-transport.ts';

test('reset clears a running incident, restores the bug and allows another run without touching auth', { timeout: 40000 }, async () => {
  const f = await fixture();
  const running = await startServer({ ...f.options, listen: false });
  const post = (path: string, data: unknown, origin?: string) => localRequest(running.handle, path, 'POST', JSON.stringify(data),
    { 'Content-Type': 'application/json', ...(origin ? { Origin: origin } : {}) });
  const authDir = join(f.dir, '.auth');
  await mkdir(authDir); await writeFile(join(authDir, 'auth.json'), 'local-auth-sentinel');
  try {
    assert.equal((await post('/api/incident', {})).status, 200);
    await waitStatus(running.app, 'AWAITING_DEPLOY_APPROVAL');
    await writeFile(join(running.app.dataDir, 'incident-report.md'), 'previous report');
    const previousRuntime = running.app;
    assert.equal((await post('/api/reset', {})).status, 400);
    assert.equal((await post('/api/reset', { confirm: true }, 'https://unrelated.example')).status, 403);
    assert.equal((await post('/api/reset', { confirm: true })).status, 200);
    assert.notEqual(running.app, previousRuntime);
    const state = JSON.parse((await localRequest(running.handle, '/api/state')).body);
    assert.equal(state.incident, null);
    assert.equal(state.configuration.ready, true);
    assert.equal(await readFile(join(f.repo, 'src/checkout.ts'), 'utf8'), originalCheckout);
    await assert.rejects(access(join(f.repo, 'tests/incident.test.ts')), { code: 'ENOENT' });
    await assert.rejects(access(join(f.repo, '.sre-evidence')), { code: 'ENOENT' });
    assert.equal((await localRequest(running.handle, '/api/report')).status, 404);
    assert.equal(await readFile(join(authDir, 'auth.json'), 'utf8'), 'local-auth-sentinel');
    assert.equal((await post('/api/incident', {})).status, 200);
    const next = await waitStatus(running.app, 'AWAITING_DEPLOY_APPROVAL');
    assert.equal(next.verification.beforeFix, 'FAIL');
    assert.equal(next.verification.afterFix, 'PASS');
    assert.equal(next.deploymentCycle, 1);
  } finally { await running.close(); await f.clean(); }
});

test('command-line reset refuses to delete a live runtime', async () => {
  const f = await fixture(); const app = await f.open();
  try {
    await assert.rejects(resetDemoFiles(app.dataDir, app.repo), /Stop the demo server/);
    assert.equal(await readFile(join(app.dataDir, 'owner.lock'), 'utf8'), String(process.pid));
  } finally { await app.close(); await f.clean(); }
});
