import { randomUUID } from 'node:crypto';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { spawn } from 'node:child_process';
import { createModels } from '@earendil-works/pi-ai/models';
import { openaiProvider } from '@earendil-works/pi-ai/providers/openai';
import { ChatGPTCredentials } from '../src/chatgpt-auth.ts';

await mkdir('.auth', { recursive: true, mode: 0o700 });
let deviceId: string;
try { deviceId = (await readFile('.auth/device-id', 'utf8')).trim(); }
catch (error) {
  if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  deviceId = randomUUID(); await writeFile('.auth/device-id', deviceId, { mode: 0o600, flag: 'wx' });
}
const models = createModels({ credentials: new ChatGPTCredentials() });
models.setProvider(openaiProvider());
const rl = createInterface({ input: stdin, output: stdout });
try {
  await models.login('openai', 'oauth', {
    prompt: async prompt => {
      if (prompt.type === 'select') {
        console.log(prompt.message);
        for (const option of prompt.options) console.log(`${option.id}: ${option.label}`);
      }
      return rl.question(`${prompt.message}: `, { signal: prompt.signal });
    },
    notify: event => {
      if (event.type === 'auth_url') {
        console.log(`Sign in with ChatGPT:\n${event.url}`);
        const command = process.platform === 'win32' ? 'rundll32' : process.platform === 'darwin' ? 'open' : 'xdg-open';
        const args = process.platform === 'win32' ? ['url.dll,FileProtocolHandler', event.url] : [event.url];
        spawn(command, args, { stdio: 'ignore', windowsHide: true }).on('error', () => {});
      } else if (event.type === 'device_code') console.log(`${event.verificationUri}\nCode: ${event.userCode}`);
      else console.log(event.message);
    },
  }, { getDeviceId: () => deviceId, agentName: 'Pi Durable SRE demo' });
  console.log('ChatGPT connected. Run npm run dev.');
} finally { rl.close(); }
