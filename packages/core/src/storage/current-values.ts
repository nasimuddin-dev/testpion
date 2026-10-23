import { PRIVATE_FILE_MODE, readJson, writeJson } from './fsutil.js';
import type { SecretStore } from './secrets.js';
import type { ScriptScope } from '../scripts/sandbox.js';
import type { Redactor } from '../util/redact.js';
import type { VariableScope } from '../vars/variables.js';

interface CurrentValuesFile {
  schemaVersion: '1.0';
  environment: Record<string, Record<string, unknown>>;
  globals: Record<string, unknown>;
  collectionVariables: Record<string, Record<string, unknown>>;
  /** keys whose values live in the secret store: `${scope}/${owner}/${key}` */
  secretKeys: string[];
}

/**
 * Postman-style "current values": values set by scripts (tp.environment.set, tp.globals.set,
 * tp.collectionVariables.set) that persist on this machine only — never in workspace files, so
 * they are not committed to git. Sensitive values (token, password, …, or variables marked secret)
 * are kept in the encrypted secret store.
 */
export class CurrentValues {
  private data: CurrentValuesFile;

  constructor(
    private path: string,
    private secrets: SecretStore,
    private workspaceId: string,
  ) {
    this.data = { schemaVersion: '1.0', environment: {}, globals: {}, collectionVariables: {}, secretKeys: [], ...readJson<Partial<CurrentValuesFile>>(path, {}) } as CurrentValuesFile;
  }

  private secretName(id: string): string {
    return `current.${this.workspaceId}.${id}`;
  }

  private bucket(scope: ScriptScope, owner: string): Record<string, unknown> {
    if (scope === 'globals') return this.data.globals;
    const map = scope === 'environment' ? this.data.environment : this.data.collectionVariables;
    return (map[owner] ??= {});
  }

  /** Values for one scope/owner (secret values resolved). */
  get(scope: ScriptScope, owner = ''): Record<string, unknown> {
    const b = { ...this.bucket(scope, owner) };
    const prefix = `${scope}/${owner}/`;
    for (const id of this.data.secretKeys) {
      if (!id.startsWith(prefix)) continue;
      const v = this.secrets.get(this.secretName(id));
      if (v !== undefined) b[id.slice(prefix.length)] = v;
    }
    return b;
  }

  private dirty = false;
  private timer: ReturnType<typeof setTimeout> | undefined;
  /** Writes made so far (the file is rewritten whole each time; scripts that set a variable per request would otherwise fsync once per request). */
  writes = 0;

  /** Write the file now if a deferred change is waiting. */
  flush(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    if (!this.dirty) return;
    this.dirty = false;
    this.writes++;
    writeJson(this.path, this.data, { mode: PRIVATE_FILE_MODE });
  }

  private save(defer: boolean): void {
    this.dirty = true;
    if (!defer) return this.flush();
    // a run's scripts set variables on every request: written once the burst is over (and at the end of the run, and on close)
    this.timer ??= setTimeout(() => this.flush(), 500);
    this.timer.unref?.();
  }

  /** `defer`: the file is written within half a second (coalesced with the next sets) instead of before this returns. */
  async set(scope: ScriptScope, owner: string, key: string, value: unknown, sensitive: boolean, opts: { defer?: boolean } = {}): Promise<void> {
    const id = `${scope}/${owner}/${key}`;
    const b = this.bucket(scope, owner);
    if (value === undefined) {
      delete b[key];
      if (this.data.secretKeys.includes(id)) {
        this.data.secretKeys = this.data.secretKeys.filter((k) => k !== id);
        await this.secrets.delete(this.secretName(id)).catch(() => undefined);
      }
    } else if (sensitive && this.secrets.writable) {
      delete b[key];
      await this.secrets.set(this.secretName(id), typeof value === 'string' ? value : JSON.stringify(value));
      if (!this.data.secretKeys.includes(id)) this.data.secretKeys.push(id);
    } else b[key] = value;
    this.save(!!opts.defer);
  }

  /** Remove current values (all, or for one environment / collection). */
  async reset(scope?: ScriptScope, owner?: string): Promise<void> {
    const drop = (id: string) => (!scope || id.startsWith(`${scope}/${owner ?? ''}`)) && this.secrets.delete(this.secretName(id)).catch(() => undefined);
    for (const id of this.data.secretKeys) await drop(id);
    this.data.secretKeys = scope ? this.data.secretKeys.filter((id) => !id.startsWith(`${scope}/${owner ?? ''}`)) : [];
    if (!scope) Object.assign(this.data, { environment: {}, globals: {}, collectionVariables: {} });
    else if (scope === 'globals') this.data.globals = {};
    else delete (scope === 'environment' ? this.data.environment : this.data.collectionVariables)[owner ?? ''];
    this.save(false);
  }

  /** Overlay current values onto a context's scopes (they override the stored initial values). */
  apply(vars: VariableScope, owners: { environment?: string; collectionId?: string }, redactor?: Redactor): void {
    const overlay = (scope: ScriptScope, owner: string, target: 'environment' | 'global' | 'collection') => {
      for (const [k, v] of Object.entries(this.get(scope, owner))) {
        vars.set(k, v, target);
        if (typeof v === 'string' && (redactor?.isSensitiveKey(k) || this.data.secretKeys.includes(`${scope}/${owner}/${k}`))) redactor?.addSecret(v);
      }
    };
    overlay('globals', '', 'global');
    if (owners.collectionId) overlay('collectionVariables', owners.collectionId, 'collection');
    if (owners.environment) overlay('environment', owners.environment, 'environment');
  }

  /** Counts for display ("3 current values"). */
  summary(): { environment: Record<string, number>; globals: number; collectionVariables: Record<string, number> } {
    const count = (o: Record<string, unknown>) => Object.keys(o).length;
    const secretCount = (scope: string, owner: string) => this.data.secretKeys.filter((k) => k.startsWith(`${scope}/${owner}/`)).length;
    return {
      environment: Object.fromEntries(Object.entries(this.data.environment).map(([e, v]) => [e, count(v) + secretCount('environment', e)])),
      globals: count(this.data.globals) + secretCount('globals', ''),
      collectionVariables: Object.fromEntries(Object.entries(this.data.collectionVariables).map(([c, v]) => [c, count(v) + secretCount('collectionVariables', c)])),
    };
  }
}
