/**
 * MCP tools that deploy a flow: put it behind a webhook (its `webhook:` block, served by `testpion serve flows` or the
 * app), schedule it (save_monitor: a monitor of a collection or a test file) and say where a flow is deployed (a monitor,
 * its webhook, an MCP tool of its own, a CI pipeline).
 */
import { editFlowFile } from '../../runner/flow-edit.js';
import { flowDeployStatus } from '../../runner/flow-deploy.js';
import { listMonitors, monitorStatus, parseEvery, saveMonitor } from '../../runner/monitors.js';
import { findCollection } from '../../storage/env-edit.js';
import type { WorkspaceStore } from '../../storage/workspace.js';
import { ApsError } from '../../errors.js';
import { shortId } from '../../util/ids.js';
import { str, type Tool } from '../tool.js';

export function deployTools({ store }: { store: WorkspaceStore }): Tool[] {
  const file = str('The test file inside tests/, e.g. orders/new-order.yaml');
  return [
    {
      name: 'flow_webhook_set',
      description:
        "Serve a flow behind a webhook: sets the file's webhook: block (path, default /hooks/<file>; secret, best a \"{{VARIABLE}}\" kept as a secret of the environment). `testpion serve flows` (or the app's Deploy panel) then runs the flow when something POSTs a JSON body to the path: the body's fields are its inputs (checked against expose.inputs when declared) and the answer is { ok, output, steps, runId } (422 with failedStep when a step failed, 401 without the secret). remove: true takes the webhook away. Keeps the file's comments and line endings. See flow_deploy_status for the URL.",
      write: true,
      inputSchema: {
        type: 'object',
        properties: {
          file,
          path: str('Where it listens, e.g. /hooks/new-order (default: kept, or /hooks/<file>)'),
          secret: { type: ['string', 'null'], description: 'What callers send as X-TestPion-Secret or Authorization: Bearer; "{{VAR}}" reads it from the environment or the secrets; null removes it' },
          remove: { type: 'boolean', description: 'Remove the webhook' },
        },
        required: ['file'],
      },
      run: (a) => {
        const r = editFlowFile(
          store,
          String(a.file ?? ''),
          a.remove
            ? { op: 'setWebhook', webhook: null }
            : { op: 'setWebhook', webhook: { ...(typeof a.path === 'string' ? { path: a.path } : {}), ...(a.secret !== undefined ? { secret: a.secret === null ? null : String(a.secret) } : {}) } },
        );
        return { written: r.written, ...flowDeployStatus(store, r.file) };
      },
    },
    {
      name: 'flow_deploy_status',
      description:
        'Where a flow is deployed: schedule (a monitor that runs the file: its id, name, interval and last status), webhook (its path, whether it needs a secret; served by `testpion serve flows`), mcp (the tool name its expose: block offers it as) and ci (true when a CI pipeline file of the repository — GitHub Actions, GitLab, Azure, Jenkins, Bitbucket — runs it by path or runs every test; ciFiles names them).',
      inputSchema: { type: 'object', properties: { file }, required: ['file'] },
      run: (a) => flowDeployStatus(store, String(a.file ?? '')),
    },
    {
      name: 'save_monitor',
      description:
        'Add or change a monitor: a collection (or some of its folders / requests) or a test file / flow under tests/ (testFile) that runs on a schedule, like `testpion monitor add`. Exactly one of collection and testFile. every: minutes or "15m", "1h", "1d" (1 minute to 7 days). A monitor with the same name is replaced. Each run is recorded (monitor_results, monitor_uptime); webhook gets an alert when it starts failing or recovers. Schedule a flow: testFile + every.',
      write: true,
      inputSchema: {
        type: 'object',
        properties: {
          name: str('The monitor name (an existing one with this name is replaced)'),
          collection: str('A collection name or id to run'),
          selection: { type: 'array', items: { type: 'string' }, description: 'With collection: folder or request ids to run (default all)' },
          testFile: str('Or a test file / flow under tests/, e.g. orders/new-order.yaml'),
          evaluation: str('Or a saved RAG evaluation (list_evaluations): its questions are asked of the RAG system and scored on the schedule'),
          limit: { type: 'number', description: 'With evaluation: only the first n dataset records' },
          gates: { type: 'object', description: 'With evaluation: metric name → the lowest mean it may have, e.g. { "faithfulness": 0.8, "recall@5": 0.9 }; the run fails below it', additionalProperties: { type: 'number' } },
          judgeSample: { type: 'number', description: 'With evaluation: the share (0 to 1) of samples that get the judged metrics; the free ones always run' },
          judgeBudgetUsdPerDay: { type: 'number', description: 'With evaluation: stop judging for the day at this much (USD); the rest is n/a' },
          rotate: { type: 'boolean', description: 'With evaluation and limit: score a different `limit` records each night (chosen by the UTC date) so a month covers the dataset' },
          maxCostUsd: { type: 'number', description: 'With evaluation: stop judging in one run at this much (USD); the rest is n/a, not a failed gate' },
          baseline: str('With evaluation: fail when a metric dropped against `previous`, `best` (of the last 30 runs) or a run id'),
          maxDrop: { type: 'number', description: 'With baseline: the smallest drop that fails (default 0.05)' },
          every: { type: ['string', 'number'], description: 'How often: minutes, or 15m, 1h, 1d' },
          environment: str('The environment it runs with'),
          webhook: str('Alert URL (Slack / Teams / Discord webhook or any URL; {{variables}} work)'),
          enabled: { type: 'boolean', description: 'false saves it paused (default true)' },
        },
        required: ['name', 'every'],
      },
      run: (a) => {
        const name = String(a.name ?? '').trim();
        const hasCollection = typeof a.collection === 'string' && !!a.collection.trim();
        const hasFile = typeof a.testFile === 'string' && !!a.testFile.trim();
        const hasEvaluation = typeof a.evaluation === 'string' && !!a.evaluation.trim();
        if ([hasCollection, hasFile, hasEvaluation].filter(Boolean).length !== 1) throw new ApsError('ValidationError', 'Give collection, testFile or evaluation (one of them)', { suggestions: [] });
        const collection = hasCollection ? findCollection(store, String(a.collection), { loadable: true }) : undefined;
        if (hasCollection && !collection) throw new ApsError('ValidationError', `No collection "${String(a.collection)}"`, { suggestions: [] });
        if (a.environment && !store.getEnvironment(String(a.environment))) throw new ApsError('ValidationError', `No environment "${String(a.environment)}"`, { suggestions: [] });
        const existing = listMonitors(store).find((m) => m.name.toLowerCase() === name.toLowerCase());
        // production consent is the monitor's (given in the app or with --allow-production), never this call's: a
        // replacement keeps it while it runs in the same production environment
        const environment = a.environment ? String(a.environment) : undefined;
        const keepConsent = !!existing?.allowProduction && existing.environment === environment && !!(environment && store.getEnvironment(environment)?.isProduction);
        const m = saveMonitor(store, {
          id: existing?.id ?? shortId('mon-'),
          name,
          ...(collection ? { collectionId: collection.id, ...(Array.isArray(a.selection) && a.selection.length ? { selection: a.selection.map(String) } : {}) } : hasEvaluation ? { evaluation: String(a.evaluation), ...(typeof a.limit === 'number' ? { limit: a.limit } : {}), ...(a.gates && typeof a.gates === 'object' ? { gates: Object.fromEntries(Object.entries(a.gates as Record<string, unknown>).map(([k, v]) => [k, Number(v)])) } : {}), ...(typeof a.judgeSample === 'number' ? { judgeSample: a.judgeSample } : {}), ...(typeof a.judgeBudgetUsdPerDay === 'number' ? { judgeBudgetUsdPerDay: a.judgeBudgetUsdPerDay } : {}), ...(a.rotate === true ? { rotate: true } : {}), ...(typeof a.maxCostUsd === 'number' ? { maxCostUsd: a.maxCostUsd } : {}), ...(a.baseline ? { baseline: String(a.baseline) } : {}), ...(typeof a.maxDrop === 'number' ? { maxDrop: a.maxDrop } : {}) } : { testFile: String(a.testFile) }),
          everyMinutes: parseEvery(a.every as string | number),
          enabled: a.enabled !== false,
          ...(a.environment ? { environment: String(a.environment) } : {}),
          ...(a.webhook ? { webhook: String(a.webhook) } : existing?.webhook ? { webhook: existing.webhook } : {}),
          ...(keepConsent ? { allowProduction: true } : {}),
        });
        return monitorStatus(store, m);
      },
    },
  ];
}
