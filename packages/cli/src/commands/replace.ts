import type { Command } from 'commander';
import { replaceInCollection, REPLACE_FIELDS, type CollectionNode, type ReplaceField } from '@testpion/core';
import { EXIT, green, red, yellow, dim, bold, CliError, printJson, withWorkspace, requireCollection } from '../shared.js';

/** `testpion replace <collection> <find> <replacement>`: find and replace across a collection's requests (preview, then --apply). */
export function registerReplaceCommands(program: Command): void {
  program
    .command('replace')
    .description("find and replace across a collection's requests (URLs, params, headers, bodies, auth, scripts, names): shows every change; --apply saves them")
    .argument('<collection>', 'collection name or id in the workspace')
    .argument('<find>', 'the text to find (a regular expression with --regex)')
    .argument('<replacement>', 'what to put instead ($1 … for regex groups)')
    .option('--regex', 'find is a regular expression')
    .option('--case-sensitive', 'match upper and lower case exactly')
    .option('--in <fields>', `only these fields, comma separated: ${REPLACE_FIELDS.join(', ')}`)
    .option('--folder <name>', 'only the requests in this folder')
    .option('--apply', 'save the changes (without it, only show them)')
    .option('-w, --workspace <nameOrPath>', 'workspace name or directory (default: nearest workspace.json)')
    .option('--json', 'print the result as JSON (for scripts and AI agents)')
    .action((ref: string, find: string, replacement: string, o: { regex?: boolean; caseSensitive?: boolean; in?: string; folder?: string; apply?: boolean; workspace?: string; json?: boolean }) => {
      const fields = o.in ? (o.in.split(',').map((x) => x.trim()) as ReplaceField[]) : undefined;
      const bad = fields?.filter((f) => !REPLACE_FIELDS.includes(f));
      if (bad?.length) throw new CliError(`Unknown field${bad.length > 1 ? 's' : ''}: ${bad.join(', ')} (one of ${REPLACE_FIELDS.join(', ')})`, EXIT.CONFIG_ERROR);
      return withWorkspace(o.workspace, (store) => {
        const c = store.getCollection(requireCollection(store, ref).id);
        let folderId: string | undefined;
        if (o.folder) {
          const f = o.folder.toLowerCase();
          const look = (nodes: CollectionNode[]): string | undefined => {
            for (const n of nodes)
              if (n.kind === 'folder') {
                if (n.name.toLowerCase() === f || n.id.toLowerCase() === f) return n.id;
                const inner = look(n.items);
                if (inner) return inner;
              }
            return undefined;
          };
          folderId = look(c.items);
          if (!folderId) throw new CliError(`No folder "${o.folder}" in "${c.name}"`, EXIT.CONFIG_ERROR);
        }
        let r;
        try {
          r = replaceInCollection(c, { find, replace: replacement, regex: o.regex, caseSensitive: o.caseSensitive, fields, folderId });
        } catch (e) {
          throw new CliError((e as Error).message, EXIT.CONFIG_ERROR);
        }
        if (o.apply && r.matches.length) store.saveCollection(r.collection);
        if (o.json) return printJson({ collection: c.name, collectionId: c.id, changes: r.matches.length, applied: !!o.apply && r.matches.length > 0, matches: r.matches });
        if (!r.matches.length) return console.log(dim(`Nothing in "${c.name}" matches.`));
        for (const m of r.matches.slice(0, 200)) {
          console.log(`${bold(m.request)} ${dim(m.where)}`);
          console.log(red(`  - ${m.before.length > 160 ? `${m.before.slice(0, 157)}…` : m.before}`));
          console.log(green(`  + ${m.after.length > 160 ? `${m.after.slice(0, 157)}…` : m.after}`));
        }
        if (r.matches.length > 200) console.log(dim(`… and ${r.matches.length - 200} more`));
        console.log(o.apply ? green(`${r.matches.length} changes saved in "${c.name}".`) : yellow(`${r.matches.length} changes shown, nothing saved: add --apply to save them.`));
      });
    });
}
