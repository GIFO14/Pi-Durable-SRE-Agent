import { IncidentDoc, emptyIncident, event } from './incident-state.ts';
import type { AppRuntime } from './pi-runtime.ts';
export type IncidentInput = { id: string; service: string; severity: string; error: string; route: string; stack: string; usersAffected: number };
export function validateIncident(value: unknown): asserts value is IncidentInput {
  if (!value || typeof value !== 'object') throw new Error('Expected incident object');
  const d = value as Record<string, unknown>;
  for (const key of ['id', 'service', 'severity', 'error', 'route', 'stack']) {
    if (typeof d[key] !== 'string' || !(d[key] as string).length || (d[key] as string).length > 10000) throw new Error(`Invalid incident ${key}`);
  }
  if (!/^[A-Za-z0-9_-]{1,80}$/.test(d.id as string)) throw new Error('Invalid incident ID');
  if (d.service !== 'checkout-api' || d.route !== '/api/checkout') throw new Error('This demo only supports checkout-api /api/checkout');
  if (!Number.isSafeInteger(d.usersAffected) || (d.usersAffected as number) < 0) throw new Error('Invalid usersAffected');
}
export async function receiveIncident(app: AppRuntime, input: unknown) {
  validateIncident(input);
  if (!app.canRun) throw Object.assign(new Error('Sign in with ChatGPT using npm run auth:login, then restart the server.'), { statusCode: 503 });
  const result = await app.root.commit(async tx => {
    const d = await tx.doc(IncidentDoc, app.root.id);
    if (d.incidentId) {
      if (d.incidentId !== input.id) throw Object.assign(new Error('One demo incident is already active'), { statusCode: 409 });
      return { incidentId: d.incidentId, taskId: d.workflowTaskId, resumed: true };
    }
    Object.assign(d, emptyIncident(), {
      incidentId: input.id, service: input.service, severity: input.severity, error: input.error,
      route: input.route, stack: input.stack, usersAffected: input.usersAffected,
      scenario: app.simulator.scenario, executionMode: app.executionMode, startedAt: new Date().toISOString(),
    });
    const id = await tx.createTask(app.workflow.task, { incidentId: input.id }, { ownership: { kind: 'conversation' }, background: true });
    d.workflowTaskId = id; event(d, 'received', 'Simulated Sentry incident received');
    return { incidentId: d.incidentId, taskId: id, resumed: false };
  }, app.context);
  app.harness.resume();
  return result;
}
