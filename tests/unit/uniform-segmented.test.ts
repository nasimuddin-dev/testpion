import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

// One shared component per UI pattern (uniform UI): a set of mutually exclusive view modes (Pretty / Table / Raw /
// Visualize, a console filter, a protocol) is the shared `Segmented` control in ui.tsx — never a hand-made row of buttons
// with its own look (lowercase values capitalised by CSS, another active colour, no radio semantics).
const src = join(__dirname, '../../apps/desktop/src');
const files = (dir: string): string[] => readdirSync(dir).flatMap((n) => (statSync(join(dir, n)).isDirectory() ? files(join(dir, n)) : /\.tsx$/.test(n) ? [join(dir, n)] : []));

describe('mode switchers are the shared Segmented control', () => {
  it('no hand-made button group that maps modes to buttons', () => {
    const offenders: string[] = [];
    for (const f of files(src)) {
      if (f.endsWith(join('components', 'ui.tsx'))) continue;
      const text = readFileSync(f, 'utf8');
      // a bordered row whose children are buttons made from a list of modes
      const re = /<div className="flex rounded-md border border-line overflow-hidden[^"]*"[^>]*>\s*\{[^\n]*\.map\(/g;
      for (const m of text.matchAll(re)) offenders.push(`${relative(src, f)}:${text.slice(0, m.index).split('\n').length}`);
      // a button whose label is a lowercase value capitalised by CSS
      for (const m of text.matchAll(/<button[^>]*className=\{cx\('[^']*\bcapitalize\b/g)) offenders.push(`${relative(src, f)}:${text.slice(0, m.index).split('\n').length} (capitalize)`);
    }
    expect(offenders).toEqual([]);
  });

  it('the response body’s modes are labelled words, in the shared control', () => {
    const text = readFileSync(join(src, 'components/ResponseViewer.tsx'), 'utf8');
    expect(text).toMatch(/<Segmented\s+label="Body view"/);
    for (const l of ['Pretty', 'Table', 'Raw', 'Preview', 'Visualize']) expect(text).toContain(`label: '${l}'`);
  });
});
