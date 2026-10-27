import { ApsError } from '../errors.js';
import { defaultSettings, type AppSettings } from '../model/types.js';
import type { WorkspaceManager } from './workspace-manager.js';

/**
 * The app settings as a command line and an agent read and change them (`testpion settings get|set|reset`, the MCP tools
 * get_settings / set_settings): the same keys as Settings in the app, dotted for the groups (`loadTesting.maxVirtualUsers`).
 * Values that are not settings of the person's choice (the last workspace, the list of workspaces, schema revisions) and
 * values that could hold a secret (global variables) are never shown or set here.
 */
type Kind = 'boolean' | 'number' | 'text' | 'list' | { oneOf: string[] };

interface Spec {
  kind: Kind;
  /** Plain words: what it does, for `settings get --describe` and the tool's answer. */
  doc: string;
}

export const SETTING_SPECS: Record<string, Spec> = {
  theme: { kind: { oneOf: ['system', 'light', 'dark'] }, doc: 'Colour theme.' },
  fontSize: { kind: 'number', doc: 'Font size in pixels (11 to 20).' },
  responseLayout: { kind: { oneOf: ['auto', 'side', 'below'] }, doc: 'Where the response goes in the request editors.' },
  reducedMotion: { kind: 'boolean', doc: 'Turn off animations.' },
  density: { kind: { oneOf: ['comfortable', 'compact'] }, doc: 'Row heights and spacing.' },
  logLevel: { kind: { oneOf: ['ERROR', 'WARN', 'INFO', 'DEBUG', 'TRACE'] }, doc: 'How much the app writes to its log.' },
  redactFields: { kind: 'list', doc: 'Field names always hidden in logs, traces, reports and exports.' },
  envVariables: { kind: 'list', doc: 'OS environment variables that {{$env.NAME}} may read in the app.' },
  defaultTimeoutMs: { kind: 'number', doc: 'Request timeout in milliseconds when a request sets none.' },
  maxPreviewBytes: { kind: 'number', doc: 'Largest response body shown in the app, in bytes.' },
  checkForUpdates: { kind: 'boolean', doc: 'Ask GitHub for a newer version when the app starts.' },
  notifyRunFinished: { kind: 'boolean', doc: 'A desktop notification when a run finishes while the app is in the background.' },
  'loadTesting.allowRemoteHosts': { kind: 'boolean', doc: 'Allow load tests against hosts that are not on this computer.' },
  'loadTesting.maxVirtualUsers': { kind: 'number', doc: 'Most virtual users a load test may use.' },
  'proxy.mode': { kind: { oneOf: ['env', 'custom', 'off'] }, doc: 'Outbound proxy: from the environment, a custom one, or none.' },
  'proxy.url': { kind: 'text', doc: 'The custom proxy URL.' },
  'proxy.bypass': { kind: 'text', doc: 'Hosts that skip the proxy (comma separated).' },
  'proxy.username': { kind: 'text', doc: 'The proxy user name (the password is in the secret store).' },
  'tls.systemCa': { kind: 'boolean', doc: 'Also trust the certificates of the operating system.' },
  'git.autoFetchMinutes': { kind: 'number', doc: 'How often the app fetches in the background, in minutes (0: never).' },
  'ai.localOnly': { kind: 'boolean', doc: 'AI only with models on this computer.' },
  'ai.privacy': { kind: { oneOf: ['full', 'metadata', 'names'] }, doc: 'What an AI action starts with: full (redacted), metadata or names only.' },
  'ai.maskPersonalData': { kind: 'boolean', doc: 'Mask e-mail addresses, phone numbers and card numbers before AI calls.' },
  'ai.maxTokensPerCall': { kind: 'number', doc: 'Most tokens one AI call may use (0: no cap).' },
  'ai.dailyTokens': { kind: 'number', doc: 'Most tokens the AI features may use per day (0: no cap).' },
  'ai.dailyBudgetUsd': { kind: 'number', doc: 'Most estimated cost per day in US dollars (0: no cap).' },
  'ai.hidden': { kind: 'boolean', doc: 'Hide every AI action of the window.' },
  'ai.preferStable': { kind: 'boolean', doc: 'Suggested checks avoid values that change (ids, times, tokens).' },
  assistantProvider: { kind: 'text', doc: 'The provider of the AI assistant.' },
  assistantModel: { kind: 'text', doc: 'The model of the AI assistant.' },
  confirmUnresolvedSend: { kind: 'boolean', doc: 'Ask before a request that changes data (POST, PUT, PATCH, DELETE) is sent with a {{variable}} that has no value.' },
};

