import { IncidentDoc, STATES } from './incident-state.ts';
import type { AppRuntime } from './pi-runtime.ts';
export async function uiState(app: AppRuntime) {
  const d = await app.harness.snapshot(IncidentDoc, app.root.id, app.context);
  return {
    incident: d?.incidentId ? d : null, states: STATES,
    configuration: { ready: app.canRun, model: app.model, scenario: app.simulator.scenario, executionMode: app.executionMode },
    diagnostics: [...app.diagnostics],
  };
}
