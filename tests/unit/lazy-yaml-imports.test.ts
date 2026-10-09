import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';

const root = join(__dirname, '..', '..');
const files = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? (e.name === 'node_modules' || e.name === 'dist' ? [] : files(join(dir, e.name))) : /\.tsx?$/.test(e.name) ? [join(dir, e.name)] : [],
  );

// yaml (about 280 KB) stays off the app's startup path: the engine and the backend load it at first use through
// util/lazy-yaml.ts (parseYaml, stringifyYaml, parseDocument … from '@testpion/core' outside the engine).
describe('yaml is loaded lazily', () => {
  it('no static runtime import of yaml in the engine or the desktop backend', () => {
    const offenders = [join(root, 'packages/core/src'), join(root, 'apps/desktop/backend'), join(root, 'apps/desktop/electron')]
      .flatMap(files)
      .filter((f) => /^import (?!type )[^;]*from 'yaml';/m.test(readFileSync(f, 'utf8')))
      .map((f) => relative(root, f).split('\\').join('/'));
    expect(offenders).toEqual([]);
  });
});
