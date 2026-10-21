import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { chatGPTModels } from './chatgpt-auth.ts';
import type { Models } from '@earendil-works/pi-ai';
import { createRegistry, Harness } from '@earendil-works/pi-durable';
import { CodingTools } from '@earendil-works/pi-durable/tools';
import { NodeExecutionEnv } from '@earendil-works/pi-durable/env/node';
import { openNodeJsonlStorage } from '@earendil-works/pi-durable/storage/jsonl/node';
import { mkdir, open, readFile, unlink } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { createWorkflow } from './sre-workflow.ts';
import { DeploymentSimulator } from './deployment-simulator.ts';
import { IncidentDoc } from './incident-state.ts';

export type RuntimeOptions = {
  dataDir?: string; repo?: string; scenario?: string; observeMs?: number; pollMs?: number;
  models?: Models; model?: { provider: string; modelId: string };
};
export async function lockDataDirectory(dataDir: string) {
  await mkdir(dataDir, { recursive: true });
  const path = join(dataDir, 'owner.lock');
  try {
    const handle = await open(path, 'wx');
    await handle.writeFile(String(process.pid)); await handle.close();
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
    const pid = Number(await readFile(path, 'utf8'));
    if (!Number.isInteger(pid) || pid <= 0) throw new Error('Invalid owner.lock; check no demo is running before removing it');
    try { process.kill(pid, 0); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
      await unlink(path);
      return lockDataDirectory(dataDir);
    }
    throw new Error(`Demo storage is already owned by process ${pid}`);
  }
  return async () => { await unlink(path).catch(() => {}); };
}
export async function openRuntime(options: RuntimeOptions = {}) {
  const context = BACKGROUND_CONTEXT;
  const dataDir = resolve(options.dataDir ?? '.demo');
  const repo = resolve(options.repo ?? 'demo-repo');
  const releaseLock = await lockDataDirectory(dataDir);
  try {
    const scenario = options.scenario ?? process.env.SRE_SCENARIO ?? 'healthy';
    const configurationPath = join(dataDir, 'configuration.json');
    const configuration = { repo, scenario, executionMode: options.models ? 'scripted-test' : 'real' };
    try {
      const saved = JSON.parse(await readFile(configurationPath, 'utf8'));
      if (JSON.stringify(saved) !== JSON.stringify(configuration)) throw new Error('Demo configuration changed. Restore the original scenario/repository/mode or reset with the server stopped.');
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
      const file = await open(configurationPath, 'wx');
      await file.writeFile(`${JSON.stringify(configuration)}\n`); await file.close();
    }
    const simulator = new DeploymentSimulator(join(dataDir, 'production-state.json'), scenario);
    const observeMs = options.observeMs ?? Number(process.env.SRE_OBSERVE_MS ?? 8000);
    if (!Number.isFinite(observeMs) || observeMs < 0 || observeMs > 300000) throw new Error('SRE_OBSERVE_MS must be between 0 and 300000');
    const chatgpt = options.models ? undefined : await chatGPTModels();
    const models = options.models ?? chatgpt!.models;
    const workflow = createWorkflow({ repo, dataDir, simulator, observeMs, pollMs: options.pollMs });
    const registry = createRegistry(); registry.install(CodingTools); registry.install(workflow.extension);
    const diagnostics: string[] = [];
    const storage = await openNodeJsonlStorage(join(dataDir, 'pi-session'), context, { fsync: true });
    const harness = await Harness.open(storage, {
      models, registry, env: () => new NodeExecutionEnv({ cwd: repo, shellPath: process.env.SRE_BASH }),
      settings: { toolExecution: 'sequential' },
      onReport: error => {
        const message = error instanceof Error ? error.message : String(error);
        diagnostics.push(message); if (diagnostics.length > 10) diagnostics.shift();
        console.error(message);
      },
    }, context);
    const model = options.model ?? { provider: chatgpt!.provider, modelId: process.env.SRE_MODEL ?? 'gpt-6.1-sol' };
    const root = await harness.root(context, { agent: { model, cwd: repo } });
    await root.configure({ model, cwd: repo }, context);
    await root.commit(async tx => { await tx.doc(IncidentDoc, root.id); }, context);
    // All definitions and capabilities are installed before resuming pending tasks.
    harness.resume();
    let closed = false;
    return {
      context, dataDir, repo, simulator, harness, root, workflow, diagnostics, model,
      executionMode: configuration.executionMode,
      canRun: !!options.models || !!chatgpt?.ready,
      async close() {
        if (closed) return; closed = true;
        try { await harness.close(context); } finally { await releaseLock(); }
      },
    };
  } catch (error) { await releaseLock(); throw error; }
}
export type AppRuntime = Awaited<ReturnType<typeof openRuntime>>;
