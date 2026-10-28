/**
 * The HTTP Debugger's small commands that work on files, so a script or an agent can do what the app's buttons do:
 *   debugger breakpoints <mode>   the one managed "Auto breakpoint" rule of a rules file (FG-5)
 *   debugger annotate <har> <ref> a note and a colour mark on one entry of a HAR file (FG-11)
 *   debugger presets              the ready-made rules (Disable caching, User agent, Hide…), listed or added to a rules file (FG-15)
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { Command } from 'commander';
import {
  AUTO_BREAKPOINT_LABEL,
  annotateHarEntry,
  autoBreakpointMode,
  defaultRules,
  describeRule,
  parseAutoBreakpointMode,
  rulePresets,
  shortId,
  withAutoBreakpoint,
  exchangesFromHar,
  type DebuggerRule,
  type DebuggerRulesFile,
} from '@testpion/core';
import { EXCHANGE_VIEWS, exchangeView, type ExchangeViewName } from '@testpion/shared';
import { EXIT, CliError, dim, green, printJson, withWorkspace, WORKSPACE_OPTION, JSON_RESULT_OPTION } from '../shared.js';

interface RulesOpts {
  rules?: string;
  workspace?: string;
  dryRun?: boolean;
  json?: boolean;
}

/** The rules file: the one named, else the workspace's debugger/rules.json. */
async function rulesPath(o: RulesOpts): Promise<string> {
  if (o.rules) return o.rules;
  return withWorkspace(o.workspace, (store) => store.path('debugger', 'rules.json'));
}

/** The file as the app writes it (profiles) or a plain list of rules, and how to write it back the same way. */
function readRules(file: string): { active: DebuggerRule[]; write(rules: DebuggerRule[]): void } {
  let raw: DebuggerRulesFile | DebuggerRule[] | undefined;
  if (existsSync(file)) {
    try {
      raw = JSON.parse(readFileSync(file, 'utf8')) as DebuggerRulesFile | DebuggerRule[];
    } catch (e) {
      throw new CliError(`${file} is not valid JSON: ${(e as Error).message}`, EXIT.CONFIG_ERROR);
    }
  }
  if (Array.isArray(raw)) return { active: raw, write: (rules) => writeFileSync(file, JSON.stringify(rules, null, 2) + '\n') };
  const f: DebuggerRulesFile = raw?.profiles ? raw : { active: 'Default', profiles: { Default: defaultRules() } };
  f.active = f.profiles[f.active] ? f.active : (Object.keys(f.profiles)[0] ?? 'Default');
  return {
    active: f.profiles[f.active] ?? [],
    write: (rules) => {
      f.profiles[f.active] = rules;
      writeFileSync(file, JSON.stringify(f, null, 2) + '\n');
    },
  };
}

