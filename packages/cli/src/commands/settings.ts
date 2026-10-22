import { Command } from 'commander';
import { WorkspaceManager, SETTING_SPECS, changeSettings, describeSettings, parseSettingValue, resetSettings } from '@testpion/core';
import { CliError, EXIT, dim, green, respond } from '../shared.js';

/**
 * `testpion settings get|set|reset`: the app's settings (Settings in the window), per computer, for scripts and agents.
 * Secrets and the lists the app keeps for itself are never shown or set here.
 */
export function registerSettingsCommands(program: Command): void {
  const settings = program.command('settings').description("the app's settings (the ones in Settings in the window), per computer: show them, change them, put them back to their defaults");
  settings
    .command('get')
    .description('show the settings and their values (default when unset); with a key, just that one; --describe adds what each does')
    .argument('[key]', 'a setting, e.g. defaultTimeoutMs or ai.dailyBudgetUsd')
    .option('--describe', 'list every setting with what it does and what it accepts')
    .action((key: string | undefined, o: { describe?: boolean }) => {
      const all = describeSettings(new WorkspaceManager().loadSettings());
      if (key && !(key in all)) throw new CliError(`No setting called "${key}". The settings: ${Object.keys(SETTING_SPECS).join(', ')}.`, EXIT.CONFIG_ERROR);
      const data = key ? { [key]: all[key] } : all;
      const docs = o.describe ? Object.fromEntries(Object.entries(SETTING_SPECS).map(([k, v]) => [k, { doc: v.doc, accepts: typeof v.kind === 'object' ? v.kind.oneOf : v.kind }])) : undefined;
      respond(docs ? { settings: data, describe: docs } : data, () => {
        for (const [k, v] of Object.entries(data)) console.log(`${k.padEnd(32)} ${JSON.stringify(v)}${docs?.[k] ? dim(`  ${docs[k]!.doc}`) : ''}`);
      });
    });
  settings
    .command('set')
    .description('change settings: key=value pairs, e.g. defaultTimeoutMs=60000 theme=dark ai.dailyBudgetUsd=2 (lists are comma separated)')
    .argument('<pairs...>', 'key=value')
    .action((pairs: string[]) => {
      const changes: Record<string, unknown> = {};
      for (const p of pairs) {
        const i = p.indexOf('=');
        if (i <= 0) throw new CliError(`Give each setting as key=value, not "${p}"`, EXIT.CONFIG_ERROR);
        changes[p.slice(0, i)] = parseSettingValue(p.slice(0, i), p.slice(i + 1));
      }
      const r = changeSettings(new WorkspaceManager(), changes);
      respond(r, () => {
        for (const c of r.changed) console.log(`${green(c.key)}: ${JSON.stringify(c.before)} → ${JSON.stringify(c.after)}`);
      });
    });
  settings
    .command('reset')
    .description('put settings back to their defaults: the keys named, or --all')
    .argument('[keys...]', 'settings to reset')
    .option('--all', 'every setting')
    .action((keys: string[], o: { all?: boolean }) => {
      if (!o.all && !keys.length) throw new CliError('Name the settings to reset, or pass --all', EXIT.CONFIG_ERROR);
      const r = resetSettings(new WorkspaceManager(), o.all ? 'all' : keys);
      respond(r, () => console.log(r.reset.length ? `${green('Reset')} ${r.reset.join(', ')}` : dim('They were at their defaults already.')));
    });
}
