import { withEngine } from './server-kit.js';
import { ApsError } from '../../errors.js';
import { collectionLoadTarget } from '../../load/collection-load.js';
import { loadHistory, loadRunRecord, recordLoadRun } from '../../load/history.js';
import { runLoadTest, type LoadTarget } from '../../load/load.js';
import { evaluateThresholds, parseThreshold } from '../../load/thresholds.js';
import type { CollectionNode } from '../../model/types.js';
import { parseGrpcTarget } from '../../protocols/grpc/grpc.js';
import { reflectServer } from '../../protocols/grpc/reflection.js';
import { shortId } from '../../util/ids.js';
import { str } from '../tool.js';
import type { Tool } from '../tool.js';
import type { ModuleToolDeps } from './deps.js';

/** Load tests and their history. */
export function loadTools(d: ModuleToolDeps): Tool[] {
  const { store, secrets, settings, redactor, findCollection, checkEnvironment } = d;
  return [
    {
      name: 'load_history',
      description:
        'Earlier load tests of this workspace, newest first (from the app and from load_test): when, what was tested, virtual users, duration, requests, throughput (req/s), error rate, p50 / p95 / p99 in ms, status codes and pass/fail rules. Use it to see whether an API got slower or less reliable between runs.',
      inputSchema: { type: 'object', properties: { query: str('Only load tests whose name or target contains this'), limit: { type: 'number', description: 'How many (default 20, max 200)' } } },
      run: (a) => loadHistory(store, { query: a.query ? String(a.query) : undefined, limit: Math.min(Math.max(Number(a.limit) || 20, 1), 200) }),
    },
    {
      name: 'load_test',
      write: true,
      description:
        'Load-test a local API (localhost / private network only; remote hosts are never allowed from here): a URL, a collection (every virtual user sends its requests in order, with per-user cookies) or a flow file (`test_file`: every virtual user runs the whole flow again and again; per-step numbers and `iteration`: runs of the flow, failed, p50 / p95). At most 50 virtual users and 60 seconds. `warmUp` runs the collection once with scripts first (e.g. to log in). Returns throughput, latency percentiles, error rate, status codes and, for collections, per-request numbers.',
      inputSchema: {
        type: 'object',
        properties: {
          url: str('URL to load-test (GET), or use collection'),
          collection: str('Collection name or id'),
          folder: str('With collection: only this folder or request (name or id)'),
          test_file: str('Or a flow file (a path inside tests/): each virtual user runs the whole flow'),
          environment: str('Environment name'),
          virtualUsers: { type: 'number', description: 'Virtual users, 1–50 (default 5)' },
          durationSec: { type: 'number', description: 'Seconds, 1–60 (default 10)' },
          warmUp: { type: 'boolean', description: 'With collection: run it once with scripts first' },
          thresholds: { type: 'array', items: { type: 'string' }, description: 'Pass/fail rules, e.g. ["p95<500", "errors<1%", "rps>=20", "p99[Get pet]<800"]; the result says which passed' },
          grpc: { type: 'object', description: 'Instead of url/collection: a gRPC method, { target: "localhost:50051", method: "pkg.Service/Method", message: {…} } (the server is asked through reflection)', properties: { target: { type: 'string' }, method: { type: 'string' }, message: { type: 'object' } }, required: ['target', 'method'] },
        },
      },
      run: async (a) => {
        const environment = checkEnvironment(a.environment);
        const vus = Math.min(50, Math.max(1, Number(a.virtualUsers) || 5));
        const duration = Math.min(60, Math.max(1, Number(a.durationSec) || 10));
        const c = a.collection ? findCollection(a.collection) : undefined;
        const g = a.grpc as { target?: string; method?: string; message?: unknown } | undefined;
        if (!c && !a.url && !g && !a.test_file) throw new ApsError('ValidationError', 'Give a url, a collection, a test_file or grpc');
        const thresholds = Array.isArray(a.thresholds) ? (a.thresholds as unknown[]).map(String) : [];
        thresholds.forEach(parseThreshold); // a typo fails before the test runs
        return withEngine({ store, secrets, settings }, { environment, collectionId: c?.id }, async (ctx) => {
          let target: LoadTarget;
          let prep: { requests: string[]; unresolved: string[] } | undefined;
          if (c) {
            let selection: string[] | undefined;
            if (a.folder) {
              const r = String(a.folder).toLowerCase();
              const all: CollectionNode[] = [];
              const walk = (nodes: CollectionNode[]) => nodes.forEach((n) => (all.push(n), n.kind === 'folder' && walk(n.items)));
              walk(c.items);
              const n = all.find((x) => x.id.toLowerCase() === r) ?? all.find((x) => x.name.toLowerCase() === r);
              if (!n) throw new ApsError('ConfigurationError', `No folder or request "${String(a.folder)}" in "${c.name}"`);
              selection = [n.id];
            }
            const t = await collectionLoadTarget({ collection: c, selection, services: ctx.services, warmUp: a.warmUp === true });
            target = t.target;
            prep = { requests: t.target.requests.map((x) => x.name), unresolved: t.unresolved };
          } else if (g) {
            const gt = ctx.vars.resolve(String(g.target));
            const descriptorSet = (await reflectServer(parseGrpcTarget(gt))).descriptorSet;
            target = { kind: 'grpc', request: { target: gt, method: String(g.method), message: JSON.stringify(ctx.vars.resolveDeep(g.message ?? {})), descriptorSet } };
          } else if (a.test_file) target = { kind: 'flow', file: String(a.test_file).replace(/^tests[\\/]/, '') };
          else target = { kind: 'http', request: { method: 'GET', url: ctx.vars.resolve(String(a.url)) } };
          const startedAt = new Date().toISOString();
          const s = await runLoadTest(
            { target, virtualUsers: vus, durationSec: duration, allowRemoteHosts: false, environmentIsProduction: !!ctx.environment?.isProduction, maxVirtualUsers: 50 },
            { redactor: ctx.redactor, services: ctx.services, testsDir: store.path('tests') },
          );
          const { series: _series, ...summary } = s;
          const checked = thresholds.length ? evaluateThresholds(thresholds, s) : undefined;
          // kept in the workspace's load history like the app's load tests (load_history reads it)
          if (s.requests) {
            const targetText = c ? `collection ${c.name}${a.folder ? ` / ${String(a.folder)}` : ''}` : g ? `gRPC ${String(g.target)} ${String(g.method)}` : a.test_file ? `test file ${target.kind === 'flow' ? target.file : ''}` : `GET ${redactor.redactUrl(String(a.url))}`;
            recordLoadRun(
              store,
              loadRunRecord(s, { id: shortId('load-'), startedAt, name: targetText, target: targetText, environment, virtualUsers: vus, durationSec: duration, thresholds: checked?.map((t) => ({ expr: t.expr, passed: t.passed, actual: t.actual })) }),
            );
          }
          return { ...prep, environment: environment ?? null, ...summary, ...(checked ? { thresholds: checked, passed: checked.every((t) => t.passed) } : {}) };
        });
      },
    },
  ];
}
