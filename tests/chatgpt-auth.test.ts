import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ChatGPTCredentials, chatGPTModels } from '../src/chatgpt-auth.ts';

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'sre-auth-'));
  const store = new ChatGPTCredentials({ path: join(dir, 'auth.json'), codexPath: join(dir, 'codex.json') });
  return { store, async clean() { await rm(dir, { recursive: true, force: true }); } };
}
const token = (expires: number) => `header.${Buffer.from(JSON.stringify({ exp: expires })).toString('base64url')}.signature`;
test('no session cannot use an ambient OpenAI API key', async () => {
  const f = await fixture(); const original = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = 'must-never-be-used';
  try {
    const session = await chatGPTModels(f.store);
    assert.equal(session.ready, false);
    assert.equal(await session.models.getAuth('openai'), undefined);
  } finally {
    if (original === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = original;
    await f.clean();
  }
});
test('Codex session is read on each request and is never modified', async () => {
  const f = await fixture();
  const saved = { auth_mode: 'chatgpt', tokens: { access_token: token(Date.now() / 1000 + 3600), account_id: 'test-account', refresh_token: 'do-not-copy' } };
  try {
    await writeFile(f.store.codexPath, JSON.stringify(saved));
    const session = await chatGPTModels(f.store);
    assert.equal(session.provider, 'openai-codex'); assert.equal(session.ready, true);
    assert.equal((await session.models.getAuth(session.provider))?.auth.apiKey, saved.tokens.access_token);
    saved.tokens.access_token = token(Date.now() / 1000 + 7200);
    await writeFile(f.store.codexPath, JSON.stringify(saved));
    assert.equal((await session.models.getAuth(session.provider))?.auth.apiKey, saved.tokens.access_token);
    await assert.rejects(f.store.modify(session.provider, async () => undefined), /Codex must renew/);
    assert.deepEqual(JSON.parse(await readFile(f.store.codexPath, 'utf8')), saved);
    saved.tokens.access_token = token(1); await writeFile(f.store.codexPath, JSON.stringify(saved));
    assert.equal(await f.store.read(session.provider), undefined);
  } finally { await f.clean(); }
});
test('app OAuth session persists serialized refresh updates and takes priority', async () => {
  const f = await fixture();
  try {
    await f.store.modify('openai', async () => ({ type: 'oauth', access: 'local-access', refresh: 'local-refresh', expires: Date.now() + 3600000, revision: 0 }));
    await Promise.all(Array.from({ length: 4 }, () => f.store.modify('openai', async current => {
      assert.equal(current?.type, 'oauth');
      if (current?.type !== 'oauth') throw new Error('Missing OAuth credential');
      return { ...current, revision: Number(current.revision) + 1 };
    })));
    const session = await chatGPTModels(f.store);
    assert.equal(session.provider, 'openai'); assert.equal(session.ready, true);
    const credential = await f.store.read('openai');
    assert.equal(credential?.type === 'oauth' ? credential.revision : undefined, 4);
    assert.deepEqual(await f.store.list(), [{ providerId: 'openai', type: 'oauth' }]);
    await f.store.delete('openai'); assert.equal(await f.store.read('openai'), undefined);
  } finally { await f.clean(); }
});
