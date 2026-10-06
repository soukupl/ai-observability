import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';

export interface HttpRequest {
  method: 'GET' | 'POST';
  url: string;
  headers?: Record<string, string>;
  body?: Buffer;
  timeoutMs: number;
}

export interface HttpResponse {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

/** Pluggable HTTP transport (tests inject one; production uses node:http/https). */
export type Transport = (req: HttpRequest) => Promise<HttpResponse>;

const MAX_RESPONSE_BYTES = 1024 * 1024;

/** Minimal HTTP client on node:http(s). Rejects on network errors and on timeout (whole request). */
export const nodeTransport: Transport = (req) =>
  new Promise((resolve, reject) => {
    const url = new URL(req.url);
    const send = url.protocol === 'https:' ? httpsRequest : httpRequest;
    const headers: Record<string, string> = { ...req.headers };
    if (req.body) headers['content-length'] = String(req.body.length);
    const r = send(url, { method: req.method, headers }, (res) => {
      const chunks: Buffer[] = [];
      let size = 0;
      res.on('data', (c: Buffer) => {
        size += c.length;
        if (size <= MAX_RESPONSE_BYTES) chunks.push(c);
      });
      res.on('end', () => {
        clearTimeout(timer);
        resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') });
      });
      res.on('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
    });
    const timer = setTimeout(() => r.destroy(new Error(`timeout after ${req.timeoutMs} ms`)), req.timeoutMs);
    r.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    r.end(req.body);
  });
