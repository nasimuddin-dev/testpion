import { checkCertificate } from '../../net/certificate-check.js';
import { ciConfig, type CiConfigOptions } from '../../runner/ci-config.js';
import { ciTargetOfRun, finishedRun } from '../../runner/result-source.js';
import { listCertificates, recordCertificate } from '../../storage/certificates.js';
import { trustSummary } from '../../storage/trust.js';
import { llmUsage } from '../../storage/llm-usage.js';
import { mcpToolUsage } from '../../storage/mcp-usage.js';
import { str } from '../tool.js';
import type { Tool } from '../tool.js';
import type { ModuleToolDeps } from './deps.js';

/** CI configuration, certificates and usage of the LLM and MCP tools. */
export function opsTools(d: ModuleToolDeps): Tool[] {
  const { store } = d;
  return [
    {
      name: 'ci_config',
      description:
        "A CI pipeline file that runs this workspace's tests on every push: GitHub Actions, GitLab CI, Azure Pipelines or Jenkins. Give one of suite, collection (+ folders) or tests; for integration tests also `start` (starts the system under test) and `waitFor` (its health URL). Returns { path, content, secrets, command }: write content to path in the repository and create the listed CI secrets (values are never included).",
      inputSchema: {
        type: 'object',
        properties: {
          provider: { type: 'string', enum: ['github', 'gitlab', 'azure', 'jenkins'] },
          suite: str('Suite name (tests/<name>.suite.yaml)'),
          collection: str('Collection name or id'),
          folders: { type: 'array', items: { type: 'string' }, description: 'With collection: folder or request names' },
          tests: { type: 'array', items: { type: 'string' }, description: 'Test files or folders under tests/' },
          data: str("One flow file (tests: [file]): run it once per row of this dataset ('' for the file's own data:)"),
          envMatrix: { type: 'array', items: { type: 'string' }, description: 'One flow file: run it in each of these environments and compare' },
          allowProduction: { type: 'boolean', description: 'Allow data-changing requests to a production environment' },
          trustScripts: { type: 'boolean', description: "Let the scripts read secrets and call other hosts in the pipeline (adds --trust-scripts; off by default, only for a trusted workspace)" },
          timelineHtml: { type: 'boolean', description: 'One flow file: keep the run as an HTML timeline (test-results/timeline.html)' },
          evaluation: str('Instead of tests: a saved prompt evaluation run with `testpion eval run NAME --baseline last-good --fail-on-regression` (fails when a case got worse); the model key is a CI secret'),
          ragEvaluation: str('Instead of tests: a saved RAG evaluation run with `testpion rag run` (metrics, gates, JUnit and HTML report); the judge key is a CI secret'),
          ragPreset: str('With ragEvaluation: a metric preset (rag_metrics lists them)'),
          ragJudge: str('With ragEvaluation: the judge as provider/model'),
          ragMin: { type: 'array', items: { type: 'string' }, description: 'With ragEvaluation: gates "metric=value", e.g. ["faithfulness=0.8"]; a failed gate fails the pipeline' },
          ragBaseline: str('With ragEvaluation: a run id to compare with, metric by metric'),
          ragMaxCost: { type: 'number', description: 'With ragEvaluation: stop judging once this much (USD) is spent' },
          ragCompat: str('With ragEvaluation: ragas reads the Ragas metric names with Ragas options'),
          ragRepeatTarget: { type: 'number', description: 'With ragEvaluation: call the RAG system this many times per question (2 to 10)' },
          ragNightly: { type: 'string', description: 'With ragEvaluation: a nightly job on this UTC cron ("0 3 * * *") instead of every push' },
          ragSample: { type: 'number', description: 'With ragNightly: score this many questions per night (a different set daily)' },
          ragRegression: { type: 'boolean', description: 'With ragNightly: fail when a metric dropped since the previous night (GitHub, GitLab, Azure)' },
          ragMaxDrop: { type: 'number', description: 'With ragRegression: the smallest drop that fails (default 0.05)' },
          ragComment: { type: 'boolean', description: 'With ragEvaluation on GitHub: post the metrics table as a pull-request comment' },
          environment: str('Environment name'),
          workspaceDir: str('The workspace folder relative to the repository root (default ".")'),
          openapi: str('OpenAPI document in the repository: pull requests fail on breaking changes against the target branch'),
          start: str('Integration tests: command that starts the system under test in the background (e.g. "npm start")'),
          waitFor: str('With start: a URL polled until it answers before the tests run (the health check)'),
          waitSeconds: { type: 'number', description: 'How long to wait for it (default 90)' },
          runId: str('Instead of suite / collection / tests: a finished run (id, or "last"): the pipeline runs what it ran, in its environment'),
        },
        required: ['provider'],
      },
      run: (a) => {
        if (!a.runId) return ciConfig(store, a as unknown as CiConfigOptions);
        const { target, environment, note } = ciTargetOfRun(store, finishedRun(store, String(a.runId)));
        const { runId: _run, ...rest } = a;
        return { ...ciConfig(store, { ...(rest as unknown as CiConfigOptions), ...target, environment: a.environment ? String(a.environment) : environment }), ...(note ? { note } : {}) };
      },
    },
    {
      name: 'list_certificates',
      description: 'TLS certificates of the HTTPS hosts this workspace has called (app, test runs, monitors, agents), soonest to expire first: host, subject, issuer, valid until, days left, last seen.',
      inputSchema: { type: 'object', properties: { withinDays: { type: 'number', description: 'Only those that expire within this many days' } } },
      run: (a) => listCertificates(store).filter((c) => a.withinDays === undefined || (c.daysLeft !== undefined && c.daysLeft <= Number(a.withinDays))),
    },
    {
      name: 'trust_status',
      description: "What the user allowed this workspace on this computer: the programs it may start, the hosts its scripts may send to, whether its scripts may read secrets. Read-only: an agent cannot allow anything; the user does that in the app (Settings ▸ Privacy & security) or with `testpion trust`.",
      inputSchema: { type: 'object', properties: {} },
      run: () => trustSummary(store),
    },
    {
      name: 'llm_usage',
      description: 'What the prompts run in the TestPion AI Lab used, per provider and model, most tokens first: prompts run, input and output tokens, estimated cost, median time and time to first token, last used.',
      inputSchema: { type: 'object', properties: {} },
      run: () => llmUsage(store),
    },
    {
      name: 'mcp_tool_usage',
      description: "How the tools of the workspace's MCP servers have been called from the TestPion app, most called first: server, tool, calls, failed (isError or no result), median and p95 time, last used. Use it to see which tools are used, slow or failing.",
      inputSchema: { type: 'object', properties: { server: str('Only this MCP server (name or id)') } },
      run: (a) => {
        const all = mcpToolUsage(store);
        if (!a.server) return all;
        const q = String(a.server).toLowerCase();
        return all.filter((u) => u.serverId === a.server || u.server.toLowerCase() === q);
      },
    },
    {
      name: 'check_certificate',
      description: "Connect to a host (host, host:port or https URL) and read its TLS certificate now: subject, issuer, valid until, days left, whether this machine trusts it (and why not), TLS protocol. The result is also recorded for list_certificates.",
      inputSchema: { type: 'object', properties: { target: str('host, host:port or https URL') }, required: ['target'] },
      run: async (a) => {
        const c = await checkCertificate(String(a.target));
        recordCertificate(store, `https://${c.host}:${c.port}/`, c);
        return c;
      },
    },
  ];
}