export function registerDebugNotesCommands(program: Command): void {
  program
    .command('debug-breakpoints')
    .description('hold traffic at an automatic breakpoint: keeps one rule "Auto breakpoint" in a rules file (mode: off, request, response, post or errors; the app or `debug capture --rules` reads it)')
    .argument('[mode]', 'off | request (every request) | response (every response) | post (only POST) | errors (only responses of 400 and up); omit to show the current one')
    .option('--rules <file.json>', "the rules file (default: the workspace's debugger/rules.json)")
    .option('--dry-run', 'change nothing: say what would be written')
    .option(...WORKSPACE_OPTION)
    .option(...JSON_RESULT_OPTION)
    .action(async (modeArg: string | undefined, o: RulesOpts) => {
      const file = await rulesPath(o);
      const { active, write } = readRules(file);
      let mode = autoBreakpointMode(active);
      if (modeArg !== undefined) {
        try {
          mode = parseAutoBreakpointMode(modeArg);
        } catch (e) {
          throw new CliError((e as Error).message, EXIT.CONFIG_ERROR);
        }
        if (!o.dryRun) write(withAutoBreakpoint(active, mode));
      }
      const out = { file, mode, label: AUTO_BREAKPOINT_LABEL[mode], changed: modeArg !== undefined && !o.dryRun, ...(o.dryRun ? { dryRun: true } : {}) };
      if (o.json) return printJson(out);
      console.log(`${green('Auto breakpoint')}: ${out.label}${modeArg === undefined ? '' : o.dryRun ? ' (dry run, nothing written)' : ` in ${file}`}`);
    });

  program
    .command('debug-annotate')
    .description('set a note and a colour mark on one entry of a HAR file (the note is saved as the entry comment; an empty value removes it)')
    .argument('<har>', 'the HAR file')
    .argument('<entry>', 'the exchange id (_testpion.id), or #3 for the third entry')
    .option('--note <text>', 'the comment (up to 2000 characters)')
    .option('--mark <colour>', 'red, orange, yellow, green, blue, purple or grey')
    .option('--dry-run', 'change nothing: say what would be written')
    .option(...JSON_RESULT_OPTION)
    .action((harFile: string, entry: string, o: { note?: string; mark?: string; dryRun?: boolean; json?: boolean }) => {
      if (o.note === undefined && o.mark === undefined) throw new CliError('Give --note and / or --mark', EXIT.CONFIG_ERROR);
      let har: unknown;
      try {
        har = JSON.parse(readFileSync(harFile, 'utf8'));
      } catch (e) {
        throw new CliError(`${harFile}: ${(e as Error).message}`, EXIT.CONFIG_ERROR);
      }
      let now: ReturnType<typeof annotateHarEntry>;
      try {
        now = annotateHarEntry(har, entry, { note: o.note, mark: o.mark });
      } catch (e) {
        throw new CliError((e as Error).message, EXIT.CONFIG_ERROR);
      }
      if (!o.dryRun) writeFileSync(harFile, JSON.stringify(har, null, 2));
      const out = { file: harFile, ...now, changed: !o.dryRun };
      if (o.json) return printJson(out);
      console.log(`${green(o.dryRun ? 'Would annotate' : 'Annotated')} ${now.entry}${now.note ? `  note: ${now.note}` : ''}${now.mark ? `  mark: ${now.mark}` : ''}`);
    });

  program
    .command('debug-presets')
    .description('the ready-made Debugger rules (Disable caching, Remove all encodings, User agent, Require proxy sign-in …): list them, or --add one to a rules file')
    .option('--host <host>', 'the host a preset applies to (default: all traffic)')
    .option('--add <id>', 'add this preset to the rules file')
    .option('--rules <file.json>', "the rules file for --add (default: the workspace's debugger/rules.json)")
    .option('--dry-run', 'with --add: change nothing')
    .option(...WORKSPACE_OPTION)
    .option(...JSON_RESULT_OPTION)
    .action(async (o: RulesOpts & { host?: string; add?: string }) => {
      const presets = rulePresets(o.host);
      if (!o.add) {
        const list = presets.map((p) => ({ id: p.id, label: p.label, summary: describeRule({ ...p.rule, id: p.id }) }));
        if (o.json) return printJson({ presets: list });
        for (const p of list) console.log(`${p.id.padEnd(16)} ${p.label}  ${dim(p.summary)}`);
        return;
      }
      const preset = presets.find((p) => p.id === o.add);
      if (!preset) throw new CliError(`No preset "${o.add}": ${presets.map((p) => p.id).join(', ')}`, EXIT.CONFIG_ERROR);
      const file = await rulesPath(o);
      const { active, write } = readRules(file);
      const rule: DebuggerRule = { ...preset.rule, id: shortId('rule-') };
      if (!o.dryRun) write([...active, rule]);
      if (o.json) return printJson({ file, added: { ...rule, summary: describeRule(rule) }, changed: !o.dryRun });
      console.log(`${green(o.dryRun ? 'Would add' : 'Added')} ${rule.name} to ${file}`);
    });

  program
    .command('debug-show')
    .description('read one body of a captured exchange in a HAR file the way the Debugger window shows it: image facts, an XML tree, form parts, GraphQL, MessagePack, Protobuf, SignalR, Socket.IO frames, caching and TLS findings')
    .argument('<har>', 'the HAR file')
    .argument('<entry>', 'the exchange id (_testpion.id), or #3 for the third entry')
    .option('--view <name>', `list (which views fit) | ${EXCHANGE_VIEWS.filter((v) => v !== 'list').join(' | ')}`, 'list')
    .option('--side <side>', 'request or response (default: response)', 'response')
    .option(...JSON_RESULT_OPTION)
    .action((harFile: string, entry: string, o: { view: string; side: string; json?: boolean }) => {
      if (!(EXCHANGE_VIEWS as readonly string[]).includes(o.view)) throw new CliError(`Unknown view "${o.view}": ${EXCHANGE_VIEWS.join(', ')}`, EXIT.CONFIG_ERROR);
      if (o.side !== 'request' && o.side !== 'response') throw new CliError('--side is request or response', EXIT.CONFIG_ERROR);
      let har: unknown;
      try {
        har = JSON.parse(readFileSync(harFile, 'utf8'));
      } catch (e) {
        throw new CliError(`${harFile}: ${(e as Error).message}`, EXIT.CONFIG_ERROR);
      }
      let list: ReturnType<typeof exchangesFromHar>;
      try {
        list = exchangesFromHar(har);
      } catch (e) {
        throw new CliError(`${harFile}: ${(e as Error).message}`, EXIT.CONFIG_ERROR);
      }
      const byPlace = /^#(\d+)$/.exec(entry);
      const found = byPlace ? list[Number(byPlace[1]) - 1] : list.find((x) => x.id === entry);
      if (!found) throw new CliError(`No entry ${entry} in ${harFile} (use an exchange id, or #1 for the first entry)`, EXIT.CONFIG_ERROR);
      const r = exchangeView(found, o.view as ExchangeViewName, o.side);
      if (o.json) return printJson({ id: found.id, url: found.url, ...r });
      if (!r.ok) throw new CliError(r.error ?? 'That view is not available', EXIT.CONFIG_ERROR);
      console.log(r.text ?? JSON.stringify(r.data, null, 2));
    });
}
