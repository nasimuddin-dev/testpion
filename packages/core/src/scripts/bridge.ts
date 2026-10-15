import { assertProductionStep, isDataChangingMethod, type ProductionGate } from '../net/production-guard.js';
import type { VariableScope, ScopeName } from '../vars/variables.js';
import type { Redactor } from '../util/redact.js';
import type { ScriptInput, ScriptOutput, ScriptRequestSender, ScriptScope } from './sandbox.js';
import type { CookieJar } from '../cookies/cookie-jar.js';
import { executeHttp } from '../protocols/http/client.js';

/** Where `tp.environment` / `tp.globals` / `tp.collectionVariables` map to in the engine's scopes. */
const SCOPE_MAP: Record<ScriptScope, ScopeName> = { environment: 'environment', globals: 'global', collectionVariables: 'collection' };

/** Called when a script sets or unsets a scoped variable (the desktop app keeps these as local "current values"). */
export type PersistVariable = (scope: ScriptScope, key: string, value: unknown | undefined) => void;

/** Scope data a script sees. */
export function scriptScopes(vars: VariableScope, iterationData?: Record<string, unknown>): Pick<ScriptInput, 'variables' | 'environment' | 'globals' | 'collectionVariables' | 'iterationData'> {
  return {
    variables: vars.toObject(),
    environment: vars.scopeValues('environment'),
    globals: vars.scopeValues('global'),
    collectionVariables: vars.scopeValues('collection'),
    iterationData: iterationData ?? {},
  };
}

/**
 * Apply what a script changed: `tp.variables.set` → runtime scope; `tp.environment.set` etc. → that
 * scope (in every given VariableScope, e.g. the test's own and the run's shared one), plus persistence.
 */
export function applyScriptOutput(out: Pick<ScriptOutput, 'vars' | 'unset' | 'scopeSets' | 'scopeUnsets'>, targets: VariableScope[], opts: { redactor?: Redactor; persist?: PersistVariable } = {}): void {
  for (const [k, v] of Object.entries(out.vars)) for (const t of targets) t.set(k, v, 'runtime');
  for (const k of out.unset) for (const t of targets) t.unset(k, 'runtime');
  for (const scope of Object.keys(SCOPE_MAP) as ScriptScope[]) {
    for (const [k, v] of Object.entries(out.scopeSets?.[scope] ?? {})) {
      for (const t of targets) t.set(k, v, SCOPE_MAP[scope]);
      if (typeof v === 'string' && opts.redactor?.isSensitiveKey(k)) opts.redactor.addSecret(v);
      opts.persist?.(scope, k, v);
    }
    for (const k of out.scopeUnsets?.[scope] ?? []) {
      for (const t of targets) t.unset(k, SCOPE_MAP[scope]);
      opts.persist?.(scope, k, undefined);
    }
  }
}

/**
 * The host side of `tp.sendRequest`: sends with the engine's HTTP client (shared cookie jar, redaction,
 * cancellation) and a per-request timeout. `{{variables}}` are not resolved, as in Postman; scripts use
 * `tp.variables.replaceIn()` for that.
 */
/**
 * `production` is required (it may be undefined): the production guard of the context the script runs in, so a
 * data-changing tp.sendRequest to a production environment needs the same consent as the request itself (WF-06).
 */
export function scriptRequestSender(o: { redactor?: Redactor; cookieJar?: CookieJar; signal?: AbortSignal; timeoutMs?: number; production: ProductionGate | undefined }): ScriptRequestSender {
  return async (req) => {
    if (!/^https?:\/\//i.test(req.url)) throw new Error(`tp.sendRequest: "${req.url}" is not an http(s) URL`);
    assertProductionStep(o.production, { action: `tp.sendRequest ${String(req.method ?? 'GET').toUpperCase()} ${o.redactor ? o.redactor.redactUrl(req.url) : req.url}`, changesData: isDataChangingMethod(req.method) });
    const timeoutMs = o.timeoutMs ?? 30_000;
    const signal = o.signal ? AbortSignal.any([o.signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs);
    const body = typeof req.body === 'string' ? { type: 'text' as const, content: req.body } : req.body ? { type: 'form-urlencoded' as const, fields: req.body.urlencoded } : undefined;
    const { response } = await executeHttp({ method: req.method, url: req.url, headers: req.headers, body, settings: { timeoutMs } }, { signal, redactor: o.redactor, cookieJar: o.cookieJar, maxPreviewBytes: 2 * 1024 * 1024 });
    return { status: response.status, statusText: response.statusText, headers: response.headers, body: response.bodyPreview, time: response.durationMs };
  };
}
