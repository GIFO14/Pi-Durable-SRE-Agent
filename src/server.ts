import { createServer } from 'node:http';
import type { IncomingMessage } from 'node:http';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { openRuntime } from './pi-runtime.ts';
import type { RuntimeOptions } from './pi-runtime.ts';
import { receiveIncident } from './incident-trigger.ts';
import { approve } from './approval-api.ts';
import { uiState } from './ui-state-api.ts';
import { resetDemoFiles } from './demo-reset.ts';

async function jsonBody(req: IncomingMessage) {
  let text = '';
  for await (const chunk of req) {
    text += chunk;
    if (Buffer.byteLength(text) > 32000) throw Object.assign(new Error('Request body too large'), { statusCode: 413 });
  }
  try { return JSON.parse(text); } catch { throw Object.assign(new Error('Invalid JSON body'), { statusCode: 400 }); }
}
export async function startServer(options: RuntimeOptions & { port?: number; listen?: boolean } = {}) {
  let app = await openRuntime(options);
  let resetting = false, resetFailed = false;
  let resetTask: Promise<void> | undefined;
  const assets: Record<string, [string, string]> = {
    '/': ['index.html', 'text/html; charset=utf-8'], '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
    '/styles.css': ['styles.css', 'text/css; charset=utf-8'],
    '/step-data.js': ['step-data.js', 'text/javascript; charset=utf-8'],
    '/step-view.js': ['step-view.js', 'text/javascript; charset=utf-8'],
    '/demo-controls.js': ['demo-controls.js', 'text/javascript; charset=utf-8'],
    '/icons/ellipsis.svg': ['icons/ellipsis.svg', 'image/svg+xml'],
    '/fonts/inter-latin.woff2': ['fonts/inter-latin.woff2', 'font/woff2'],
  };
  for (const name of ['layers','panel-left','chevron-down','chevron-right','plus','search','circle','circle-dot','circle-check','clock-3','activity','shield-check','flask-conical','file-code-2','git-branch','arrow-up-right','arrow-right','arrow-up','play','rocket','rotate-ccw','check','triangle-alert','x','moon','sun','list','columns-3','server','box','chevrons-up','workflow','terminal','circle-help','check-check','zap','loader-circle']) {
    assets[`/icons/${name}.svg`] = [`icons/${name}.svg`, 'image/svg+xml'];
  }
  const handle = async (req: IncomingMessage, res: import('node:http').ServerResponse) => {
    const send = (code: number, body: unknown) => {
      res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify(body));
    };
    try {
      const path = new URL(req.url ?? '/', 'http://localhost').pathname;
      if (path.startsWith('/api/') && resetting) return send(409, { error: 'Resetting the simulation. Please wait.' });
      if (path.startsWith('/api/') && resetFailed && path !== '/api/reset') return send(503, { error: 'Reset did not finish. Retry Reset simulation.' });
      if (req.method === 'POST') {
        const origin = req.headers.origin;
        const address = server.address();
        const port = typeof address === 'object' && address ? address.port : options.port ?? 3000;
        if (origin && ![`http://localhost:${port}`, `http://127.0.0.1:${port}`].includes(origin)) return send(403, { error: 'Use the local demo page' });
        if (req.headers['content-type']?.split(';')[0] !== 'application/json') return send(415, { error: 'Expected application/json' });
        if (path === '/api/reset') {
          const body = await jsonBody(req);
          if (body?.confirm !== true) return send(400, { error: 'Confirm the simulation reset.' });
          if (resetting) return send(409, { error: 'Reset already in progress.' });
          resetting = true;
          const { dataDir, repo } = app;
          resetTask = (async () => {
            await app.close();
            await resetDemoFiles(dataDir, repo);
            app = await openRuntime({ ...options, dataDir, repo });
          })();
          try { await resetTask; resetFailed = false; }
          catch (error) { resetFailed = true; throw error; }
          finally { resetting = false; }
          return send(200, { reset: true });
        }
        if (path === '/api/incident') {
          const body = await jsonBody(req);
          if (resetting || resetFailed) return send(409, { error: 'Wait for the simulation reset to finish.' });
          const incident = body && typeof body === 'object' && Object.keys(body).length === 0
            ? JSON.parse(await readFile(new URL('../fixtures/simulated-sentry-event.json', import.meta.url), 'utf8')) : body;
          return send(200, await receiveIncident(app, incident));
        }
        if (path === '/api/approval') {
          const body = await jsonBody(req);
          if (resetting || resetFailed) return send(409, { error: 'Wait for the simulation reset to finish.' });
          return send(200, await approve(app, body));
        }
      }
      if (req.method === 'GET' && path === '/api/state') return send(200, await uiState(app));
      if (req.method === 'GET' && path === '/api/report') {
        try {
          const body = await readFile(`${app.dataDir}/incident-report.md`);
          res.writeHead(200, { 'Content-Type': 'text/markdown; charset=utf-8', 'Content-Disposition': 'attachment; filename="incident-report.md"' });
          return res.end(body);
        } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return send(404, { error: 'Report not generated yet' }); throw e; }
      }
      if (req.method === 'GET' && assets[path]) {
        const [file, type] = assets[path];
        const body = await readFile(new URL(`../public/${file}`, import.meta.url));
        res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
        return res.end(body);
      }
      send(404, { error: 'Not found' });
    } catch (error) {
      const e = error as Error & { statusCode?: number };
      send(e.statusCode ?? 400, { error: e.message });
    }
  };
  const server = createServer(handle);
  try {
    if (options.listen !== false) await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      const ready = () => {
        server.removeListener('error', reject); resolve();
      };
      server.listen(options.port ?? Number(process.env.SRE_PORT ?? 3000), '127.0.0.1', ready);
    });
  } catch (e) { await app.close(); throw e; }
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : options.port ?? 3000;
  return { get app() { return app; }, server, handle, port, async close() {
    if (server.listening) await new Promise<void>((resolve, reject) => { server.close(e => e ? reject(e) : resolve()); server.closeAllConnections(); });
    await resetTask?.catch(() => {});
    await app.close();
  } };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const running = await startServer();
  console.log(`Pi Durable SRE demo: http://127.0.0.1:${running.port}`);
  if (!running.app.canRun) console.log('Sign in with ChatGPT using npm run auth:login, then restart before injecting an incident.');
  let stopping = false;
  for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, async () => {
    if (stopping) return; stopping = true;
    await running.close(); process.exitCode = 0;
  });
}
