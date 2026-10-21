import { defineDoc } from '@earendil-works/pi-durable';
import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

export const STATES = [
  'DETECTED', 'TRIAGING', 'INVESTIGATING', 'REPRODUCING', 'FIXING', 'VERIFYING',
  'AWAITING_DEPLOY_APPROVAL', 'PREPARING_DEPLOYMENT', 'CANARY_DEPLOYED', 'OBSERVING',
  'AWAITING_PROMOTION_APPROVAL', 'ROLLING_BACK', 'PROMOTING', 'FINAL_VERIFY', 'RESOLVED', 'FAILED',
] as const;
export type Status = typeof STATES[number];
export type TestEvidence = {
  id: string; kind: string; command: string; exitCode: number | null; result: string;
  output: string; sourceHash: string; testHash: string; at: string;
};
export type StepSnapshot = {
  id: string; status: Status; cycle: number; attempt: number;
  startedAt: string; updatedAt: string; endedAt: string;
  initialHypothesis: string; rootCauseHypothesis: string; rootCause: string;
  suspectedArea: string; severity: string; fixSummary: string; failure: string;
  relevantFiles: string[]; changedFiles: string[]; evidenceIds: string[];
  deployment: Incident['deployment']; gate: Incident['gate'];
};
export type Incident = {
  incidentId: string; service: string; severity: string; error: string; route: string; stack: string;
  usersAffected: number; status: Status; startedAt: string; updatedAt: string;
  workflowTaskId: number; executionMode: string; scenario: string;
  suspectedArea: string; needsCodeChange: boolean; initialHypothesis: string;
  rootCauseHypothesis: string; rootCause: string; relevantFiles: string[];
  changedFiles: string[]; regressionTest: string; fixSummary: string;
  fixAttempts: number; deploymentCycle: number; rollbackCount: number; failure: string;
  cycleSourceHash: string; cycleSource: Record<string, string>; candidateHash: string; protectedFilesHash: string;
  verification: { beforeFix: string; afterFix: string; relevantTests: string };
  evidence: TestEvidence[];
  gate: { id: string; action: string; version: string; approvedAt: string; consumedAt: string } | null;
  approvals: { id: string; action: string; version: string; approvedAt: string; consumedAt: string }[];
  deployment: {
    currentProductionVersion: string; candidateVersion: string; rollbackVersion: string;
    canaryPercentage: number; versions: Record<string, number>; errorRate: number; latencyP95: number;
    healthy: boolean; stage: string; canary: string; production: string;
  };
  events: { id: string; at: string; status: string; message: string }[];
  stepHistory?: StepSnapshot[];
};
export function emptyIncident(): Incident {
  return {
    incidentId: '', service: '', severity: '', error: '', route: '', stack: '', usersAffected: 0,
    status: 'DETECTED', startedAt: '', updatedAt: '', workflowTaskId: 0,
    executionMode: 'real', scenario: 'healthy', suspectedArea: '', needsCodeChange: true,
    initialHypothesis: '', rootCauseHypothesis: '', rootCause: '', relevantFiles: [], changedFiles: [],
    regressionTest: 'tests/incident.test.ts', fixSummary: '', fixAttempts: 0, deploymentCycle: 1,
    rollbackCount: 0, failure: '', cycleSourceHash: '', cycleSource: {}, candidateHash: '',
    protectedFilesHash: '', verification: { beforeFix: 'PENDING', afterFix: 'PENDING', relevantTests: 'PENDING' },
    evidence: [], gate: null, approvals: [],
    deployment: { currentProductionVersion: 'v1', candidateVersion: 'v2', rollbackVersion: 'v1',
      canaryPercentage: 0, versions: { v1: 100 }, errorRate: 0.01, latencyP95: 220,
      healthy: true, stage: 'DETECTED', canary: 'pending', production: 'baseline' },
    events: [], stepHistory: [],
  };
}
export const IncidentDoc = defineDoc<Incident>({
  kind: 'sre.incident', version: 1, scope: 'conversation', history: 'latest', fork: 'initial',
  initial: emptyIncident,
});
export function event(d: Incident, id: string, message: string) {
  d.updatedAt = new Date().toISOString();
  if (!d.events.some(e => e.id === id)) d.events.push({ id, at: d.updatedAt, status: d.status, message });
  captureStep(d);
}
export function captureStep(d: Incident, finish = false) {
  d.stepHistory ??= [];
  let step = d.stepHistory.at(-1);
  if (!step || step.status !== d.status || step.cycle !== d.deploymentCycle || step.endedAt) {
    // Existing sessions may predate step history; do not reconstruct old findings
    // from today's mutable fields. Capture only the currently executing step.
    const currentEvents = [];
    for (let i = d.events.length - 1; i >= 0 && d.events[i].status === d.status; i--) {
      currentEvents.unshift(d.events[i]);
      if (d.events[i].id.startsWith('transition:')) break;
    }
    const first = currentEvents[0];
    d.stepHistory.push({ id: `step:${first?.id ?? d.events.length}`, status: d.status,
      cycle: d.deploymentCycle, attempt: d.fixAttempts, startedAt: first?.at ?? d.updatedAt,
      updatedAt: d.updatedAt, endedAt: '', initialHypothesis: '', rootCauseHypothesis: '', rootCause: '',
      suspectedArea: '', severity: '', fixSummary: '', failure: '', relevantFiles: [], changedFiles: [], evidenceIds: [],
      deployment: JSON.parse(JSON.stringify(d.deployment)), gate: null });
    step = d.stepHistory.at(-1)!;
  }
  Object.assign(step, {
    attempt: d.fixAttempts, updatedAt: d.updatedAt,
    initialHypothesis: d.initialHypothesis, rootCauseHypothesis: d.rootCauseHypothesis, rootCause: d.rootCause,
    suspectedArea: d.suspectedArea, severity: d.severity, fixSummary: d.fixSummary, failure: d.failure,
    relevantFiles: [...d.relevantFiles], changedFiles: [...d.changedFiles], evidenceIds: d.evidence.map(e => e.id),
    deployment: JSON.parse(JSON.stringify(d.deployment)), gate: d.gate ? { ...d.gate } : null,
  });
  if (finish) step.endedAt = new Date().toISOString();
}
export async function sourceSnapshot(repo: string): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  async function walk(relative: string) {
    for (const item of (await readdir(join(repo, relative), { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const path = `${relative}/${item.name}`;
      if (item.isDirectory()) await walk(path);
      else if (item.isFile()) result[path] = await readFile(join(repo, path), 'utf8');
      else throw new Error('The demo source must contain only regular files.');
    }
  }
  await walk('src');
  return result;
}
export function digest(value: unknown) { return createHash('sha256').update(JSON.stringify(value)).digest('hex'); }
export async function codeHash(repo: string) { return digest(await sourceSnapshot(repo)); }
export async function testHash(repo: string) { return digest(await readFile(join(repo, 'tests/incident.test.ts'), 'utf8')); }
export async function protectedHash(repo: string) {
  return digest(await Promise.all(['package.json', 'tests/checkout.test.ts'].map(p => readFile(join(repo, p), 'utf8'))));
}
