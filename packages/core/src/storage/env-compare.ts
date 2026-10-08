import type { Environment } from '../model/types.js';
import type { WorkspaceStore } from './workspace.js';
import type { SecretStore } from './secrets.js';
import { secretKeys } from './secrets.js';
import { Redactor } from '../util/redact.js';

/**
 * Compare two environments variable by variable, to catch configuration drift ("works on Staging,
 * broken on Production"): a key missing on one side, a different value, a disabled variable, a secret
 * that is set on one side only. Secret values are never read into the result, only whether they are set.
 */
export type EnvDiffStatus = 'same' | 'different' | 'only-left' | 'only-right';

export interface EnvDiffRow {
  key: string;
  status: EnvDiffStatus;
  /** Values, when requested and not sensitive (secrets and sensitive-looking keys are masked). */
  left?: string;
  right?: string;
  secret?: boolean;
  /** Which side stores it as a secret (a key can be a secret in one environment and plain in the other). */
  secretLeft?: boolean;
  secretRight?: boolean;
  /** Disabled on a side (a disabled variable is not used). */
  disabledLeft?: boolean;
  disabledRight?: boolean;
  /** For secrets: whether a value is stored on each side. */
  secretSetLeft?: boolean;
  secretSetRight?: boolean;
}

export interface EnvDiff {
  left: string;
  right: string;
  rows: EnvDiffRow[];
  summary: { same: number; different: number; onlyLeft: number; onlyRight: number };
}

export interface EnvDiffOptions {
  /** Include values (masked when secret or sensitive). Default false: statuses only (for agents). */
  values?: boolean;
  /** To tell whether secret variables have a value stored. */
  secrets?: SecretStore;
  redactor?: Redactor;
}

const MASK = '••••••';

export function compareEnvironments(left: Environment, right: Environment, opts: EnvDiffOptions = {}): EnvDiff {
  const redactor = opts.redactor ?? new Redactor();
  const index = (e: Environment) => new Map(e.variables.filter((v) => v.key).map((v) => [v.key, v]));
  const l = index(left);
  const r = index(right);
  const secretSet = (env: Environment, key: string) => {
    if (!opts.secrets) return undefined;
    const v = opts.secrets.get(secretKeys.envVar(env.id, key));
    return v !== undefined && v !== '';
  };
  const secretValue = (env: Environment, key: string) => opts.secrets?.get(secretKeys.envVar(env.id, key)) ?? '';
  const keys = [...new Set([...l.keys(), ...r.keys()])].sort((a, b) => a.localeCompare(b));
  const rows: EnvDiffRow[] = keys.map((key) => {
    const a = l.get(key);
    const b = r.get(key);
    const secret = !!(a?.secret || b?.secret);
    const sensitiveKey = redactor.isSensitiveKey(key);
    let status: EnvDiffStatus;
    if (!b) status = 'only-left';
    else if (!a) status = 'only-right';
    else {
      // secrets compare by their stored values when the store is available (the values are not returned)
      const va = a.secret ? secretValue(left, key) : a.value;
      const vb = b.secret ? secretValue(right, key) : b.value;
      status = va === vb && !!a.secret === !!b.secret && (a.enabled !== false) === (b.enabled !== false) ? 'same' : 'different';
    }
    const row: EnvDiffRow = { key, status };
    if (secret) row.secret = true;
    if (a?.secret) row.secretLeft = true;
    if (b?.secret) row.secretRight = true;
    if (a && a.enabled === false) row.disabledLeft = true;
    if (b && b.enabled === false) row.disabledRight = true;
    if (opts.secrets) {
      if (a?.secret) row.secretSetLeft = !!secretSet(left, key);
      if (b?.secret) row.secretSetRight = !!secretSet(right, key);
    }
    if (opts.values) {
      if (a) row.left = a.secret || sensitiveKey ? MASK : a.value;
      if (b) row.right = b.secret || sensitiveKey ? MASK : b.value;
    }
    return row;
  });
  const count = (s: EnvDiffStatus) => rows.filter((x) => x.status === s).length;
  return { left: left.name, right: right.name, rows, summary: { same: count('same'), different: count('different'), onlyLeft: count('only-left'), onlyRight: count('only-right') } };
}

/** One variable in one environment of the matrix: set, set but empty, missing, or disabled. */
export interface EnvMatrixCell {
  state: 'set' | 'empty' | 'missing' | 'disabled';
  secret?: boolean;
}

export interface EnvMatrixRow {
  key: string;
  /** One cell per environment, in the order of `environments`. */
  cells: EnvMatrixCell[];
  /** Environments where the variable is missing, empty or disabled. */
  incompleteIn: string[];
  /** Plain (non-secret) values differ between the environments that set it. */
  differs: boolean;
}

/**
 * Every variable across every environment (statuses only, never values): what is missing, empty or disabled where,
 * incomplete variables first. Secrets count as set when the secret store has a value.
 */
export function environmentMatrix(source: Pick<WorkspaceStore, 'listEnvironments' | 'getEnvironment'> | Environment[], opts: { secrets?: SecretStore } = {}): { environments: string[]; rows: EnvMatrixRow[]; incomplete: number } {
  const envs = Array.isArray(source) ? source : source.listEnvironments().map((e) => source.getEnvironment(e.id)!).filter(Boolean);
  const keys = [...new Set(envs.flatMap((e) => e.variables.filter((v) => v.key).map((v) => v.key)))];
  const rows: EnvMatrixRow[] = keys.map((key) => {
    const values = new Set<string>();
    const cells = envs.map((e): EnvMatrixCell => {
      const v = e.variables.find((x) => x.key === key);
      if (!v) return { state: 'missing' };
      const secret = !!v.secret;
      const value = secret ? (opts.secrets?.get(secretKeys.envVar(e.id, key)) ?? (opts.secrets ? '' : '?')) : v.value;
      if (v.enabled === false) return { state: 'disabled', ...(secret ? { secret } : {}) };
      if (!value) return { state: 'empty', ...(secret ? { secret } : {}) };
      if (!secret) values.add(value);
      return { state: 'set', ...(secret ? { secret } : {}) };
    });
    const incompleteIn = envs.filter((_, i) => cells[i]!.state !== 'set').map((e) => e.name);
    return { key, cells, incompleteIn, differs: values.size > 1 };
  });
  rows.sort((a, b) => b.incompleteIn.length - a.incompleteIn.length || a.key.localeCompare(b.key));
  return { environments: envs.map((e) => e.name), rows, incomplete: rows.filter((r) => r.incompleteIn.length).length };
}
