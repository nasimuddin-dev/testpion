import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { exportCollectionPackage, parseSelector, writeZip, type PackageTarget } from '@testpion/core';
import { EXIT, CliError, dim, green, printJson, withWorkspace, yellow } from '../shared.js';

/**
 * `testpion export <collection> --format postman|bruno --extras`: the collection for another tool WITH what it uses (its
 * environments, the workspace variables as Postman globals, API definitions, data files, an `.mcp.json`). Postman gets one
 * zip (`<name>.postman.zip`), Bruno a folder (`--out <folder>`), the way each tool opens it. The core builds the files
 * (transfer/foreign-package.ts); this only writes them. Secret values are never in the package.
 */
export async function runPackageExport(ref: string | undefined, o: { workspace?: string; format: string; out?: string; json?: boolean }): Promise<void> {
  if (!ref) throw new CliError('Give the collection to export (a name or id in the workspace)', EXIT.CONFIG_ERROR);
  if (o.format !== 'postman' && o.format !== 'bruno') throw new CliError('--extras works with --format postman (a zip) or --format bruno (a folder)', EXIT.CONFIG_ERROR);
  const target: PackageTarget = o.format;
  await withWorkspace(o.workspace, (store) => {
    const sel = parseSelector(store, ref);
    if (sel.kind !== 'collection' || sel.id.includes('#')) throw new CliError('--extras takes a whole collection of the workspace', EXIT.CONFIG_ERROR);
    const pkg = exportCollectionPackage(store, sel.id, target);
    let where: string;
    if (target === 'postman') {
      where = resolve(o.out ?? `${pkg.name}.postman.zip`);
      mkdirSync(dirname(where), { recursive: true });
      writeFileSync(where, writeZip(pkg.files.map((f) => ({ name: f.path, data: f.data }))));
    } else {
      if (!o.out) throw new CliError('--format bruno writes a folder: give it with --out <folder>', EXIT.CONFIG_ERROR);
      where = resolve(o.out);
      for (const f of pkg.files) {
        const p = join(where, ...f.path.split('/'));
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, f.data);
      }
    }
    if (o.json) return printJson({ path: where, target, files: pkg.files.map((f) => f.path), notes: pkg.notes, replaced: pkg.replaced });
    console.log(green(`${target === 'postman' ? 'Postman package' : 'Bruno folder'} written to ${where} (${pkg.files.length} files)`));
    for (const n of pkg.notes) console.error(yellow(`not exported: ${n}`));
    console.error(dim('Secret values are never in the package.'));
  });
}
