#!/usr/bin/env node
// Writes docs/migrate/*.md from the importers' support table and the script converter's tables (packages/core/src/import/
// support.ts, migrate-docs.ts). The pages are generated so they cannot drift from the code: tests/unit/migrate-docs.test.ts
// fails when a page on disk differs from what this writes. Needs the built core: `npm run build -w @testpion/core` first.
//
//   node scripts/gen-migrate-docs.mjs          write the pages
//   node scripts/gen-migrate-docs.mjs --check  exit 1 when a page is out of date (CI)
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const { migrationPages } = await import(pathToFileURL(join(root, 'packages', 'core', 'dist', 'index.js')).href);
const check = process.argv.includes('--check');
let stale = 0;
for (const p of migrationPages()) {
  const file = join(root, 'docs', ...p.path.split('/'));
  const have = existsSync(file) ? readFileSync(file, 'utf8').replace(/\r\n/g, '\n') : undefined;
  if (have === p.markdown) continue;
  stale++;
  if (check) {
    console.error(`docs/${p.path} is out of date: run npm run docs:migrate`);
    continue;
  }
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, p.markdown);
  console.log(`wrote docs/${p.path}`);
}
if (check && stale) process.exit(1);
if (!check && !stale) console.log('docs/migrate is up to date');
