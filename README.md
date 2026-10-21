# Pi Durable SRE Agent

A single local incident, owned by a real task in the official `@earendil-works/pi-durable@1.3.0` SDK. The agent reads and edits a real checkout repository and executes real regression/component tests. Production traffic, health and deployment are explicitly simulated. One Node process serves the API and the page; Pi's JSONL storage persists the incident without a database.

## Run

Requires **Node.js 24**, npm, Bash and a ChatGPT subscription with access to the selected model. No OpenAI API key is required. The agent's shell runs locally with your process permissions; run this intentionally small demo in a disposable workspace.

```bash
git clone https://github.com/GIFO14/Pi-Durable-SRE-Agent.git
cd Pi-Durable-SRE-Agent
npm install
cp .env.example .env
# If Codex is already signed in with ChatGPT, its active session is reused.
# Otherwise, sign in once using the browser:
npm run auth:login
npm run dev
```

On Windows, `./start.ps1` starts the server and selects Node 24 from PATH or the installed Codex runtime. `./start.ps1 -Login` opens ChatGPT sign-in when needed. It selects Git Bash when installed in its standard location; otherwise set `SRE_BASH` in `.env`.

Open **http://127.0.0.1:3000**. Click **Inject incident**, or run `npm run incident`. An empty POST body object to `/api/incident` loads the included Sentry fixture. The server can display the UI without a session; incident injection returns 503 until ChatGPT is connected and the server restarted. The server never substitutes scripted responses for a real model.

The model must create `demo-repo/tests/incident.test.ts`, reproduce the expired-session bug, fix `src/checkout.ts`, and pass both test commands before the **Deploy Canary** button appears. That button approves the 10% rollout. A healthy canary then waits for **Promote to 100%**. Final production health must be healthy before resolution. Command output, hypothesis, files and activity are visible in the page; the final report can be downloaded there.

Defaults: `SRE_MODEL=gpt-6.1-sol`, `SRE_PORT=3000`, `SRE_OBSERVE_MS=8000`. Choose a model your ChatGPT account can use. Set the port in both the server environment and the `npm run incident` environment if changing it. The main server reads `.env`; no credentials are sent to the browser or persisted in incident state.

### ChatGPT authentication

This repository contains no account credentials or linked subscription. Each user signs in with their own ChatGPT account, or reuses their own locally authenticated Codex session. Login files, local incident state, reports and command logs are excluded from Git.

`npm run auth:login` uses Pi AI 1.3.0's built-in **Sign in with ChatGPT** OAuth flow on the `openai` provider. Credentials are saved in the ignored `.auth/auth.json`, separately from incident storage, with locked, atomic updates for automatic token renewal. `.auth/device-id` keeps the installation ID stable. Resetting the demo preserves the login. Keep `.auth/` private; it contains session credentials.

When no app-owned session exists, the demo can reuse an active ChatGPT session from `~/.codex/auth.json` (or `$CODEX_HOME/auth.json`) through Pi's `openai-codex` provider. That integration reads the current access token for every request. Codex continues to own renewal: the demo never copies its refresh token or modifies its credentials. If that cached session expires, renew it in Codex, or use `npm run auth:login` and restart for an independent, automatically renewed demo session. OS-keychain-only Codex logins require the independent sign-in.

