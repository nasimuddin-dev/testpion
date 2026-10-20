import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { collectionToInsomniaV4, collectionToInsomniaV5, collectionToOpenCollection, collectionToOpenCollectionBundle, type Collection, type Environment } from '@testpion/core';
import { EXIT, CliError, dim, findWorkspaceUp, withWorkspace, yellow } from '../shared.js';

/** The export formats that other API clients read: Insomnia (v5 YAML, v4 JSON) and OpenCollection (Bruno's YAML; a folder or one file). */
export const MORE_EXPORT_FORMATS = ['insomnia', 'insomnia-v4', 'opencollection', 'opencollection-file'] as const;

export async function exportMoreFormat(format: string, c: Collection, o: { workspace?: string; out?: string }): Promise<boolean> {
  if (!(MORE_EXPORT_FORMATS as readonly string[]).includes(format)) return false;
  // the workspace's environments go along (secret values never)
  const ws = o.workspace ?? findWorkspaceUp(process.cwd());
  const envs: Environment[] = ws ? await withWorkspace(ws, (store) => store.listEnvironments().filter((e) => !e.problem)) : [];
  let notes: string[];
  if (format === 'opencollection') {
    if (!o.out) throw new CliError('--format opencollection writes a folder: give it with --out <folder> (or use --format opencollection-file for one file)', EXIT.CONFIG_ERROR);
    const r = collectionToOpenCollection(c, envs);
    for (const f of r.files) {
      const p = join(resolve(o.out), ...f.path.split('/'));
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, f.text);
    }
    console.error(dim(`OpenCollection folder written to ${resolve(o.out)} (${r.files.length} files)`));
    notes = r.notes;
  } else {
    const r = format === 'insomnia' ? collectionToInsomniaV5(c, envs) : format === 'insomnia-v4' ? collectionToInsomniaV4(c, envs) : collectionToOpenCollectionBundle(c, envs);
    if (o.out) {
      writeFileSync(resolve(o.out), r.text);
      console.error(dim(`Written to ${resolve(o.out)}`));
    } else process.stdout.write(r.text);
    notes = r.notes;
  }
  for (const n of notes) console.error(yellow(`not exported: ${n}`));
  return true;
}
