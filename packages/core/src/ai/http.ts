import { assertUrlAllowed } from '../net/policy.js';
import { ApsError, errorKindForStatus } from '../errors.js';
import type { Redactor } from '../util/redact.js';
import type { ToolCall } from './types.js';

/** POST JSON and return parsed JSON, mapping HTTP failures to normalised errors. */
export async function postJson(
  url: string,
  body: unknown,
  headers: Record<string, string>,
  opts: { signal?: AbortSignal; redactor?: Redactor; provider: string },
): Promise<unknown> {
  const res = await doFetch(url, body, headers, opts);
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    throw new ApsError('ProtocolError', `${opts.provider} returned a non-JSON response`, { details: { body: text.slice(0, 1000) } });
  }
}

export async function doFetch(
  url: string,
  body: unknown,
  headers: Record<string, string>,
  opts: { signal?: AbortSignal; redactor?: Redactor; provider: string; method?: string },
): Promise<Response> {
  let res: Response;
  await assertUrlAllowed(url);
  try {
    res = await fetch(url, {
      method: opts.method ?? 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: opts.signal,
    });
  } catch (e) {
    const err = e as Error & { cause?: { code?: string } };
    if (err.name === 'AbortError') throw new ApsError('CancelledError', 'Request cancelled');
    throw new ApsError('NetworkError', `Could not reach ${opts.provider} at ${opts.redactor?.redactUrl(url) ?? url}: ${err.cause?.code ?? err.message}`, {
      suggestions: ['Check the provider base URL.', 'For local models (Ollama), make sure the server is running.', 'This feature needs network access.'],
    });
  }
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    const kind = errorKindForStatus(res.status) ?? 'ServerError';
    let msg = text;
    try {
      const j = JSON.parse(text);
      msg = j?.error?.message ?? j?.message ?? j?.error ?? text;
      if (typeof msg !== 'string') msg = JSON.stringify(msg);
    } catch {
      /* keep text */
    }
    const err = new ApsError(kind, `${opts.provider} returned HTTP ${res.status}: ${(opts.redactor?.redactString(msg) ?? msg).slice(0, 500)}`, {
      details: { status: res.status },
      ...(providerAdvice(opts.provider, res.status, msg) ?? {}),
    });
    const ra = res.headers.get('retry-after');
    if (ra) (err as ApsError & { retryAfterMs?: number }).retryAfterMs = Number.isFinite(Number(ra)) ? Number(ra) * 1000 : undefined;
    throw err;
  }
  return res;
}

/** The headers a provider's configuration adds to every request (the enabled ones with a name). */
export function configuredHeaders(cfg: { headers?: Array<{ key: string; value: string; enabled?: boolean }> }): Array<[string, string]> {
  return (cfg.headers ?? []).filter((x) => x.enabled !== false && x.key).map((x) => [x.key, x.value]);
}

/** A tool call from a model's raw JSON arguments (kept as `_unparsed` when they are not JSON). */
export function parseToolCall(id: string, name: string, raw: string | undefined): ToolCall {
  let args: Record<string, unknown> = {};
  try {
    args = raw ? JSON.parse(raw) : {};
  } catch {
    args = { _unparsed: raw };
  }
  return { id, name, arguments: args, rawArguments: raw };
}

/** What to do about an AI provider's error status: where the key is set, quota, the model list. */
export function providerAdvice(provider: string, status: number, message: string): { why: string; suggestions: string[] } | undefined {
  const key = [
    `Check the key: AI Lab ▸ Providers ▸ ${provider} ▸ API key. A key that worked before may have been revoked or may have expired: make a new one in the provider's dashboard.`,
    'In the CLI or CI the key comes from an environment variable: TESTPION_SECRET_PROVIDER_<ID>_APIKEY for a provider whose key is a secret.',
  ];
  if (status === 401) return { why: `${provider} did not accept the API key.`, suggestions: key };
  if (status === 403) return { why: `The key is valid, but ${provider} does not allow it this model or operation.`, suggestions: ['Check that the key\'s project or organization has access to this model.', ...key] };
  if (status === 429 && /quota|billing|credit|insufficient/i.test(message))
    return { why: `The ${provider} account has no credit left or reached its spending limit.`, suggestions: [`Check billing and limits in the ${provider} dashboard, then run again.`] };
  if (status === 429)
    return { why: `${provider} is limiting how many requests this key may send.`, suggestions: ['Wait a moment and run again.', 'Run fewer tests at once (concurrency) or add retries.'] };
  if (status === 404)
    return { why: `${provider} does not know this model (or the address is wrong).`, suggestions: ['Pick a model from the list: the refresh button next to the model name reads the models your key can use.', 'Check the provider\'s base URL.'] };
  if (status >= 500) return { why: `${provider} had a problem of its own.`, suggestions: ['Run again in a moment; check the provider\'s status page if it persists.'] };
  return undefined;
}

/** Iterate Server-Sent Events from a fetch Response. Yields `{ event, data }`. */
export async function* sseEvents(res: Response): AsyncGenerator<{ event?: string; data: string }> {
  if (!res.body) return;
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  let event: string | undefined;
  let data: string[] = [];
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let nl: number;
      while ((nl = buf.indexOf('\n')) >= 0) {
        let line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (line.endsWith('\r')) line = line.slice(0, -1);
        if (line === '') {
          if (data.length) yield { event, data: data.join('\n') };
          event = undefined;
          data = [];
        } else if (line.startsWith(':')) continue;
        else if (line.startsWith('event:')) event = line.slice(6).trim();
        else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
      }
    }
    if (data.length) yield { event, data: data.join('\n') };
  } finally {
    reader.releaseLock();
  }
}

/** Tracks streaming timing: time-to-first-token and mean inter-token gap. */
export class StreamTimer {
  readonly start = performance.now();
  private first?: number;
  private last?: number;
  private gaps = 0;
  private gapSum = 0;

  tick(): void {
    const now = performance.now();
    if (this.first === undefined) this.first = now;
    else if (this.last !== undefined) {
      this.gapSum += now - this.last;
      this.gaps++;
    }
    this.last = now;
  }

  result(startedAt: number) {
    const end = performance.now();
    return {
      startedAt,
      firstTokenMs: this.first !== undefined ? Math.round(this.first - this.start) : undefined,
      totalMs: Math.round(end - this.start),
      interTokenMsAvg: this.gaps ? Math.round((this.gapSum / this.gaps) * 100) / 100 : undefined,
    };
  }
}
