import { existsSync, openSync, readSync, closeSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Command } from 'commander';
import { kindByName } from '@testpion/shared';
import {
  ApsError,
  TRANSFER_LIMITS,
  applyImport,
  buildBundle,
  describeBundle,
  listImports,
  looksLikeBundle,
  parseSelector,
  previewImport,
  readBundle,
  sectionRefs,
  undoImport,
  type ImportChoice,
  type ImportPreview,
} from '@testpion/core';
import { EXIT, CliError, bold, dim, green, printJson, withWorkspace, yellow } from '../shared.js';

/**
 * Bundles on the command line: `testpion export` writes one (items, a section, the whole workspace, a collection with
 * everything it uses), `testpion import` previews or applies one and undoes an import, `testpion bundle inspect` reads
 * one without a workspace. The same core functions as the app's dialogs and the MCP tools (packages/core/src/transfer).
 * data.ts keeps the commands (export and import also take collection files and the foreign formats); this module is
 * what they run for a bundle.
 */

const CHOICES: ImportChoice[] = ['keep-both', 'replace', 'skip'];
const mb = (n: number) => (n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);

export interface BundleExportOptions {
  workspace?: string;
  out?: string;
  section?: string;
  all?: boolean;
  uses?: boolean;
  datasets?: 'auto' | 'embed' | 'reference';
  providers?: boolean;
  title?: string;
  json?: boolean;
}

