import { readFile, rm, writeFile } from 'node:fs/promises';
import { resolve, parse, relative, isAbsolute } from 'node:path';

export const originalCheckout = `// Contract: valid sessions return 200; expired or anonymous sessions return 401.
export function checkout(session: { expired?: boolean; user?: { id: string } }) {
  const userId = session.user!.id;
  if (session.expired) return { status: 401, error: 'Session expired' };
  return { status: 200, userId };
}
`;

// Both callers stop the runtime first. Authentication lives outside these paths.
export async function resetDemoFiles(dataPath = '.demo', repoPath = 'demo-repo') {
  const dataDir = resolve(dataPath), repo = resolve(repoPath);
  const contains = (parent: string, child: string) => {
    const path = relative(parent, child);
    return !path || (!path.startsWith('..') && !isAbsolute(path));
  };
  if (dataDir === parse(dataDir).root || contains(dataDir, repo) || contains(repo, dataDir)) {
    throw new Error('Demo state and repository must be separate directories.');
  }
  try {
    const pid = Number(await readFile(`${dataDir}/owner.lock`, 'utf8'));
    if (!Number.isInteger(pid) || pid <= 0) throw new Error('Invalid owner.lock. Check the server is stopped.');
    try { process.kill(pid, 0); throw new Error('Stop the demo server before resetting.'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; }
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  // Check the demo repository exists before removing saved progress.
  await readFile(`${repo}/src/checkout.ts`);
  await rm(dataDir, { recursive: true, force: true });
  await rm(`${repo}/tests/incident.test.ts`, { force: true });
  await rm(`${repo}/.sre-evidence`, { recursive: true, force: true });
  await writeFile(`${repo}/src/checkout.ts`, originalCheckout);
}
