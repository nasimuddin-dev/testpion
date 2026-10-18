import { Command } from 'commander';
import { describeKinds, type KindDescription } from '@testpion/core';
import { bold, dim, printJson, withWorkspace } from '../shared.js';

/** One capability state in a few words: ✓, "no: why", "0.53". */
const stateText = (s: KindDescription['capabilities'][string]) => (s === true ? 'yes' : 'na' in s ? `no (${s.na})` : `planned for ${s.planned}`);

/**
 * `testpion kinds [kind]`: every kind of item a workspace holds and what each one offers (the item-kind registry),
 * the same answer as MCP `list_kinds`. With a kind, every capability with the reason when it never applies.
 */
export function registerKindsCommand(program: Command): void {
  program
    .command('kinds [kind]')
    .description(
      'list the kinds of item a workspace holds (collections, requests, test files, API definitions, datasets, MCP servers, monitors …) and what each offers: open, link, rename, move, delete with undo, run, monitor, CI, export …',
    )
    .option('-w, --workspace <nameOrPath>', 'add facts about this workspace (default: the nearest workspace.json, if any)')
    .option('--all', 'also the kinds registered ahead of their release')
    .option('--json', 'print { kinds: [{ id, label, ref, storage, opens, capabilities, can, facets, nodes: the menus of its rows, sections and folders }], workspace } as JSON')
    .action((name: string | undefined, o: { workspace?: string; all?: boolean; json?: boolean }) =>
      withWorkspace(o.workspace, (store, ephemeral) => {
        const report = describeKinds({ kind: name, all: o.all }, ephemeral ? undefined : store);
        if (o.json) return printJson(report);
        if (name) {
          const k = report.kinds[0]!;
          console.log(`${bold(k.label)} ${dim(`(${k.id}${k.aliases.length ? `; also ${k.aliases.join(', ')}` : ''})`)}`);
          console.log(
            dim(
              `stored: ${k.storage.layout}${'dir' in k.storage ? ` in ${k.storage.dir}/` : 'file' in k.storage ? ` in ${k.storage.file}` : 'library' in k.storage ? ` in library/${k.storage.library}.json` : ''}`,
            ),
          );
          for (const [cap, s] of Object.entries(k.capabilities)) console.log(`  ${cap.padEnd(14)} ${stateText(s)}`);
          return;
        }
        for (const k of report.kinds) console.log(`${k.id.padEnd(16)} ${k.label.padEnd(20)} ${dim(k.can.join(', ') || '—')}`);
      }),
    );
}
