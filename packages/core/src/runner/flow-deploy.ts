/**
 * Where a flow is deployed: on a schedule (a monitor that runs the file), behind a webhook (its `webhook:` block, and
 * whether the webhook server serves it now), as an MCP tool (its `expose:` block) and in CI (a pipeline file of the
 * repository that runs it). The app's Deploy panel (tests.deployStatus) and the flow_deploy_status MCP tool read it.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import type { WorkspaceStore } from '../storage/workspace.js';
import { readExposure } from './exposed-flows.js';
import { webhookFlows, webhookOfText } from './flow-webhook-config.js';
import { formatEvery, lastMonitorResult, listMonitors, monitorTestFile } from './monitors.js';

export interface FlowDeployStatus {
  file: string;
  /** A monitor that runs this file on a schedule (its testFile). */
  schedule?: { monitorId: string; name: string; every: string; enabled: boolean; lastStatus?: string };
  /** Its webhook: the path, the URL while the server serves it, whether callers need a secret. */
  webhook?: { path: string; url?: string; serving: boolean; secret: boolean; problem?: string };
  /** The MCP tool it is offered as (expose.tool). */
  mcp?: { name: string };
  /** A CI pipeline file of the repository runs it (by its path, or every test). */
  ci: boolean;
  /** The CI files that run it (relative to the workspace folder). */
  ciFiles?: string[];
}

/** CI pipeline files of the repository the workspace is in (the workspace folder up to the git root, at most 6 levels). */
export function ciPipelineFiles(root: string): string[] {
  const out: string[] = [];
  let dir = root;
  for (let depth = 0; depth < 6; depth++) {
    for (const f of ['.gitlab-ci.yml', 'azure-pipelines.yml', 'Jenkinsfile', 'bitbucket-pipelines.yml']) if (existsSync(join(dir, f))) out.push(join(dir, f));
    const wf = join(dir, '.github', 'workflows');
    try {
      for (const f of readdirSync(wf)) if (/\.ya?ml$/i.test(f)) out.push(join(wf, f));
    } catch {
      // no workflows here
    }
    if (existsSync(join(dir, '.git'))) break;
    const up = dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return out;
}

/** Whether a pipeline's text runs this file: it names tests/<file>, or runs the whole tests folder (`testpion test tests …`). */
export function ciRunsFile(text: string, file: string): boolean {
  const rel = file.replace(/\\/g, '/').replace(/^tests\//, '');
  if (text.includes(`tests/${rel}`)) return true;
  return /\btest\s+"?(?:[^\s"]*\/)?tests\/?"?(?=\s|$)/m.test(text);
}

/** Where the test file `file` (inside tests/) is deployed. `serving`: the running webhook server's base URL. */
export function flowDeployStatus(store: WorkspaceStore, file: string, opts: { serving?: { url: string } } = {}): FlowDeployStatus {
  const rel = file.replace(/\\/g, '/').replace(/^tests\//, '');
  const text = store.readTestFile(rel);
  const out: FlowDeployStatus = { file: rel, ci: false };

  const monitor = listMonitors(store).find((m) => !!m.testFile && monitorTestFile(m.testFile) === rel);
  if (monitor) {
    const last = lastMonitorResult(store, monitor.id);
    out.schedule = { monitorId: monitor.id, name: monitor.name, every: formatEvery(monitor.everyMinutes), enabled: monitor.enabled, ...(last ? { lastStatus: last.status } : {}) };
  }

  const own = webhookOfText(text, rel);
  if (own) {
    // the workspace's view of it (a path another file took first is a problem)
    const hook = own.problem ? own : (webhookFlows(store.path('tests')).find((h) => h.file === rel) ?? own);
    const serving = !!opts.serving && !hook.problem;
    out.webhook = { path: hook.path, ...(serving ? { url: opts.serving!.url + hook.path } : {}), serving, secret: !!hook.secret, ...(hook.problem ? { problem: hook.problem } : {}) };
  }

  try {
    const e = readExposure(text, rel);
    if (e) out.mcp = { name: e.tool };
  } catch {
    // an invalid expose: block offers no tool
  }

  const ciFiles: string[] = [];
  for (const f of ciPipelineFiles(store.root)) {
    try {
      if (statSync(f).size > 1024 * 1024) continue;
      if (ciRunsFile(readFileSync(f, 'utf8'), rel)) ciFiles.push(f);
    } catch {
      // unreadable: not counted
    }
  }
  if (ciFiles.length) {
    out.ci = true;
    out.ciFiles = ciFiles.map((f) => relative(store.root, f).replace(/\\/g, '/'));
  }
  return out;
}
