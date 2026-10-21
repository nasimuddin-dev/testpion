import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

// B-26b: one read of git's status and changes in the window. The Git view takes it from the shared store (lib/git.ts), as
// the change marks and the status bar do; it does not ask `git.changes` for itself.

const SRC = join(__dirname, '..', '..', 'apps', 'desktop', 'src');
const files = (dir: string): string[] => readdirSync(dir).flatMap((n) => (statSync(join(dir, n)).isDirectory() ? files(join(dir, n)) : /\.tsx?$/.test(n) ? [join(dir, n)] : []));

describe('the window reads git once', () => {
  it("only lib/git.ts calls 'git.changes'", () => {
    const callers = files(SRC).filter((f) => /call(?:<[^>]*>)?\(\s*'git\.changes'/.test(readFileSync(f, 'utf8')));
    expect(callers.map((f) => relative(SRC, f).split('\\').join('/'))).toEqual(['lib/git.ts']);
  });

  it('the Git view uses the shared store for the status and the changes', () => {
    const view = readFileSync(join(SRC, 'views', 'GitView.tsx'), 'utf8');
    expect(view).toMatch(/useGitFull\(\)/);
    expect(view).not.toMatch(/useState<SemanticChange\[\]>|setChanges\(|setStatus\(/);
    expect(view).toMatch(/await refreshGit\(\)/);
  });
});
