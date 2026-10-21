import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
// Exercise the actual application handler without opening a network socket.
export function localRequest(handle: (req: IncomingMessage, res: ServerResponse) => Promise<unknown>, path: string, method = 'GET', body?: string, headers: Record<string, string> = {}) {
  return new Promise<{ status: number; headers: Record<string, unknown>; body: string }>((resolve, reject) => {
    const req = Object.assign(Readable.from(body ? [body] : []), { url: path, method,
      headers: Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v])) });
    let status = 200; let responseHeaders: Record<string, unknown> = {};
    const res = {
      writeHead(code: number, fields: Record<string, unknown>) { status = code; responseHeaders = fields; },
      end(value: string | Buffer = '') { resolve({ status, headers: responseHeaders, body: value.toString() }); },
    };
    handle(req as unknown as IncomingMessage, res as unknown as ServerResponse).catch(reject);
  });
}
