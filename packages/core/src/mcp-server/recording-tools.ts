import { existsSync, readFileSync } from 'node:fs';
import type { DebuggerExchange } from '../debugger/proxy.js';
import { ApsError } from '../errors.js';
import { flowFromExchanges, flowFromHar, recordedFlowPath, type FlowFromExchangesOptions } from '../runner/flow-from-exchanges.js';
import { collectionFromExchanges } from '../runner/collection-from-exchanges.js';
import { exchangesFromHar } from '../debugger/har.js';
import { secretKeys, type SecretStore } from '../storage/secrets.js';
import type { WorkspaceStore } from '../storage/workspace.js';
import type { Redactor } from '../util/redact.js';
import { isSecretRef } from '../vars/external-secrets.js';
import { str, type Tool } from './tool.js';

/**
 * Record a flow for agents: exchanges the HTTP Debugger captured in this server (debugger_capture) or a HAR file's
 * entries become a flow file under tests/recorded/, with the values that flow between them extracted and passed as
 * {{variables}}, noise left out and secrets turned into variables to set (core flowFromExchanges).
 */
export function recordingTools(d: { store: WorkspaceStore; redactor: Redactor; secrets?: SecretStore; session: DebuggerExchange[] }): Tool[] {
  const environmentOf = (ref?: string): FlowFromExchangesOptions['environment'] => {
    if (!ref) return undefined;
    const env = d.store.getEnvironment(ref);
    if (!env) throw new ApsError('ValidationError', `No environment "${ref}"`);
    return {
      name: env.name,
      variables: env.variables
        .filter((v) => !isSecretRef(v.value))
        .map((v) => ({ key: v.key, enabled: v.enabled, value: v.secret ? (d.secrets?.get(secretKeys.envVar(env.id, v.key)) ?? '') : v.value })),
    };
  };
  const harPath = (har: string) => {
    const p = d.store.safePath(har);
    if (!existsSync(p)) throw new ApsError('ValidationError', `No file ${har} in the workspace`);
    return p;
  };
  /** The captured exchanges a call names: by `ids`, `since` a time, else all of them. */
  const chosen = (a: Record<string, unknown>): DebuggerExchange[] => {
    let list = d.session;
    if (Array.isArray(a.ids) && a.ids.length) {
      const want = new Set(a.ids.map(String));
      list = list.filter((e) => want.has(e.id));
    } else if (typeof a.since === 'string' && a.since) {
      const t = Date.parse(a.since);
      if (Number.isNaN(t)) throw new ApsError('ValidationError', `since is an ISO time, not ${JSON.stringify(a.since)}`);
      list = list.filter((e) => Date.parse(e.startedAt) >= t);
    }
    if (!list.length) throw new ApsError('ValidationError', 'No exchanges: capture some with debugger_capture first, or give a HAR file (har)');
    return list;
  };
  return [
    {
      name: 'flow_from_exchanges',
      write: true,
      description:
        "Make a test flow file from recorded HTTP traffic: exchanges the HTTP Debugger captured in this server (debugger_capture, by `ids` or `since` a time; all of them by default) or a HAR file (`har`, a workspace path). Steps follow the order the requests were made; each origin becomes a variable ({{baseUrl}}, or the environment's variable that holds it); values that came from an earlier response (tokens, ids, uuids, cursors, long numbers) become {{variables}} with an `extract` on the step that produced them and a dependsOn; a step with none waits for the one before it; each step checks the recorded status. Static assets, CORS preflights, telemetry hosts, page loads and tunnels are left out (listed in `dropped`). Secrets are never written: Authorization, Cookie, API-key headers, password fields and values the redactor knows become variables listed in `secrets` to set in an environment. Writes tests/recorded/<name>.yaml (a free name) unless `dry_run`; returns { file, text, steps, links, variables, secrets, dropped, notes }. Run it with run_tests.",
      inputSchema: {
        type: 'object',
        properties: {
          ids: { type: 'array', items: { type: 'string' }, description: 'The exchanges (debugger_exchanges ids)' },
          since: str('Or the exchanges that started at or after this ISO time'),
          har: str('Or a HAR file in the workspace, e.g. debugger/session.har'),
          name: str('The flow name; the file is tests/recorded/<name>.yaml'),
          environment: str('An environment whose variables are used by name when they hold an origin or a secret that was sent'),
          drop: { type: 'array', items: { type: 'string' }, description: 'Exchange ids to leave out' },
          keep_noise: { type: 'boolean', description: 'Keep static assets, preflights and telemetry requests' },
          noise_hosts: { type: 'array', items: { type: 'string' }, description: 'More hosts to leave out as telemetry' },
          dry_run: { type: 'boolean', description: 'Return the flow without writing it' },
        },
      },
      run: (a) => {
        const name = typeof a.name === 'string' && a.name.trim() ? a.name.trim() : `recorded-${new Date().toISOString().slice(0, 16).replace(/[T:]/g, '-')}`;
        const opts: FlowFromExchangesOptions = {
          name,
          environment: environmentOf(typeof a.environment === 'string' ? a.environment : undefined),
          redactor: d.redactor,
          drop: Array.isArray(a.drop) ? a.drop.map(String) : undefined,
          keepNoise: a.keep_noise === true,
          extraNoiseHosts: Array.isArray(a.noise_hosts) ? a.noise_hosts.map(String) : undefined,
        };
        const r = typeof a.har === 'string' && a.har ? flowFromHar(readFileSync(harPath(a.har), 'utf8'), { ...opts, source: a.har }) : flowFromExchanges(chosen(a), opts);
        let path = recordedFlowPath(name);
        for (let i = 2; existsSync(d.store.safePath(path, d.store.path('tests'))); i++) path = recordedFlowPath(name).replace(/\.yaml$/, `-${i}.yaml`);
        if (a.dry_run !== true) d.store.writeTestFile(path, r.text);
        return { file: `tests/${path}`, written: a.dry_run !== true, ...r, dropped: r.dropped.map((x) => ({ ...x, url: d.redactor.redactUrl(x.url) })) };
      },
    },
    {
      name: 'debugger_save_to_collection',
      write: true,
      description:
        'Save captured HTTP traffic as requests in a collection (the HTTP Debugger\'s Save to collection): exchanges captured in this server (debugger_capture, by `ids` or `since`; all by default) or a HAR file (`har`). The same reading as flow_from_exchanges — noise left out, each origin a {{variable}} on the collection, secrets (Authorization, cookies, API keys, passwords) turned into variables listed in `secrets` and never saved, values from an earlier response kept in collection variables by the test script of the request that returned them — as requests to send by hand. `group` puts them in a folder per host (default), per first path segment, or none. Without `collection` a new collection (`name`); with it they are added (in a folder `name` when given). Returns { collectionId, created, requests, secrets, variables, dropped, notes }.',
      inputSchema: {
        type: 'object',
        properties: {
          ids: { type: 'array', items: { type: 'string' }, description: 'The exchanges (debugger_exchanges ids)' },
          since: str('Or the exchanges that started at or after this ISO time'),
          har: str('Or a HAR file in the workspace'),
          collection: str('Add to this collection (name or id); default: a new collection'),
          name: str("The new collection's name, or with collection the folder the requests go in"),
          group: { type: 'string', enum: ['host', 'path', 'none'], description: 'A folder per host (default), per first path segment, or none' },
          environment: str('An environment whose variables are used by name when they hold an origin or a secret that was sent'),
          keep_noise: { type: 'boolean', description: 'Keep static assets, preflights and telemetry requests' },
        },
      },
      run: (a) => {
        const list = typeof a.har === 'string' && a.har ? exchangesFromHar(JSON.parse(readFileSync(harPath(a.har), 'utf8'))) : chosen(a);
        const ref = typeof a.collection === 'string' ? a.collection.trim().toLowerCase() : '';
        const existing = ref ? d.store.listCollections().find((c) => c.id.toLowerCase() === ref || c.name.toLowerCase() === ref) : undefined;
        if (ref && !existing) throw new ApsError('ValidationError', `No collection "${String(a.collection)}"`, { suggestions: ['list_collections names them; leave collection out for a new one.'] });
        const r = collectionFromExchanges(list, {
          collection: existing && d.store.getCollection(existing.id),
          name: typeof a.name === 'string' && a.name.trim() ? a.name.trim() : undefined,
          group: a.group === 'path' || a.group === 'none' ? a.group : 'host',
          environment: environmentOf(typeof a.environment === 'string' ? a.environment : undefined),
          redactor: d.redactor,
          keepNoise: a.keep_noise === true,
        });
        const saved = d.store.saveCollection(r.collection);
        const { collection: _c, ...rest } = r;
        return { collectionId: saved.id, collection: saved.name, ...rest, dropped: r.dropped.map((x) => ({ ...x, url: d.redactor.redactUrl(x.url) })) };
      },
    },
  ];
}
