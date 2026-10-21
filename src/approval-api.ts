import { IncidentDoc, event } from './incident-state.ts';
import type { AppRuntime } from './pi-runtime.ts';
export async function approve(app: AppRuntime, input: unknown) {
  if (!input || typeof input !== 'object') throw Object.assign(new Error('Expected approval object'), { statusCode: 400 });
  const { incidentId, gateId, action } = input as Record<string, unknown>;
  if (typeof incidentId !== 'string' || typeof gateId !== 'string' || !['deploy', 'promote'].includes(String(action)))
    throw Object.assign(new Error('Expected incidentId, gateId, and deploy/promote action'), { statusCode: 400 });
  return app.root.commit(async tx => {
    const d = await tx.doc(IncidentDoc, app.root.id);
    const conflict = () => { throw Object.assign(new Error('Approval does not match the current incident, cycle and gate'), { statusCode: 409 }); };
    if (!d.incidentId || d.incidentId !== incidentId || d.gate?.id !== gateId || d.gate.action !== action) return conflict();
    // Retrying the same receipt after consumption has no further effects.
    if (d.gate.approvedAt) return { approved: true, gateId, duplicate: true };
    const expected = action === 'deploy' ? 'AWAITING_DEPLOY_APPROVAL' : 'AWAITING_PROMOTION_APPROVAL';
    if (d.status !== expected || d.gate.version !== d.deployment.candidateVersion) return conflict();
    d.gate.approvedAt = new Date().toISOString();
    d.approvals.push({ ...d.gate });
    event(d, `approval:${gateId}`, `Human approved ${action === 'deploy' ? '10% canary' : '100% promotion'}`);
    return { approved: true, gateId, duplicate: false };
  }, app.context);
}
