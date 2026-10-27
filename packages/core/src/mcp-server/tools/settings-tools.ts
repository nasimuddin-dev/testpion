import { WorkspaceManager } from '../../storage/workspace-manager.js';
import { SETTING_SPECS, changeSettings, describeSettings, parseSettingValue, resetSettings } from '../../storage/settings-access.js';
import type { Tool } from '../tool.js';

/**
 * The app's settings for agents (`testpion settings get|set|reset` is the CLI twin): per computer, the ones in Settings in
 * the window. Secrets and the lists the app keeps for itself are never shown or set.
 */
export function settingsTools(): Tool[] {
  return [
    {
      name: 'get_settings',
      description:
        'The app settings of this computer (the ones in Settings in the window) with their values, defaults filled in: timeout, preview size, proxy mode, redaction field names, load-test limits, AI caps and more. Never secrets (the proxy password, API keys) and never the lists the app keeps for itself. With `describe: true`, what each setting does and what it accepts.',
      inputSchema: { type: 'object', properties: { key: { type: 'string', description: 'One setting, e.g. defaultTimeoutMs or ai.dailyBudgetUsd' }, describe: { type: 'boolean', description: 'Add what each setting does and what it accepts' } } },
      run: (a) => {
        const all = describeSettings(new WorkspaceManager().loadSettings());
        const data = typeof a.key === 'string' && a.key ? { [a.key]: all[a.key] } : all;
        return a.describe === true ? { settings: data, describe: Object.fromEntries(Object.entries(SETTING_SPECS).map(([k, v]) => [k, { doc: v.doc, accepts: typeof v.kind === 'object' ? v.kind.oneOf : v.kind }])) } : { settings: data };
      },
    },
    {
      name: 'set_settings',
      write: true,
      description:
        'Change app settings of this computer, or put them back to their defaults. `settings` is { key: value } (numbers and booleans as such, lists as arrays); `reset` is a list of keys or "all". Returns what changed (before and after). Ask the user first: it changes the app for every workspace.',
      inputSchema: {
        type: 'object',
        properties: {
          settings: { type: 'object', description: 'Setting → new value, e.g. { "defaultTimeoutMs": 60000, "ai.dailyBudgetUsd": 2 }' },
          reset: { description: 'Keys to put back to the default, or "all"', anyOf: [{ type: 'array', items: { type: 'string' } }, { type: 'string' }] },
        },
      },
      run: (a) => {
        const mgr = new WorkspaceManager();
        const out: Record<string, unknown> = {};
        if (a.reset) Object.assign(out, resetSettings(mgr, a.reset === 'all' ? 'all' : ([] as unknown[]).concat(a.reset).map(String)));
        if (a.settings && typeof a.settings === 'object') {
          const changes = Object.fromEntries(Object.entries(a.settings as Record<string, unknown>).map(([k, v]) => [k, parseSettingValue(k, Array.isArray(v) ? v.join(',') : String(v))]));
          Object.assign(out, changeSettings(mgr, changes));
        }
        return Object.keys(out).length ? out : { settings: describeSettings(mgr.loadSettings()), note: 'Nothing asked for: pass `settings` or `reset`.' };
      },
    },
  ];
}
