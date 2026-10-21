import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
export type Health = { errorRate: number; latencyP95: number; healthy: boolean };
export type Production = {
  currentProductionVersion: string; candidateVersion: string; rollbackVersion: string;
  versions: Record<string, number>; canaryPercentage: number; stage: string;
  cycle: number; health: Health; operations: Record<string, string>;
};
export class DeploymentSimulator {
  private queue: Promise<unknown> = Promise.resolve();
  readonly path: string;
  readonly scenario: string;
  constructor(path: string, scenario: string) {
    this.path = path; this.scenario = scenario;
    if (!['healthy', 'rollback-once', 'second-canary-fails', 'final-fails', 'second-final-fails', 'baseline-fails'].includes(scenario)) throw new Error('Unknown production scenario');
  }
  async read(): Promise<Production> {
    try { return JSON.parse(await readFile(this.path, 'utf8')); }
    catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
      return { currentProductionVersion: 'v1', candidateVersion: 'v2', rollbackVersion: 'v1',
        versions: { v1: 100 }, canaryPercentage: 0, stage: 'DETECTED', cycle: 1,
        health: { errorRate: 0.01, latencyP95: 220, healthy: true }, operations: {} };
    }
  }
  private mutate(key: string, signature: string, change: (d: Production) => void) {
    const work = this.queue.then(async () => {
      const d = await this.read();
      if (d.operations[key]) {
        if (d.operations[key] !== signature) throw new Error('Operation key reused with different arguments');
        return d;
      }
      change(d); d.operations[key] = signature;
      await mkdir(dirname(this.path), { recursive: true });
      await writeFile(`${this.path}.tmp`, `${JSON.stringify(d, null, 2)}\n`);
      await rename(`${this.path}.tmp`, this.path);
      return d;
    });
    this.queue = work.catch(() => {});
    return work;
  }
  create_rollback_point(key: string, version: string, cycle: number) {
    return this.mutate(key, `prepare:${version}:${cycle}`, d => {
      d.rollbackVersion = d.currentProductionVersion; d.candidateVersion = version; d.cycle = cycle;
      d.stage = 'AWAITING_DEPLOY_APPROVAL';
    });
  }
  deploy_canary(key: string, version: string, percentage: number) {
    if (percentage !== 10 && percentage !== 100) throw new Error('Only 10% or 100% are supported');
    return this.mutate(key, `deploy:${version}:${percentage}`, d => {
      if (d.candidateVersion !== version) throw new Error('Wrong candidate');
      d.versions = { [d.rollbackVersion]: 100 - percentage, [version]: percentage };
      d.canaryPercentage = percentage; d.stage = 'CANARY_DEPLOYED';
      const bad = d.cycle === 1 && ['rollback-once', 'second-canary-fails', 'second-final-fails', 'baseline-fails'].includes(this.scenario)
        || d.cycle === 2 && this.scenario === 'second-canary-fails';
      d.health = bad ? { errorRate: 0.16, latencyP95: 980, healthy: false } : { errorRate: 0.01, latencyP95: 220, healthy: true };
    });
  }
  async get_production_health(): Promise<Health> { return { ...(await this.read()).health }; }
  promote_release(key: string, version: string) {
    return this.mutate(key, `promote:${version}`, d => {
      if (d.candidateVersion !== version || !d.health.healthy || d.canaryPercentage !== 10) throw new Error('No healthy canary to promote');
      d.currentProductionVersion = version; d.versions = { [d.rollbackVersion]: 0, [version]: 100 };
      d.canaryPercentage = 100; d.stage = 'PROMOTING';
      if (this.scenario === 'final-fails' || this.scenario === 'second-final-fails' && d.cycle === 2)
        d.health = { errorRate: 0.12, latencyP95: 840, healthy: false };
    });
  }
  rollback_release(key: string) {
    return this.mutate(key, 'rollback', d => {
      d.currentProductionVersion = d.rollbackVersion;
      d.versions = { [d.candidateVersion]: 0, [d.rollbackVersion]: 100 };
      d.canaryPercentage = 0; d.stage = 'ROLLING_BACK';
      d.health = this.scenario === 'baseline-fails'
        ? { errorRate: 0.08, latencyP95: 650, healthy: false }
        : { errorRate: 0.01, latencyP95: 220, healthy: true };
    });
  }
}