/** Settings that are not the person's choice, or could hold a secret: never listed or set here. */
export const HIDDEN_SETTINGS = ['schemaVersion', 'lastWorkspace', 'workspacePaths', 'examplesOfferedVersion', 'settingsRevision', 'globalVariables', 'telemetry', 'keybindings', 'rail', 'pricing', 'tls', 'ai'];

const bad = (message: string, suggestions: string[]) => new ApsError('ValidationError', message, { suggestions });

const read = (o: unknown, path: string): unknown => path.split('.').reduce<unknown>((v, k) => (v && typeof v === 'object' ? (v as Record<string, unknown>)[k] : undefined), o);

function write(o: Record<string, unknown>, path: string, value: unknown): void {
  const parts = path.split('.');
  let at = o;
  for (const k of parts.slice(0, -1)) at = (at[k] && typeof at[k] === 'object' ? at[k] : (at[k] = {})) as Record<string, unknown>;
  if (value === undefined) delete at[parts.at(-1)!];
  else at[parts.at(-1)!] = value;
}

/** The settings as shown: every setting of the person's choice, with its value (default when unset), nothing that could be a secret. */
export function describeSettings(settings: AppSettings): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const defaults = defaultSettings();
  for (const key of Object.keys(SETTING_SPECS)) out[key] = read(settings, key) ?? read(defaults, key) ?? null;
  const g = settings.globalVariables ?? [];
  out.globalVariables = g.map((v) => v.key);
  out.pricing = (settings.pricing ?? []).length;
  return out;
}

/** The value of `text` as the setting wants it. */
export function parseSettingValue(key: string, text: string): unknown {
  const spec = SETTING_SPECS[key];
  if (!spec) throw bad(`No setting called "${key}"`, [`The settings: ${Object.keys(SETTING_SPECS).join(', ')}.`]);
  const kind = spec.kind;
  if (kind === 'boolean') {
    if (/^(true|on|yes|1)$/i.test(text)) return true;
    if (/^(false|off|no|0)$/i.test(text)) return false;
    throw bad(`${key} is true or false, not "${text}"`, ['Use true or false.']);
  }
  if (kind === 'number') {
    const n = Number(text);
    if (text.trim() === '' || !Number.isFinite(n) || n < 0) throw bad(`${key} is a number, 0 or more, not "${text}"`, []);
    if (key === 'fontSize' && (n < 11 || n > 20)) throw bad('fontSize is from 11 to 20', []);
    return n;
  }
  if (kind === 'list') return text.split(/[\n,]/).map((x) => x.trim()).filter(Boolean);
  if (typeof kind === 'object') {
    if (!kind.oneOf.includes(text)) throw bad(`${key} is one of ${kind.oneOf.join(', ')}, not "${text}"`, []);
    return text;
  }
  return text;
}

/** `current` with `changes` applied (keys checked as `settings set` checks them); nothing is saved. Also what changed (key, before, after). */
export function applySettings(current: AppSettings, changes: Record<string, unknown>): { next: AppSettings; changed: Array<{ key: string; before: unknown; after: unknown }> } {
  const next = structuredClone(current) as unknown as Record<string, unknown>;
  const changed: Array<{ key: string; before: unknown; after: unknown }> = [];
  for (const [key, value] of Object.entries(changes)) {
    if (!SETTING_SPECS[key]) throw bad(`No setting called "${key}"`, [`The settings: ${Object.keys(SETTING_SPECS).join(', ')}.`]);
    changed.push({ key, before: read(current, key) ?? null, after: value });
    write(next, key, value);
  }
  return { next: next as unknown as AppSettings, changed };
}