/** Whether an `export` call asks for a bundle: a section, everything, "uses", or a ref in the kind:id form. */
export function wantsBundleExport(refs: string[], o: { format?: string } & Pick<BundleExportOptions, 'section' | 'all' | 'uses'>): boolean {
  return o.format === 'bundle' || !!o.section || !!o.all || !!o.uses || refs.some((r) => !!kindByName(r.slice(0, Math.max(0, r.indexOf(':')))) && !/^[a-z]+:\/\//i.test(r));
}

export async function runBundleExport(refs: string[], o: BundleExportOptions): Promise<void> {
  if (o.datasets && !['auto', 'embed', 'reference'].includes(o.datasets)) throw new CliError('--datasets is embed, reference or auto', EXIT.CONFIG_ERROR);
  if (!o.all && !o.section && !refs.length)
    throw new CliError('Name what to export: kind:id (collection:<id>, spec:specs/<path>, dataset:<name>, mcp-server:<id> …), --section <kind>, or --all', EXIT.CONFIG_ERROR);
  await withWorkspace(o.workspace, (store) => {
    const selection = o.all ? ('all' as const) : o.section ? sectionRefs(store, o.section) : refs.map((r) => parseSelector(store, r));
    const ext = o.out ? /\.(zip|json)$/i.exec(o.out)?.[1]?.toLowerCase() : undefined;
    const b = buildBundle(store, selection, { uses: o.uses, datasets: o.datasets, providers: o.providers, title: o.title, format: ext === 'zip' || ext === 'json' ? ext : 'auto' });
    const out = resolve(o.out ?? b.fileName);
    writeFileSync(out, b.bytes);
    if (o.json)
      return printJson({
        path: out,
        format: b.format,
        size: b.bytes.length,
        title: b.manifest.title,
        counts: b.counts,
        items: b.manifest.items.map((i) => ({ kind: i.kind, id: i.id, name: i.name, ...(i.mode === 'reference' ? { mode: i.mode } : {}) })),
        replaced: b.replaced,
        requires: b.manifest.requires,
        missing: b.manifest.missing,
        notes: b.notes,
      });
    console.log(green(`Exported to ${out} (${mb(b.bytes.length)})`));
    const [first, ...rest] = b.lines;
    console.log(dim(first!));
    for (const line of rest) console.log(yellow(line));
  });
}

/** The first bytes of a file say whether it is a bundle (a zip, a bundle's JSON, or a workspace export of earlier versions). */
export function isBundleFile(file: string): boolean {
  try {
    if (!statSync(file).isFile()) return false;
    const fd = openSync(file, 'r');
    try {
      const head = Buffer.alloc(4096);
      return looksLikeBundle(head.subarray(0, readSync(fd, head, 0, head.length, 0)));
    } finally {
      closeSync(fd);
    }
  } catch {
    return false;
  }
}

export interface BundleImportOptions {
  workspace: string;
  preview?: boolean;
  onConflict?: string;
  only?: string;
  decisions?: string;
  undo?: string;
  list?: boolean;
  maxSize?: string;
  json?: boolean;
}

function printPreview(p: ImportPreview): void {
  console.log(bold(p.title));
  console.log(
    dim(
      `made by ${p.createdBy.app} ${p.createdBy.version}${p.createdAt ? ` on ${p.createdAt.slice(0, 10)}` : ''} · ${p.totals.create} new, ${p.totals.identical} already here, ${p.totals.conflict} in conflict${p.totals.invalid ? `, ${p.totals.invalid} refused` : ''}`,
    ),
  );
  for (const i of p.items) {
    const tag = { create: green('new      '), identical: dim('identical'), conflict: yellow('conflict '), invalid: yellow('refused  '), reference: dim('reference') }[i.action];
    console.log(`  ${tag} ${i.kind.padEnd(14)} ${i.name}${i.action === 'conflict' && i.proposed ? dim(`  (keep both: ${i.proposed.name})`) : ''}${i.why ? dim(`  ${i.why}`) : ''}`);
  }
  for (const r of p.review) console.log(yellow(`review: ${r}`));
  if (p.requires.secrets.length) console.log(yellow(`to fill in after the import: ${p.requires.secrets.map((s) => `{{${s.name}}}`).join(', ')}`));
}

export async function runBundleImport(file: string | undefined, o: BundleImportOptions): Promise<void> {
  if (o.onConflict && !CHOICES.includes(o.onConflict as ImportChoice)) throw new CliError(`--on-conflict is keep-both, replace or skip (not "${o.onConflict}")`, EXIT.CONFIG_ERROR);
  await withWorkspace(o.workspace, (store) => {
    if (o.list) {
      const l = listImports(store);
      if (o.json) return printJson(l);
      for (const i of l) console.log(`${i.importId}  ${i.at.slice(0, 19)}  ${i.title}${i.undone ? dim(' (undone)') : ''}`);
      if (!l.length) console.log(dim('No imports to undo.'));
      return;
    }
    if (o.undo) {
      const r = undoImport(store, o.undo);
      if (o.json) return printJson(r);
      console.log(green(`Undid import ${r.importId}: ${r.removed} removed, ${r.restored} restored`));
      for (const k of r.keptChanged) console.log(yellow(`kept ${k}: it changed after the import`));
      return;
    }
    if (!file) throw new CliError('Give the bundle to import (a .testpion.zip or .testpion.json)', EXIT.CONFIG_ERROR);
    if (!existsSync(file)) throw new CliError(`No such file: ${file}`, EXIT.CONFIG_ERROR);
    const max = o.maxSize ? Number(o.maxSize) * 1024 * 1024 : TRANSFER_LIMITS.fileBytes;
    if (!(max > 0)) throw new CliError('--max-size is a number of megabytes', EXIT.CONFIG_ERROR);
    if (statSync(file).size > max) throw new CliError(`${file} is larger than ${mb(max)} (--max-size raises the limit)`, EXIT.CONFIG_ERROR);
    const bundle = readBundle(readFileSync(file), { limits: { ...TRANSFER_LIMITS, fileBytes: max } });
    const preview = previewImport(store, bundle);
    if (o.preview) {
      if (o.json) return printJson({ ...preview, description: describeBundle(bundle).summary });
      return printPreview(preview);
    }
    let decisions: Record<string, ImportChoice | 'import'> | undefined;
    if (o.decisions) {
      try {
        decisions = JSON.parse(readFileSync(o.decisions, 'utf8')) as Record<string, ImportChoice | 'import'>;
      } catch {
        throw new CliError(`--decisions is a JSON file of "kind:id": "keep-both" | "replace" | "skip"`, EXIT.CONFIG_ERROR);
      }
    }
    const out = applyImport(store, bundle, {
      onConflict: o.onConflict as ImportChoice | undefined,
      decisions,
      only: o.only
        ?.split(',')
        .map((s) => s.trim())
        .filter(Boolean),
    });
    if (o.json) return printJson(out);
    const n = out.created.length + out.replaced.length;
    console.log(green(`Imported ${n} item${n === 1 ? '' : 's'} from “${out.title}”${out.replaced.length ? ` (${out.replaced.length} replaced)` : ''}`));
    for (const s of out.skipped.filter((x) => x.why?.startsWith('refused'))) console.log(yellow(`skipped ${s.kind} ${s.name}: ${s.why}`));
    for (const r of out.review) console.log(yellow(`review: ${r}`));
    const need = out.requires.secrets.filter((s) => !s.defined);
    if (need.length) console.log(yellow(`Values to fill in (set them as secret variables): ${need.map((s) => `{{${s.name}}}`).join(', ')}`));
    console.log(dim(`Undo: testpion import --undo ${out.importId} -w <workspace>`));
  });
}

export function registerBundleCommands(program: Command): void {
  const b = program.command('bundle').description('TestPion bundles (.testpion.zip / .testpion.json): what `testpion export` writes and `testpion import` reads');
  b.command('inspect')
    .description('read a bundle without a workspace: what it holds, what it needs and what to review before running (nothing is imported)')
    .argument('<file>', 'a .testpion.zip or .testpion.json (or a workspace export of earlier versions)')
    .option('--max-size <mb>', 'refuse a file larger than this many megabytes')
    .option('--json', 'print the description as JSON')
    .action((file: string, o: { maxSize?: string; json?: boolean }) => {
      if (!existsSync(file)) throw new CliError(`No such file: ${file}`, EXIT.CONFIG_ERROR);
      const max = o.maxSize ? Number(o.maxSize) * 1024 * 1024 : TRANSFER_LIMITS.fileBytes;
      try {
        const d = describeBundle(readBundle(readFileSync(file), { limits: { ...TRANSFER_LIMITS, fileBytes: max } }));
        if (o.json) return printJson(d);
        console.log(bold(d.summary));
        for (const i of d.items) console.log(`  ${i.kind.padEnd(14)} ${i.name}${i.mode === 'reference' ? dim('  (by reference)') : ''}`);
        for (const r of d.review) console.log(yellow(`review: ${r}`));
        for (const s of d.requires.secrets) console.log(yellow(`fill in: {{${s.name}}} (${s.where})`));
        for (const w of [...d.warnings, ...d.notes]) console.log(dim(w));
      } catch (e) {
        throw e instanceof ApsError ? new CliError(e.message, EXIT.CONFIG_ERROR) : e;
      }
    });
}
