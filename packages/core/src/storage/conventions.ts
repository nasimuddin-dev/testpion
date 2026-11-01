/**
 * Team conventions as lint: a `conventions.yaml` next to workspace.json says how this team names and files things (a
 * pattern for collection, request and environment names; every environment in a group; every collection owned in
 * CODEOWNERS; every monitor with an alert webhook). What breaks them is a problem of Needs attention (group "Team
 * conventions", a warning), `testpion workspace conventions` lists them, and `--init` writes the file with every rule
 * explained and off. Names and patterns only: no value of a variable is read.
 */
import { existsSync, readFileSync } from 'node:fs';
import type { ItemRef } from '@testpion/shared';
import { collectionRequests } from '../runner/collection-run.js';
import { listMonitorDefinitions } from '../runner/monitors.js';
import { parseYamlShared } from '../util/lazy-yaml.js';
import { toRepoPath } from '../git/git.js';
import { ownersOf, workspaceCodeowners } from '../git/owners.js';
import { atomicWrite } from './fsutil.js';
import type { WorkspaceStore } from './workspace.js';

export const CONVENTIONS_FILE = 'conventions.yaml';

export interface Conventions {
  collections?: { name?: string; owner?: 'required' };
  requests?: { name?: string };
  environments?: { name?: string; group?: 'required' };
  monitors?: { webhook?: 'required'; environment?: 'required' };
}

export interface ConventionFinding {
  /** Which rule: "collections.name", "environments.group" … */
  rule: string;
  message: string;
  ref: ItemRef & { collectionId?: string; requestId?: string; environmentId?: string; monitorId?: string };
}

/** The file with every rule explained, off (commented) until the team turns one on. */
export const CONVENTIONS_TEMPLATE = `# Team conventions TestPion checks (Needs attention, testpion workspace conventions).
# Uncomment a rule to turn it on. Patterns are regular expressions over the whole name.
collections:
  # name: "^[a-z]+-[a-z0-9-]+$"   # team-service, as in payments-invoices
  # owner: required               # every collection has an owner in CODEOWNERS
requests:
  # name: "^[A-Z]"                # request names start with a capital
environments:
  # name: "^(Local|Staging|Production)$"
  # group: required               # every environment belongs to a group (a tenant, a customer)
monitors:
  # webhook: required             # every monitor alerts somewhere
  # environment: required         # every monitor says where it runs
`;

const conventionsPath = (store: WorkspaceStore) => store.path(CONVENTIONS_FILE);

/** The conventions of the workspace; undefined without the file. A file that cannot be read throws with its reason. */
export function readConventions(store: WorkspaceStore): Conventions | undefined {
  const file = conventionsPath(store);
  if (!existsSync(file)) return undefined;
  const value = parseYamlShared(readFileSync(file, 'utf8'));
  if (value === null || value === undefined) return {};
  if (typeof value !== 'object' || Array.isArray(value)) throw new Error(`${CONVENTIONS_FILE} must be a mapping of collections, requests, environments and monitors`);
  const c = value as Conventions;
  for (const [section, key] of [
    ['collections', 'name'],
    ['requests', 'name'],
    ['environments', 'name'],
  ] as const) {
    const p = (c[section] as { name?: unknown } | undefined)?.name;
    if (p !== undefined) {
      if (typeof p !== 'string') throw new Error(`${section}.name must be a pattern (a string)`);
      try {
        new RegExp(p);
      } catch {
        throw new Error(`${section}.${key} is not a regular expression: ${p}`);
      }
    }
  }
  return c;
}

/** Write the explained template; false when the file exists already (nothing is overwritten). */
export function initConventions(store: WorkspaceStore): boolean {
  if (existsSync(conventionsPath(store))) return false;
  atomicWrite(conventionsPath(store), CONVENTIONS_TEMPLATE);
  return true;
}

const matches = (pattern: string | undefined, name: string) => !pattern || new RegExp(pattern).test(name);

/** What breaks the team's conventions; nothing without the file. */
export async function conventionFindings(store: WorkspaceStore, conventions = readConventions(store)): Promise<ConventionFinding[]> {
  if (!conventions) return [];
  const out: ConventionFinding[] = [];
  const collections = store.listCollections().filter((c) => !c.problem);
  const needOwner = conventions.collections?.owner === 'required';
  const co = needOwner ? await workspaceCodeowners(store.root).catch(() => undefined) : undefined;
  for (const c of collections) {
    if (!matches(conventions.collections?.name, c.name)) out.push({ rule: 'collections.name', message: `Collection "${c.name}" does not match the team's pattern ${conventions.collections!.name}`, ref: { kind: 'collection', collectionId: c.id } });
    if (needOwner) {
      const owners = co ? ownersOf(co.rules, toRepoPath(co.repo, store.root, store.collectionFileOf(c.id))) : [];
      if (!owners.length) out.push({ rule: 'collections.owner', message: `Collection "${c.name}" has no owner in CODEOWNERS`, ref: { kind: 'collection', collectionId: c.id } });
    }
    if (conventions.requests?.name)
      for (const r of collectionRequests(c)) if (!matches(conventions.requests.name, r.name)) out.push({ rule: 'requests.name', message: `Request "${[c.name, ...r.path, r.name].join(' › ')}" does not match the team's pattern ${conventions.requests.name}`, ref: { kind: 'request', collectionId: c.id, requestId: r.id } });
  }
  for (const e of store.listEnvironments().filter((e) => !e.problem)) {
    if (!matches(conventions.environments?.name, e.name)) out.push({ rule: 'environments.name', message: `Environment "${e.name}" does not match the team's pattern ${conventions.environments!.name}`, ref: { kind: 'environment', environmentId: e.id } });
    if (conventions.environments?.group === 'required' && !e.group?.trim()) out.push({ rule: 'environments.group', message: `Environment "${e.name}" is in no group (a tenant, a customer, a deployment)`, ref: { kind: 'environment', environmentId: e.id } });
  }
  for (const m of listMonitorDefinitions(store)) {
    if (conventions.monitors?.webhook === 'required' && !m.webhook?.trim()) out.push({ rule: 'monitors.webhook', message: `Monitor "${m.name}" alerts nowhere: give it a webhook`, ref: { kind: 'monitor', monitorId: m.id } });
    if (conventions.monitors?.environment === 'required' && !m.environment && !m.environmentGroup) out.push({ rule: 'monitors.environment', message: `Monitor "${m.name}" says no environment`, ref: { kind: 'monitor', monitorId: m.id } });
  }
  return out;
}
