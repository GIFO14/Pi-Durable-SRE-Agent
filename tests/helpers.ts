import { mkdtemp, cp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createModels } from '@earendil-works/pi-ai/models';
import { fauxProvider, fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai/providers/faux';
import type { FauxResponseFactory } from '@earendil-works/pi-ai/providers/faux';
import type { JsonObject } from '@earendil-works/pi-durable';
import { openRuntime } from '../src/pi-runtime.ts';
import type { AppRuntime } from '../src/pi-runtime.ts';
import { IncidentDoc } from '../src/incident-state.ts';
import type { Incident } from '../src/incident-state.ts';
import { receiveIncident } from '../src/incident-trigger.ts';
import { approve } from '../src/approval-api.ts';

export const incident = { id: 'INC-001', service: 'checkout-api', severity: 'high', error: "TypeError: Cannot read properties of undefined (reading 'id')", route: '/api/checkout', stack: 'at checkout (src/checkout.ts:3:31)', usersAffected: 184 };
const original = `// Contract: valid sessions return 200; expired or anonymous sessions return 401.\nexport function checkout(session: { expired?: boolean; user?: { id: string } }) {\n  const userId = session.user!.id;\n  if (session.expired) return { status: 401, error: 'Session expired' };\n  return { status: 200, userId };\n}\n`;
export function fakeModel(mode = 'normal') {
  const faux = fauxProvider();
  const models = createModels(); models.setProvider(faux.provider);
  const factory: FauxResponseFactory = context => {
    const lastUser = context.messages.findLastIndex(m => m.role === 'user');
    const message = context.messages[lastUser];
    const prompt = message?.role === 'user' ? typeof message.content === 'string' ? message.content : message.content.map(c => c.type === 'text' ? c.text : '').join('') : '';
    const phase = /Phase: ([A-Z_]+)/.exec(prompt)?.[1];
    const cycle = Number(/cycle (\d+)/.exec(prompt)?.[1] ?? 1);
    const attempt = Number(/fix attempt (\d+)/.exec(prompt)?.[1] ?? 1);
    const step = context.messages.slice(lastUser + 1).filter(m => m.role === 'toolResult').length;
    const findings = { rootCauseHypothesis: 'The code reads session.user.id before validating the session.', rootCause: 'Missing session validation before reading the user object.', relevantFiles: ['src/checkout.ts', 'tests/checkout.test.ts'] };
    let calls: [string, JsonObject][] = [];
    if (phase === 'TRIAGING') calls = [['record_findings', { severity: 'high', suspectedArea: 'checkout', needsCodeChange: true, initialHypothesis: 'An expired session can omit the user object.' }]];
    if (phase === 'INVESTIGATING') calls = [['read', { path: 'src/checkout.ts' }], ['read', { path: 'tests/checkout.test.ts' }], ['record_findings', findings]];
    if (phase === 'REPRODUCING') {
      let content = `import { test } from 'node:test';\nimport assert from 'node:assert/strict';\nimport { checkout } from '../src/checkout.ts';\ntest('expired session without a user returns 401', () => { assert.equal(checkout({expired:true}).status, 401); });\n`;
      if (cycle === 2) content += `test('anonymous session returns 401', () => { assert.equal(checkout({}).status, 401); });\n`;
      if (mode === 'no-red') content = `import { test } from 'node:test';\nimport assert from 'node:assert/strict';\nimport { checkout } from '../src/checkout.ts';\ntest('valid session', () => { assert.equal(checkout({user:{id:'1'}}).status,200); });\n`;
      if (mode === 'bad-setup') content = `import './missing.ts';\n`;
      calls = [['write', { path: 'tests/incident.test.ts', content }], ['run_incident_tests', { kind: 'red' }], ['record_findings', findings]];
    }
    if (phase === 'FIXING') {
      const guard = cycle === 1 ? 'session.expired' : 'session.expired || !session.user';
      const content = mode === 'broken-fix' ? `${original}// attempted fix ${attempt}\n` : `export function checkout(session: { expired?: boolean; user?: { id: string } }) {\n  if (${guard}) return { status: 401, error: 'Session expired' };\n  return { status: 200, userId: session.user!.id };\n}\n`;
      calls = [['write', { path: 'src/checkout.ts', content }], ['record_findings', { rootCause: findings.rootCause, fixSummary: cycle === 1 ? 'Reject expired sessions before reading the user.' : 'Also reject anonymous sessions before reading the user.' }]];
    }
    if (phase === 'VERIFYING') calls = [['run_incident_tests', { kind: 'regression' }], ['run_incident_tests', { kind: 'component' }], ['record_findings', findings]];
    const call = calls[step];
    if (!call) throw new Error(`Unexpected scripted-model phase/step: ${phase}/${step}`);
    return fauxAssistantMessage([fauxToolCall(call[0], call[1])], { stopReason: 'toolUse' });
  };
  faux.setResponses(Array.from({ length: 250 }, () => factory));
  return { models, model: { provider: 'faux', modelId: 'faux-1' }, faux };
}
export async function fixture(scenario = 'healthy', mode = 'normal') {
  const dir = await mkdtemp(join(tmpdir(), 'pi-sre-test-'));
  const repo = join(dir, 'repo'); await cp(new URL('../demo-repo', import.meta.url), repo, { recursive: true });
  // Never inherit a regression test or a fix from a manual run.
  await rm(join(repo, 'tests/incident.test.ts'), { force: true });
  const { writeFile } = await import('node:fs/promises'); await writeFile(join(repo, 'src/checkout.ts'), original);
  const options = { repo, dataDir: join(dir, 'state'), scenario, observeMs: 10, pollMs: 10, ...fakeModel(mode) };
  return { dir, repo, options, async open() { return openRuntime(options); }, async clean() { await rm(dir, { recursive: true, force: true }); } };
}
export async function getIncident(app: AppRuntime) {
  const d = await app.harness.snapshot(IncidentDoc, app.root.id, app.context);
  if (!d) throw new Error('No incident document'); return d;
}
export async function waitFor(app: AppRuntime, predicate: (d: Readonly<Incident>) => boolean, timeout = 20000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const d = await getIncident(app);
    if (predicate(d)) return d;
    if (d.status === 'FAILED') throw new Error(`Workflow failed: ${d.failure}; diagnostics: ${app.diagnostics.join('; ')}`);
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  const d = await getIncident(app);
  throw new Error(`Timed out in ${d.status}: ${JSON.stringify(await app.harness.inspect(app.context))}`);
}
export const waitStatus = (app: AppRuntime, status: string) => waitFor(app, d => d.status === status);
export async function approveCurrent(app: AppRuntime) {
  const d = await getIncident(app);
  if (!d.gate) throw new Error('No gate');
  return approve(app, { incidentId: d.incidentId, gateId: d.gate.id, action: d.gate.action });
}
export async function runToEnd(app: AppRuntime) {
  await receiveIncident(app, incident);
  for (let n = 0; n < 6; n++) {
    const d = await waitFor(app, d => ['AWAITING_DEPLOY_APPROVAL', 'AWAITING_PROMOTION_APPROVAL', 'RESOLVED', 'FAILED'].includes(d.status) && !d.gate?.approvedAt || ['RESOLVED', 'FAILED'].includes(d.status));
    if (['RESOLVED', 'FAILED'].includes(d.status)) return d;
    await approveCurrent(app);
  }
  throw new Error('Too many approvals');
}
