import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import type { DownstreamClient, Publication, TransportResult } from '../application/delivery';

export interface DownstreamConfig { baseUrl: string; apiKey: string; timeoutMs: number }
/** Resolve on final headers; optional diagnostic bodies are intentionally omitted. */
export class HttpDownstreamClient implements DownstreamClient {
  constructor(private readonly config: DownstreamConfig) {}
  send(publication: Publication, signal: AbortSignal): Promise<TransportResult> {
    return new Promise(resolve => {
      const url = new URL(`${this.config.baseUrl.replace(/\/$/, '')}/api/systems/${encodeURIComponent(publication.venueId)}/status`);
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const finish = (result: TransportResult): void => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        signal.removeEventListener('abort', abort);
        resolve(result);
      };
      const req = (url.protocol === 'https:' ? httpsRequest : httpRequest)(url, {
        method: 'PUT', headers: {
          'x-api-key': this.config.apiKey,
          'idempotency-key': publication.idempotencyKey,
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(publication.payload),
        },
      }, response => {
        const status = response.statusCode ?? 0;
        const header = response.headers['retry-after'];
        finish({ kind: 'response', status, retryAfter: typeof header === 'string' ? header : null });
        response.destroy();
      });
      const abort = (): void => { finish({ kind: 'unknown', code: 'DOWNSTREAM_INTERRUPTED' }); req.destroy(); };
      req.on('error', () => finish({ kind: 'unknown', code: 'DOWNSTREAM_NETWORK_ERROR' }));
      timer = setTimeout(() => {
        finish({ kind: 'unknown', code: 'DOWNSTREAM_TIMEOUT' });
        req.destroy();
      }, this.config.timeoutMs);
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) abort();
      else req.end(publication.payload);
    });
  }
}
