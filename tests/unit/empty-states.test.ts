import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

// WF-18: an empty state offers the next step, through the one `Empty` API (`actions`; a menu is an action with `items`).
const SRC = join(__dirname, '../../apps/desktop/src');
const files = (dir: string): string[] => readdirSync(dir).flatMap((f) => (statSync(join(dir, f)).isDirectory() ? files(join(dir, f)) : /\.tsx$/.test(f) ? [join(dir, f)] : []));
/** Every <Empty …> opening tag with its attributes (up to the tag's end, JSX braces balanced). */
function emptyTags(text: string): string[] {
  const out: string[] = [];
  for (let i = text.indexOf('<Empty'); i >= 0; i = text.indexOf('<Empty', i + 1)) {
    if (/\w/.test(text[i + 6] ?? '')) continue; // <EmptyHint …
    let depth = 0;
    let j = i;
    for (; j < text.length; j++) {
      const c = text[j];
      if (c === '{') depth++;
      else if (c === '}') depth--;
      else if (c === '>' && depth === 0) break;
    }
    out.push(text.slice(i, j + 1));
  }
  return out;
}
const all = files(SRC).flatMap((f) => emptyTags(readFileSync(f, 'utf8')).map((tag) => ({ file: f.slice(SRC.length + 1).replace(/\\/g, '/'), tag })));

/** The dead ends of the plan's table: each must offer its next step. */
const MUST_ACT = ['No saved load tests', 'No saved evaluations', 'No saved prompts', 'Nothing sent yet', 'Select a monitor', 'No open requests', 'No cookies yet', 'No history yet', 'No traces yet'];

describe('empty states', () => {
  it('use one API: no `action=` element, only `actions`', () => {
    expect(all.filter((e) => /\saction=\{/.test(e.tag)).map((e) => e.file)).toEqual([]);
  });

  it("the plan's dead ends offer their next step", () => {
    const missing = MUST_ACT.filter((title) => {
      const tags = all.filter((e) => e.tag.includes(`title="${title}"`));
      return !tags.length || tags.some((e) => !/\sactions=\{/.test(e.tag));
    });
    expect(missing).toEqual([]);
  });
});
