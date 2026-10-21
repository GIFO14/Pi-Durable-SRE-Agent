import { openRuntime } from '../src/pi-runtime.ts';
import { receiveIncident } from '../src/incident-trigger.ts';
import { fakeModel, incident, waitStatus } from './helpers.ts';
const app = await openRuntime({ repo: process.argv[2], dataDir: process.argv[3], scenario: 'healthy', observeMs: 10, pollMs: 10, ...fakeModel() });
await receiveIncident(app, incident);
const d = await waitStatus(app, 'AWAITING_DEPLOY_APPROVAL');
process.send!({ taskId: d.workflowTaskId, gateId: d.gate!.id });