The demo disables environment API-key lookup, including when `OPENAI_API_KEY` happens to be set. Model calls use ChatGPT plan access and its applicable usage limits. See [OpenAI authentication](https://learn.chatgpt.com/docs/auth) and [ChatGPT plan usage for local applications](https://developers.openai.com/siwc/token-sharing-open-source).

## Restart demonstration

1. Inject `INC-001` and wait for **Awaiting deploy approval**.
2. Note the task ID in the footer. Stop with Ctrl+C.
3. Run `npm run dev` again. The same incident, evidence, task ID and approval gate reappear.
4. Approve the canary, then repeat the restart at the promotion gate if desired.

Reinjection of the same incident returns its original task ID, including after resolution/failure. A different incident is rejected because the page supports only one demo incident. Pi resumes the existing task; the workflow deduplicates model submissions by phase/attempt, and simulator operations by incident/cycle/action. An interrupted shell call is not automatically treated as successful or replay-safe.

Pi 1.3.0 has `runtime.sleep()`, not the `sleepUntil()` API on newer upstream `main`. Human approval and the phase checkpoint are persisted; an invocation's polling timer is recreated after restart. Observation deadlines are stored in the checkpoint. All definitions and tools are registered before `harness.resume()`.

## Rollback scenario

With the server stopped, reset, set `SRE_SCENARIO=rollback-once` in `.env`, then start again:

```bash
npm run demo:reset
npm run dev
```

The first canary is unhealthy despite passing local tests. The workflow automatically restores baseline, verifies its health, and investigates a second concrete case: an anonymous session without an `expired` flag. The agent must add that regression, reproduce it and make a second real fix. The second candidate is `v3` and requires fresh deploy/promotion approvals. If the first agent fix already covers this second case, the second reproduction cannot establish RED and the incident stops; it never fabricates a fix for the video. For a repeatable dramatic recording, keep the first fix minimal to the reproduced expired-session incident.

Limits: **3 total fix attempts, 1 rollback, 2 deployment cycles**. A second unhealthy canary ends `FAILED`. The specification conflicts on final health failure after an earlier rollback; this implementation gives priority to the one-rollback limit and ends `FAILED`, showing the actual remaining traffic/health rather than claiming recovery. Failure-injection scenarios `second-canary-fails`, `second-final-fails`, `final-fails` and `baseline-fails` exist for automated checks.

Scenario, repository path and real/scripted execution mode are persisted and cannot silently change on reopen. The `owner.lock` prevents concurrent processes using the same storage. A stale lock left by SIGKILL is reclaimed only when its PID no longer exists.

## Tests

```bash
npm run typecheck
npm test
```

The tests use Pi AI's **official faux provider**, Pi Durable's **real JSONL storage**, its task scheduler and **real CodingTools**. Scripted tool calls write actual files and run actual Node tests. This exercises workflow control and recovery; it is not evidence of LLM reasoning. There is no public flag to enable a scripted model in the normal server.

Tests cover RED gating, setup failures, three failed fixes, duplicate triggers/approvals, candidate changes, healthy promotion, bounded rollback, both approval gates across reopen, lost-response approval recovery, deployment effects before checkpoints, SIGKILL recovery, reset/reinjection and authentication preservation. Test workspaces are temporary; the checked-in buggy repository remains unchanged.

The simulator can also be tested before installing SDK dependencies:

```bash
node --test --test-isolation=none tests/deployment-simulator.test.ts
```

A real-model pass with your ChatGPT session is necessary to validate the video scenario end to end. A green scripted test suite alone does not establish model behavior.

The authentication tests also check that an environment API key cannot enable execution, that Codex credentials are re-read without modification, and that independent OAuth updates persist under a lock.

Verified on Windows on 2026-10-21: TypeScript checking, all **27 automated tests**, and JavaScript syntax checking passed. A real `gpt-6.1-sol` run through ChatGPT authentication completed RED reproduction, GREEN regression/component tests, simulated canary and promotion, healthy final verification, and a downloadable `RESOLVED` report. Browser checks also covered selecting historical steps, following live progress, approval controls, mobile layout and separate visits after rollback. Automated test providers remain explicitly labeled and separate from real-model execution.

## Local endpoints and files

- `GET /api/state`: committed incident, configuration readiness and diagnostic messages.
- `POST /api/incident`: a supplied incident or `{}` for the fixture.
- `POST /api/approval`: `{ "incidentId": "INC-001", "gateId": "…", "action": "deploy" }` (or `promote`). Stale gates return 409; duplicate requests have no extra effect.
- `GET /api/report`: generated Markdown report after the workflow finishes.
- `POST /api/reset`: `{ "confirm": true }` stops the runtime, restores the original bug, clears demo history/evidence and opens a fresh runtime on the same port. ChatGPT authentication is preserved.
- `.demo/pi-session/`: official Pi JSONL storage, including conversation and task records.
- `.demo/production-state.json`: simulator versions, health and operation receipts.
- `.demo/incident-report.md`: generated report, including execution mode and all test results.

**Recording reset:** hover over **Local workspace** at the bottom of the sidebar, open the discreet **⋯** menu, and choose **Reset simulation**. Confirm to stop the current task, clear the incident/history/report and simulated production state, remove the generated regression test, and restore the original checkout bug. The page returns to **Inject incident**; your ChatGPT sign-in stays connected. The control is hidden until hover or keyboard focus (subtle and visible on touch devices).

Alternatively, `npm run demo:reset` performs the same file reset with the server stopped. Resetting discards the current demo run; it does not provide an undo history.

The page uses plain HTML/CSS/JS, polling once per second. It never advances a workflow locally. Deployment and promotion buttons only record backend approvals. If the backend disconnects, the last state remains visible and controls are disabled.

Primary SDK source: [official Pi Durable v1.3.0](https://github.com/earendil-works/pi/tree/v1.3.0/packages/durable).

## Interface

The workspace retains Plane's light interface, with one incident and its sequential execution timeline. Four compact stage summaries provide orientation; individual steps are selectable rows rather than incident-like Kanban cards. The right panel follows the current step until another step is selected. **Follow current step** resumes live following. Historical visits remain selectable during retries and rollback cycles.

Each new step visit persists its own findings, file references, test-evidence IDs, approval and production snapshot. Viewing an older step does not replace its data with current production metrics. Incidents created before step snapshots existed retain their recorded events and tests; missing historical findings are labeled as unavailable. Workflow, Evidence, Activity and Production tabs share the same incident. Production contains the explicitly live incident overview, separate from the selected step's history. This backend still supports one demo incident at a time.

The sidebar collapses, tabs support arrow-key navigation, and the theme toggle remembers a local light/dark preference. The visual reference remains Plane commit `2f895b82dad839c730c36a5c0cbc046f1e5d6b56`.

Inter and Lucide assets are served locally; licenses are under `public/fonts/` and `public/icons/`.
