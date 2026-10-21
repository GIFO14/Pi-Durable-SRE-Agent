import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import lockfile from 'proper-lockfile';
import { createModels } from '@earendil-works/pi-ai/models';
import { openaiProvider } from '@earendil-works/pi-ai/providers/openai';
import { openaiCodexProvider } from '@earendil-works/pi-ai/providers/openai-codex';
import type { AuthOperationOptions, Credential, CredentialStore } from '@earendil-works/pi-ai';

export const LOGIN_MESSAGE = 'Sign in with ChatGPT using npm run auth:login, then restart the server. An active Codex ChatGPT session is also supported.';
async function readJson(path: string) {
  try { return JSON.parse(await readFile(path, 'utf8')); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {}; throw error; }
}

// App-owned OAuth tokens stay outside durable conversation/incident storage.
export class ChatGPTCredentials implements CredentialStore {
  readonly path: string;
  readonly codexPath: string;
  constructor(options: { path?: string; codexPath?: string } = {}) {
    this.path = resolve(options.path ?? '.auth/auth.json');
    this.codexPath = options.codexPath ?? join(process.env.CODEX_HOME ?? join(homedir(), '.codex'), 'auth.json');
  }
  async read(providerId: string, options?: AuthOperationOptions): Promise<Credential | undefined> {
    options?.signal?.throwIfAborted();
    if (providerId === 'openai') {
      const credential = (await readJson(this.path)).openai;
      // Never fall back to API billing, even if OPENAI_API_KEY is set.
      if (credential && credential.type !== 'oauth') throw new Error(LOGIN_MESSAGE);
      return credential;
    }
    if (providerId !== 'openai-codex') return undefined;
    const saved = await readJson(this.codexPath);
    if (saved.auth_mode !== 'chatgpt' || !saved.tokens?.access_token) return undefined;
    const claims = JSON.parse(Buffer.from(saved.tokens.access_token.split('.')[1], 'base64url').toString('utf8'));
    const expires = Number(claims.exp) * 1000 - 60_000;
    if (!Number.isFinite(expires) || expires <= Date.now()) return undefined;
    return { type: 'oauth', access: saved.tokens.access_token, refresh: '', expires, accountId: saved.tokens.account_id };
  }
  async list(options?: AuthOperationOptions) {
    const result: { providerId: string; type: Credential['type'] }[] = [];
    for (const providerId of ['openai', 'openai-codex']) if (await this.read(providerId, options)) result.push({ providerId, type: 'oauth' });
    return result;
  }
  async update(fn: (saved: Record<string, Credential>) => Promise<void>, options?: AuthOperationOptions) {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    const release = await lockfile.lock(this.path, { realpath: false, retries: { retries: 30, minTimeout: 100, maxTimeout: 500 } });
    try {
      options?.signal?.throwIfAborted();
      const saved = await readJson(this.path);
      await fn(saved);
      const temporary = `${this.path}.${randomUUID()}.tmp`;
      await writeFile(temporary, `${JSON.stringify(saved)}\n`, { mode: 0o600 });
      await rename(temporary, this.path);
    } finally { await release(); }
  }
  async modify(providerId: string, fn: (current: Credential | undefined) => Promise<Credential | undefined>, options?: AuthOperationOptions) {
    // Codex owns its session and refresh-token rotation. Re-read its current access
    // token on every request; never copy, refresh, or overwrite Codex credentials.
    if (providerId !== 'openai') throw new Error(`Codex must renew its session. ${LOGIN_MESSAGE}`);
    let result: Credential | undefined;
    await this.update(async saved => {
      result = await fn(saved[providerId]) ?? saved[providerId];
      if (result) saved[providerId] = result;
    }, options);
    return result;
  }
  async delete(providerId: string, options?: AuthOperationOptions) {
    if (providerId !== 'openai') throw new Error('Manage the Codex session from Codex.');
    await this.update(async saved => { delete saved[providerId]; }, options);
  }
}

export async function chatGPTModels(credentials = new ChatGPTCredentials()) {
  const provider = await credentials.read('openai') ? 'openai'
    : await credentials.read('openai-codex') ? 'openai-codex' : 'openai';
  const models = createModels({ credentials, authContext: { env: async () => undefined, fileExists: async () => false } });
  models.setProvider(provider === 'openai' ? openaiProvider() : openaiCodexProvider());
  return { models, provider, ready: !!await credentials.read(provider) };
}
