import { defineExtension, defineTask, defineTool, section } from '@earendil-works/pi-durable';
import type { RunningTask, TaskRuntime } from '@earendil-works/pi-durable';
import { Type } from '@earendil-works/pi-ai';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { IncidentDoc, STATES, codeHash, digest, event, captureStep, sourceSnapshot, testHash, protectedHash } from './incident-state.ts';
import type { Incident, Status, TestEvidence } from './incident-state.ts';
import type { DeploymentSimulator, Production } from './deployment-simulator.ts';

type Input = { incidentId: string };
type Checkpoint = { phase: Status; sequence: number; observeUntil: number };
type Runtime = TaskRuntime<Input, Checkpoint, null, {}>;
type Running = RunningTask<Input, Checkpoint, null>;
export type WorkflowOptions = {
  repo: string; dataDir: string; simulator: DeploymentSimulator; observeMs: number; pollMs?: number;
};
const text = (s: string) => [{ type: 'text' as const, text: s }];
const terminal = (s: string) => s === 'RESOLVED' || s === 'FAILED';
const safeFile = (s: string) => /^(src|tests)\/[\w./-]+\.ts$/.test(s) && !s.includes('..');
export function applyProduction(d: Incident, p: Production) {
  Object.assign(d.deployment, {
    currentProductionVersion: p.currentProductionVersion, candidateVersion: p.candidateVersion,
    rollbackVersion: p.rollbackVersion, versions: p.versions, canaryPercentage: p.canaryPercentage,
    errorRate: p.health.errorRate, latencyP95: p.health.latencyP95, healthy: p.health.healthy,
  });
}
export function createWorkflow(options: WorkflowOptions) {
  const { repo, dataDir, simulator, observeMs } = options;
  const findings = defineTool({
    name: 'record_findings', description: 'Persist findings for this phase, then finish this phase. Never use this to claim test results.',
    parameters: Type.Object({
      severity: Type.Optional(Type.Union([Type.Literal('low'), Type.Literal('medium'), Type.Literal('high'), Type.Literal('critical')])),
      suspectedArea: Type.Optional(Type.String()), needsCodeChange: Type.Optional(Type.Boolean()),
      initialHypothesis: Type.Optional(Type.String()), rootCauseHypothesis: Type.Optional(Type.String()),
      rootCause: Type.Optional(Type.String()), relevantFiles: Type.Optional(Type.Array(Type.String())),
      fixSummary: Type.Optional(Type.String()),
    }),
    executionMode: 'sequential', replay: 'safe',
    execute: async (args, api, context) => {
      await api.commit(async tx => {
        const d = await tx.doc(IncidentDoc, api.conversationId);
        if (!['TRIAGING', 'INVESTIGATING', 'REPRODUCING', 'FIXING', 'VERIFYING'].includes(d.status)) throw new Error('Not in an agent phase');
        if (args.relevantFiles?.some(p => !safeFile(p))) throw new Error('Use relative src/ or tests/ paths');
        const allowed = d.status === 'TRIAGING' ? ['severity', 'suspectedArea', 'needsCodeChange', 'initialHypothesis']
          : d.status === 'FIXING' ? ['rootCause', 'fixSummary'] : ['rootCauseHypothesis', 'rootCause', 'relevantFiles'];
        for (const [key, value] of Object.entries(args)) if (allowed.includes(key)) Object.assign(d, { [key]: value });
        event(d, `findings:${api.taskId}`, `${d.status}: agent findings saved`);
      }, context);
      return { output: text('Findings persisted.'), control: { terminate: true } };
    },
  });
  const tests = defineTool({
    name: 'run_incident_tests', description: 'Run the real fixed regression/component command through Pi bash and persist its evidence. kind=red before fixing, regression/component during verification.',
    parameters: Type.Object({ kind: Type.Union([Type.Literal('red'), Type.Literal('regression'), Type.Literal('component')]) }),
    executionMode: 'sequential',
    execute: async ({ kind }, api, context) => {
      const before = await api.snapshot(IncidentDoc, api.conversationId, context);
      if (!before) throw new Error('Missing incident document');
      if (await protectedHash(repo) !== before.protectedFilesHash) throw new Error('Component tests or package.json were modified');
      if (kind === 'red' ? before.status !== 'REPRODUCING' : before.status !== 'VERIFYING') throw new Error('Test evidence is not accepted in this phase');
      const hash = await codeHash(repo);
      const regressionHash = await testHash(repo);
      if (kind === 'red' && hash !== before.cycleSourceHash) throw new Error('Source was changed before reproduction');
      const red = before.evidence.findLast(e => e.kind === 'red' && e.id.startsWith(`${before.incidentId}:${before.deploymentCycle}:`));
      if (kind !== 'red' && (!red || regressionHash !== red.testHash)) throw new Error('Regression test was changed after RED');
      // Keep full command evidence even if a process exits before its streaming tail is delivered.
      await mkdir(join(repo, '.sre-evidence'), { recursive: true });
      const outputPath = `.sre-evidence/run-${api.taskId}.tap`;
      const command = `node --test --test-isolation=none --test-reporter=tap tests/${kind === 'component' ? 'checkout' : 'incident'}.test.ts > ${outputPath} 2>&1`;
      const run = await api.executeTool('bash', { command, timeout: 30 }, context);
      const result = run.structuredOutput as { exitCode?: number; output?: string } | undefined;
      let output = result?.output ?? run.diagnostics.map(x => x.message).join('\n');
      try { output = await readFile(join(repo, outputPath), 'utf8'); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      const exitCode = result?.exitCode ?? null;
      const ranTests = /^# tests [1-9]\d*$/m.test(output);
      const genuineRed = exitCode !== null && exitCode !== 0 && ranTests
        && /^# fail [1-9]\d*$/m.test(output) && /TypeError|ERR_ASSERTION/.test(output)
        && !/ERR_MODULE_NOT_FOUND|ERR_UNKNOWN_FILE_EXTENSION|SyntaxError|ERR_UNSUPPORTED_TYPESCRIPT/.test(output);
      const unchanged = hash === await codeHash(repo) && regressionHash === await testHash(repo);
      const verdict = !unchanged ? 'INVALID' : kind === 'red' ? genuineRed ? 'FAIL' : 'INVALID'
        : exitCode === 0 && ranTests && /^# fail 0$/m.test(output) ? 'PASS' : 'FAIL';
      const proof: TestEvidence = {
        id: `${before.incidentId}:${before.deploymentCycle}:${before.fixAttempts}:${api.taskId}`,
        kind, command, exitCode, result: verdict, output: output.slice(-14000),
        sourceHash: hash, testHash: regressionHash, at: new Date().toISOString(),
      };
      await api.commit(async tx => {
        const d = await tx.doc(IncidentDoc, api.conversationId);
        if (d.status !== before.status || d.deploymentCycle !== before.deploymentCycle) throw new Error('Stale test execution');
        if (!d.evidence.some(e => e.id === proof.id)) d.evidence.push(proof);
        if (kind === 'red') d.verification.beforeFix = verdict;
        else if (kind === 'regression') d.verification.afterFix = verdict;
        else d.verification.relevantTests = verdict;
        event(d, `test:${proof.id}`, `${kind}: ${verdict} (exit ${exitCode ?? 'interrupted'})`);
      }, context);
      return { output: text(`${kind}: ${verdict}\n${output}`), details: proof };
    },
  });
  async function advance(runtime: Runtime, next: Status, message: string, update?: (d: Incident) => void) {
    await runtime.commit(async (tx, task) => {
      const d = await tx.doc(IncidentDoc, runtime.conversationId);
      if (terminal(d.status)) throw new Error('Incident is already terminal');
      // Rollback's next-phase update clears findings and increments the cycle.
      // Other updates contain this phase's outputs (such as changed files).
      if (d.status === 'ROLLING_BACK') captureStep(d, true);
      update?.(d);
      if (d.status !== 'ROLLING_BACK') captureStep(d, true);
      d.status = next; d.deployment.stage = next;
      if (next === 'AWAITING_DEPLOY_APPROVAL' || next === 'AWAITING_PROMOTION_APPROVAL') {
        d.gate = { id: `${d.incidentId}:${d.deploymentCycle}:${next}`, action: next === 'AWAITING_DEPLOY_APPROVAL' ? 'deploy' : 'promote',
          version: d.deployment.candidateVersion, approvedAt: '', consumedAt: '' };
      }
      event(d, `transition:${task.state.checkpoint.sequence + 1}`, message);
      return { status: 'running', checkpoint: { phase: next, sequence: task.state.checkpoint.sequence + 1,
        observeUntil: next === 'OBSERVING' || next === 'FINAL_VERIFY' ? runtime.now() + observeMs : 0 } };
    }, contextOf(runtime));
  }
  // Contexts belong to each invocation, never to persisted checkpoints.
  const contexts = new WeakMap<object, Parameters<Runtime['sleep']>[1]>();
  function contextOf(runtime: Runtime) { return contexts.get(runtime)!; }
  const read = async (runtime: Runtime) => {
    const d = await runtime.snapshot(IncidentDoc, runtime.conversationId, contextOf(runtime));
    if (!d) throw new Error('Missing incident document');
    return d;
  };
  const fail = (runtime: Runtime, message: string) => advance(runtime, 'FAILED', message, d => { d.failure = message; });
  async function ask(runtime: Runtime, phase: Status, instruction: string) {
    const d = await read(runtime);
    const context = contextOf(runtime);
    const conversation = await runtime.conversation(runtime.conversationId, context);
    if (!conversation) throw new Error('Missing incident conversation');
    const requestId = `${d.incidentId}:${d.deploymentCycle}:${phase}:${phase === 'FIXING' || phase === 'VERIFYING' ? d.fixAttempts : 0}`;
    const settled = await (await conversation.submit({ type: 'input', requestId, content:
      `Phase: ${phase}. Incident ${d.incidentId}, cycle ${d.deploymentCycle}, fix attempt ${d.fixAttempts}.\n`
      + `Error: ${d.error}\nStack: ${d.stack}\nHypothesis: ${d.rootCauseHypothesis || d.initialHypothesis}\n`
      + (d.deploymentCycle > 1 ? 'Production evidence: the first canary failed on an anonymous session with no expired flag. Include that case in this cycle.\n' : '')
      + instruction + '\nFinish by calling record_findings with the findings for this phase. Use the tools; do not just describe actions.' }, context)).wait(context);
    if (settled.status !== 'done') throw new Error(`Agent phase was not answered: ${settled.status}`);
  }
  async function unchangedCandidate(d: Incident) {
    return await protectedHash(repo) === d.protectedFilesHash
      && d.candidateHash === digest({ source: await codeHash(repo), tests: await testHash(repo) });
  }
  async function writeReport(d: Incident) {
    const report = `# Incident ${d.incidentId}\n\nStatus: **${d.status}**\n\n`
      + `Service: ${d.service}. Impact: ${d.usersAffected} affected users on ${d.route}.\n\n`
      + `## Cause\n\n${d.rootCause || d.rootCauseHypothesis || 'Not established.'}\n\n`
      + `## Fix\n\n${d.fixSummary || 'No verified fix.'}\n\n`
      + `## Verification\n\n${d.evidence.map(e => `- Cycle ${e.id.split(':')[1]}, ${e.kind}: ${e.result}; exit ${e.exitCode}; command: \`${e.command}\``).join('\n')}\n\n`
      + `## Deployment\n\nProduction: ${d.deployment.currentProductionVersion}. Traffic: ${JSON.stringify(d.deployment.versions)}. Health: ${d.deployment.healthy ? 'healthy' : 'unhealthy'}. Rollbacks: ${d.rollbackCount}.\n\n`
      + `${d.failure ? `Failure: ${d.failure}\n\n` : ''}## Changed files\n\n${d.changedFiles.map(f => `- ${f}`).join('\n') || 'None'}\n\n`
      + `Execution: ${d.executionMode}. Production and metrics are simulated.\n`;
    await mkdir(dataDir, { recursive: true });
    await writeFile(join(dataDir, 'incident-report.md.tmp'), report);
    await rename(join(dataDir, 'incident-report.md.tmp'), join(dataDir, 'incident-report.md'));
  }
  async function handle(task: Running, runtime: Runtime, context: Parameters<Runtime['sleep']>[1]) {
    contexts.set(runtime, context);
    try {
      let d = await read(runtime);
      const phase = task.state.checkpoint.phase;
      if (phase === 'DETECTED') {
        const hash = await protectedHash(repo);
        return await advance(runtime, 'TRIAGING', 'Incident received; triaging checkout', doc => { doc.protectedFilesHash = hash; });
      }
      if (phase === 'TRIAGING') {
        await ask(runtime, phase, 'Inspect the incident. Persist severity, suspectedArea="checkout", needsCodeChange and initialHypothesis. Do not edit files.');
        d = await read(runtime);
        if (!d.initialHypothesis || !d.suspectedArea || !d.needsCodeChange) return await fail(runtime, 'Triage did not identify an actionable code incident');
        return await advance(runtime, 'INVESTIGATING', 'Investigating checkout implementation');
      }
      if (phase === 'INVESTIGATING') {
        const source = await sourceSnapshot(repo);
        await runtime.commit(async tx => {
          const doc = await tx.doc(IncidentDoc, runtime.conversationId);
          if (!doc.cycleSourceHash) { doc.cycleSource = source; doc.cycleSourceHash = digest(source); }
          return undefined;
        }, context);
        await ask(runtime, phase, 'Use read and bash to inspect src/checkout.ts and existing tests. Do not edit files. Save rootCauseHypothesis, rootCause and relevantFiles. Contract: valid sessions return 200, expired or anonymous sessions return 401.');
        d = await read(runtime);
        if (!d.rootCauseHypothesis || !d.relevantFiles.length) return await fail(runtime, 'Investigation did not produce evidence');
        return await advance(runtime, 'REPRODUCING', 'Creating and running regression test');
      }
      if (phase === 'REPRODUCING') {
        await ask(runtime, phase, 'Create tests/incident.test.ts using node:test and node:assert/strict; import checkout from ../src/checkout.ts. Assert an expired session without user returns status 401. In cycle 2 also assert an anonymous session {} returns 401, preserving the original case. Change tests only. Call run_incident_tests(kind="red"). Do not fix source yet.');
        d = await read(runtime);
        if (d.verification.beforeFix !== 'FAIL' || await codeHash(repo) !== d.cycleSourceHash) return await fail(runtime, 'Incident was not reproduced with a genuine RED before changing source');
        return await advance(runtime, 'FIXING', 'Regression failed as expected; implementing smallest fix');
      }
      if (phase === 'FIXING') {
        const key = `attempt:${task.state.checkpoint.sequence}`;
        await runtime.commit(async tx => {
          const doc = await tx.doc(IncidentDoc, runtime.conversationId);
          if (doc.events.some(e => e.id === key)) return undefined;
          if (doc.fixAttempts >= 3) throw new Error('Three total fix attempts exhausted');
          doc.fixAttempts++; doc.verification.afterFix = 'PENDING'; doc.verification.relevantTests = 'PENDING';
          event(doc, key, `Fix attempt ${doc.fixAttempts} of 3`);
          return undefined;
        }, context);
        await ask(runtime, phase, 'Make the smallest source change for the reproduced failing test. Do not change tests, package files or unrelated code. Do not refactor. Save rootCause and a short fixSummary.');
        d = await read(runtime);
        const source = await sourceSnapshot(repo);
        const changed = [...new Set([...Object.keys(source), ...Object.keys(d.cycleSource)])].filter(f => source[f] !== d.cycleSource[f]);
        if (changed.some(f => f !== 'src/checkout.ts')) return await fail(runtime, 'Source changes exceeded the checkout incident scope');
        const red = d.evidence.findLast(e => e.kind === 'red' && e.id.startsWith(`${d.incidentId}:${d.deploymentCycle}:`));
        if (!red || await testHash(repo) !== red.testHash) return await fail(runtime, 'Regression test changed after RED');
        if (!changed.length || !d.fixSummary) {
          if (d.fixAttempts >= 3) return await fail(runtime, 'Three total fix attempts exhausted without a source fix');
          return await advance(runtime, 'FIXING', 'No source fix recorded; retrying');
        }
        return await advance(runtime, 'VERIFYING', 'Fix implemented; verifying locally', doc => {
          doc.changedFiles = [...new Set([...doc.changedFiles, ...changed, 'tests/incident.test.ts'])];
        });
      }
      if (phase === 'VERIFYING') {
        await ask(runtime, phase, 'Run run_incident_tests(kind="regression") and run_incident_tests(kind="component"). Do not edit any file. Persist findings only after both commands.');
        d = await read(runtime);
        const hash = await codeHash(repo); const th = await testHash(repo);
        const proofs = ['regression', 'component'].map(kind => d.evidence.findLast(e => e.kind === kind && e.id.startsWith(`${d.incidentId}:${d.deploymentCycle}:${d.fixAttempts}:`)));
        if (!proofs.every(e => e?.result === 'PASS' && e.sourceHash === hash && e.testHash === th)) {
          if (d.fixAttempts >= 3) return await fail(runtime, 'Local verification failed after three fix attempts');
          return await advance(runtime, 'FIXING', 'Verification failed; returning to fix');
        }
        const p = await simulator.create_rollback_point(`${d.incidentId}:${d.deploymentCycle}:prepare`, `v${d.deploymentCycle + 1}`, d.deploymentCycle);
        return await advance(runtime, 'AWAITING_DEPLOY_APPROVAL', 'Local verification passed; waiting for Deploy Canary', doc => {
          applyProduction(doc, p); doc.candidateHash = digest({ source: hash, tests: th });
        });
      }
      if (phase === 'AWAITING_DEPLOY_APPROVAL' || phase === 'AWAITING_PROMOTION_APPROVAL') {
        while (!d.gate?.approvedAt) {
          await runtime.sleep(runtime.now() + (options.pollMs ?? 500), context);
          d = await read(runtime);
        }
        if (d.gate.version !== d.deployment.candidateVersion || d.gate.consumedAt) throw new Error('Stale approval');
        if (!await unchangedCandidate(d)) return await fail(runtime, 'Verified candidate changed while waiting for approval');
        return await advance(runtime, phase === 'AWAITING_DEPLOY_APPROVAL' ? 'PREPARING_DEPLOYMENT' : 'PROMOTING', 'Human approval received', doc => {
          doc.gate!.consumedAt = new Date().toISOString();
          const receipt = doc.approvals.find(x => x.id === doc.gate!.id);
          if (receipt) receipt.consumedAt = doc.gate!.consumedAt;
        });
      }
      if (phase === 'PREPARING_DEPLOYMENT') {
        if (!await unchangedCandidate(d)) return await fail(runtime, 'Candidate changed before canary deployment');
        const p = await simulator.deploy_canary(`${d.incidentId}:${d.deploymentCycle}:deploy`, d.deployment.candidateVersion, 10);
        return await advance(runtime, 'CANARY_DEPLOYED', 'Canary deployed to 10%', doc => applyProduction(doc, p));
      }
      if (phase === 'CANARY_DEPLOYED') return await advance(runtime, 'OBSERVING', 'Observing simulated production traffic');
      if (phase === 'OBSERVING' || phase === 'FINAL_VERIFY') {
        await runtime.sleep(task.state.checkpoint.observeUntil, context);
        const health = await simulator.get_production_health();
        await runtime.commit(async tx => {
          const doc = await tx.doc(IncidentDoc, runtime.conversationId);
          Object.assign(doc.deployment, health);
          doc.deployment[phase === 'OBSERVING' ? 'canary' : 'production'] = health.healthy ? 'healthy' : 'unhealthy';
          event(doc, `health:${task.state.checkpoint.sequence}`, `${phase === 'OBSERVING' ? 'Canary' : 'Production'} ${health.healthy ? 'healthy' : 'unhealthy'}`);
          return undefined;
        }, context);
        if (!health.healthy) {
          if (d.rollbackCount >= 1 || d.deploymentCycle >= 2) return await fail(runtime, 'Deployment unhealthy; recovery limit reached (one rollback, two cycles)');
          return await advance(runtime, 'ROLLING_BACK', 'Production unhealthy; automatically rolling back');
        }
        if (phase === 'FINAL_VERIFY') return await advance(runtime, 'RESOLVED', 'Final production verification passed; incident resolved');
        return await advance(runtime, 'AWAITING_PROMOTION_APPROVAL', 'Canary healthy; waiting for Promote to 100%');
      }
      if (phase === 'PROMOTING') {
        if (!await unchangedCandidate(d)) return await fail(runtime, 'Candidate changed before promotion');
        const p = await simulator.promote_release(`${d.incidentId}:${d.deploymentCycle}:promote`, d.deployment.candidateVersion);
        return await advance(runtime, 'FINAL_VERIFY', 'Promoted to 100%; verifying production', doc => applyProduction(doc, p));
      }
      if (phase === 'ROLLING_BACK') {
        const key = `${d.incidentId}:${d.deploymentCycle}:rollback`;
        await runtime.commit(async tx => {
          const doc = await tx.doc(IncidentDoc, runtime.conversationId);
          if (doc.events.some(e => e.id === key)) return undefined;
          if (doc.rollbackCount >= 1) throw new Error('Rollback limit reached');
          doc.rollbackCount++; event(doc, key, 'Restoring rollback version');
          return undefined;
        }, context);
        const p = await simulator.rollback_release(key);
        const health = await simulator.get_production_health();
        await runtime.commit(async tx => {
          const doc = await tx.doc(IncidentDoc, runtime.conversationId); applyProduction(doc, p);
          event(doc, `${key}:verified`, health.healthy ? 'Baseline health restored' : 'Baseline remains unhealthy');
          return undefined;
        }, context);
        d = await read(runtime);
        if (!health.healthy || d.fixAttempts >= 3 || d.deploymentCycle >= 2) return await fail(runtime, 'Rollback completed; baseline unhealthy or retry budget exhausted');
        return await advance(runtime, 'INVESTIGATING', 'Baseline restored; investigating second and final candidate', doc => {
          doc.deploymentCycle++; doc.cycleSourceHash = ''; doc.cycleSource = {}; doc.candidateHash = '';
          doc.gate = null; doc.verification = { beforeFix: 'PENDING', afterFix: 'PENDING', relevantTests: 'PENDING' };
          doc.deployment.candidateVersion = `v${doc.deploymentCycle + 1}`; doc.fixSummary = '';
        });
      }
      if (terminal(phase)) {
        await writeReport(d);
        return await runtime.commit(() => ({ status: 'terminal', outcome: d.status === 'RESOLVED'
          ? { status: 'completed', result: null } : { status: 'failed', error: { message: d.failure } } }), context);
      }
      throw new Error(`Unhandled phase ${phase}`);
    } catch (error) {
      if (runtime.signal.aborted) throw error;
      const d = await read(runtime);
      if (terminal(d.status)) throw error;
      await fail(runtime, error instanceof Error ? error.message : String(error));
    }
  }
  const task = defineTask<Input, Checkpoint, null>({
    name: 'sre.incident', version: 1,
    initial: () => ({ phase: 'DETECTED', sequence: 0, observeUntil: 0 }),
    phases: Object.fromEntries(STATES.map(s => [s, handle])) as Record<Status, typeof handle>,
    abort: async (_task, runtime, context) => {
      await runtime.commit(async tx => {
        const d = await tx.doc(IncidentDoc, runtime.conversationId);
        d.status = 'FAILED'; d.failure = 'Incident task aborted'; event(d, 'abort', d.failure);
        return { status: 'terminal', outcome: { status: 'aborted' } };
      }, context);
    },
  });
  const simulatorTools = ['create_rollback_point', 'deploy_canary', 'get_production_health', 'promote_release', 'rollback_release'].map(name => defineTool({
    name, description: `Workflow-controlled production simulator operation: ${name}.`,
    parameters: Type.Object({}), callers: ['tools'], executionMode: 'sequential', replay: 'safe',
    execute: async (_args, api, context) => {
      const d = await api.snapshot(IncidentDoc, api.conversationId, context);
      if (!d) throw new Error('Missing incident');
      const key = `${d.incidentId}:${d.deploymentCycle}`;
      if (name === 'get_production_health') return { output: text(JSON.stringify(await simulator.get_production_health())) };
      const expected: Record<string, string> = { create_rollback_point: 'VERIFYING', deploy_canary: 'PREPARING_DEPLOYMENT', promote_release: 'PROMOTING', rollback_release: 'ROLLING_BACK' };
      if (d.status !== expected[name]) throw new Error('Simulator operation is not allowed in this phase');
      if (name === 'create_rollback_point') await simulator.create_rollback_point(`${key}:prepare`, `v${d.deploymentCycle + 1}`, d.deploymentCycle);
      if (name === 'deploy_canary') await simulator.deploy_canary(`${key}:deploy`, d.deployment.candidateVersion, 10);
      if (name === 'promote_release') await simulator.promote_release(`${key}:promote`, d.deployment.candidateVersion);
      if (name === 'rollback_release') await simulator.rollback_release(`${key}:rollback`);
      return { output: text('Simulator operation committed.') };
    },
  }));
  const extension = defineExtension({
    name: 'sre-demo', tasks: [task], tools: [findings, tests, ...simulatorTools],
    sections: [section('sre-policy', () => 'You are the coding agent for one local checkout incident. Use the existing Pi read/write/edit/bash tools. Investigate and execute real tests. Never invent results. Only edit src/checkout.ts and tests/incident.test.ts in this demo. Never edit the component tests, package.json, the harness or .demo files. Make the smallest fix for the reproduced case. No refactoring, dependencies, network calls, subagents or deployment from shell. Deployments are controlled by the durable workflow after human approval.')],
  });
  return { task, extension };
}