/** Change settings (`key=value` pairs, already parsed): returns the new settings and what changed (key, before, after). */
export function changeSettings(mgr: WorkspaceManager, changes: Record<string, unknown>, o: { dryRun?: boolean } = {}): { changed: Array<{ key: string; before: unknown; after: unknown }>; settings: Record<string, unknown> } {
  const { next, changed } = applySettings(mgr.loadSettings(), changes);
  const saved = o.dryRun ? next : mgr.saveSettings(next);
  return { changed, settings: describeSettings(saved) };
}

/** `current` with the settings named (or all of them) back at their defaults; nothing is saved. Also which ones changed. */
export function settingsDefaults(current: AppSettings, keys: string[] | 'all'): { next: AppSettings; reset: string[] } {
  const list = keys === 'all' ? Object.keys(SETTING_SPECS) : keys;
  const defaults = defaultSettings();
  const changes: Record<string, unknown> = {};
  for (const k of list) {
    if (!SETTING_SPECS[k]) throw bad(`No setting called "${k}"`, [`The settings: ${Object.keys(SETTING_SPECS).join(', ')}.`]);
    const d = read(defaults, k);
    if (JSON.stringify(read(current, k) ?? null) !== JSON.stringify(d ?? null)) changes[k] = d;
  }
  const next = structuredClone(current) as unknown as Record<string, unknown>;
  for (const [k, v] of Object.entries(changes)) write(next, k, v);
  return { next: next as unknown as AppSettings, reset: Object.keys(changes) };
}

/** Put settings back to their defaults (all of them, or the keys named). */
export function resetSettings(mgr: WorkspaceManager, keys: string[] | 'all', o: { dryRun?: boolean } = {}) {
  const { next, reset } = settingsDefaults(mgr.loadSettings(), keys);
  const saved = o.dryRun || !reset.length ? next : mgr.saveSettings(next);
  return { reset, settings: describeSettings(saved) };
}

/** The file Settings ▸ About exports and `testpion settings get --json` prints: the settings of the person's choice, with a format name. */
export interface SettingsExport {
  format: 'testpion-settings';
  version: 1;
  settings: Record<string, unknown>;
}

export function exportSettings(settings: AppSettings): SettingsExport {
  const all = describeSettings(settings);
  return { format: 'testpion-settings', version: 1, settings: Object.fromEntries(Object.entries(all).filter(([k]) => SETTING_SPECS[k])) };
}

/**
 * Settings from an exported file, each checked as `settings set` checks it (a wrong value names its setting and changes nothing).
 * Keys this version does not know are skipped and named; nothing is saved here.
 */
export function importSettings(current: AppSettings, doc: unknown): { next: AppSettings; changed: Array<{ key: string; before: unknown; after: unknown }>; skipped: string[] } {
  const body = doc && typeof doc === 'object' ? (doc as { format?: unknown; settings?: unknown }) : {};
  if (body.format !== 'testpion-settings' || !body.settings || typeof body.settings !== 'object')
    throw bad('That is not a TestPion settings file', ['Export the settings from Settings ▸ About (or run testpion settings get --json) and import that file.']);
  const changes: Record<string, unknown> = {};
  const skipped: string[] = [];
  for (const [key, value] of Object.entries(body.settings as Record<string, unknown>)) {
    if (!SETTING_SPECS[key]) {
      skipped.push(key);
      continue;
    }
    // null is "not set" (the file lists every setting): that is the default again
    if (value === null) {
      changes[key] = read(defaultSettings(), key);
      continue;
    }
    changes[key] = parseSettingValue(key, Array.isArray(value) ? value.join('\n') : String(value ?? ''));
  }
  const { next, changed } = applySettings(current, changes);
  return { next, changed: changed.filter((c) => JSON.stringify(c.before ?? null) !== JSON.stringify(c.after ?? null)), skipped };
}
