import assert from 'node:assert/strict';
import { test } from 'node:test';
import { startServer } from '../src/server.ts';
import { fixture, waitStatus } from './helpers.ts';
import type { TaskId } from '@earendil-works/pi-durable';
import { localRequest } from './http-transport.ts';

test('HTTP handler serves committed state, validates gates and downloads the real report', { timeout: 40000 }, async () => {
  const f = await fixture(); const running = await startServer({ ...f.options, listen: false });
  const get = (path: string) => localRequest(running.handle, path);
  const post = (path: string, data: unknown, origin?: string) => localRequest(running.handle, path, 'POST', JSON.stringify(data),
    { 'Content-Type': 'application/json', ...(origin ? { Origin: origin } : {}) });
  try {
    let snapshot = JSON.parse((await get('/api/state')).body);
    assert.equal(snapshot.incident, null); assert.equal(snapshot.configuration.executionMode, 'scripted-test');
    assert.match((await get('/')).body, /Investigation &amp; evidence|Investigation & evidence/);
    const font = await get('/fonts/inter-latin.woff2');
    assert.equal(font.status, 200); assert.equal(font.headers['Content-Type'], 'font/woff2');
    const icon = await get('/icons/layers.svg');
    assert.equal(icon.status, 200); assert.match(icon.body, /<svg/);
    assert.equal((await get('/.auth/auth.json')).status, 404);
    assert.equal((await get('/icons/unknown.svg')).status, 404);
    assert.equal((await post('/api/incident', {}, 'https://unrelated.example')).status, 403);
    const injected = await post('/api/incident', {}); assert.equal(injected.status, 200);
    const d = await waitStatus(running.app, 'AWAITING_DEPLOY_APPROVAL');
    snapshot = JSON.parse((await get('/api/state')).body);
    assert.equal(snapshot.incident.workflowTaskId, d.workflowTaskId);
    assert.equal(snapshot.incident.verification.beforeFix, 'FAIL');
    assert.equal((await post('/api/approval', { incidentId: d.incidentId, gateId: 'stale', action: 'promote' })).status, 409);
    assert.equal((await post('/api/approval', { incidentId: d.incidentId, gateId: d.gate!.id, action: 'deploy' })).status, 200);
    const promotion = await waitStatus(running.app, 'AWAITING_PROMOTION_APPROVAL');
    assert.equal((await post('/api/approval', { incidentId: d.incidentId, gateId: promotion.gate!.id, action: 'promote' })).status, 200);
    const resolved = await waitStatus(running.app, 'RESOLVED');
    await running.app.harness.waitForTask(resolved.workflowTaskId as TaskId<null>, running.app.context);
    const report = await get('/api/report'); assert.equal(report.status, 200);
    assert.match(report.body, /Status: \*\*RESOLVED\*\*/);
    assert.equal((await get('/.env')).status, 404);
  } finally { await running.close(); await f.clean(); }
});
