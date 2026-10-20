import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import ts from 'typescript';
import { KIND_INFO, baseKind, gitFolderKey, gitMarksOf, gitRefKey, gitSectionKey, itemRefKey, liveKinds, type KindId } from '@testpion/shared';
import { KIND_ICONS } from '../../apps/desktop/src/components/KindIcon';

/**
 * Change marks (planning/git-everything.md §4c, release A): one mechanism for every list. A row says what it is
 * (`<TreeRowShell git={…}>`: its ItemRef, a folder or a section of a kind) and the shell draws the mark from the
 * workspace's changes; the keys are the same on both sides. The enumerating test below walks the window's source: a row of a
 * kind that is versioned, without its `git`, fails here, as does a versioned kind that no row draws.
 */

const root = join(__dirname, '..', '..');
const src = join(root, 'apps', 'desktop', 'src');

describe('the keys of the marks', () => {
  it('a test file, a flow and a step of it are one key; a monitor has one key whatever way it is named', () => {
    const file = gitRefKey({ kind: 'test', path: 'smoke/login.yaml' });
    expect(gitRefKey({ kind: 'flow', path: 'smoke/login.yaml', step: 'pay' })).toBe(file);
    expect(gitRefKey({ kind: 'test', path: 'smoke/login.yaml', line: '3' })).toBe(file);
    expect(gitRefKey({ kind: 'saved', library: 'monitors', itemId: 'm1' })).toBe(gitRefKey({ kind: 'monitor', monitorId: 'm1' }));
    expect(gitRefKey({ kind: 'request', collectionId: 'a', requestId: 'r', protocol: 'graphql' })).toBe(itemRefKey({ kind: 'request', collectionId: 'a', requestId: 'r' }));
  });

  it('an item has its own change; a folder and a section count what is inside; a removed item has no row of its own', () => {
    const req = { kind: 'request' as const, collectionId: 'api', requestId: 'r1' };
    const col = gitRefKey({ kind: 'collection', collectionId: 'api' });
    const marks = gitMarksOf([
      { change: 'changed', ref: req, containers: [gitFolderKey('request', 'x'), col, gitSectionKey('collection')] },
      { change: 'removed', ref: { kind: 'request', collectionId: 'api', requestId: 'r2' }, containers: [col, gitSectionKey('collection')] },
      { change: 'added', ref: { kind: 'mcp-server', serverId: 's' }, containers: [gitSectionKey('mcp-server')] },
    ]);
    expect(marks.get(gitRefKey(req))).toEqual({ change: 'changed' });
    expect(marks.get(gitRefKey({ kind: 'request', collectionId: 'api', requestId: 'r2' }))).toBeUndefined();
    expect(marks.get(col)).toEqual({ change: 'changed', count: 2 });
    expect(marks.get(gitSectionKey('collection'))).toEqual({ change: 'changed', count: 2 });
    expect(marks.get(gitRefKey({ kind: 'mcp-server', serverId: 's' }))).toEqual({ change: 'added' });
    // a collection that is new and has requests in it stays "added", with the count of what is in it
    const added = gitMarksOf([
      { change: 'added', ref: { kind: 'collection', collectionId: 'new' } },
      { change: 'added', ref: { kind: 'request', collectionId: 'new', requestId: 'a' }, containers: [gitRefKey({ kind: 'collection', collectionId: 'new' })] },
    ]);
    expect(added.get(gitRefKey({ kind: 'collection', collectionId: 'new' }))).toEqual({ change: 'added', count: 1 });
  });
});

describe('every kind icon is drawn', () => {
  it('each icon name of the registry has a component', () => {
    const missing = [...new Set(Object.values(KIND_INFO).map((k) => k.icon))].filter((name) => !KIND_ICONS[name]);
    expect(missing).toEqual([]);
  });
});

/* ------------------------------------------------------------------ the rows of the window */

function files(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...files(p));
    else if (e.name.endsWith('.tsx')) out.push(p);
  }
  return out;
}

interface Row {
  file: string;
  tag: string;
  /** The kind when the row names it with a string (or both strings of a condition); undefined: computed. */
  kinds?: string[];
  git: boolean;
  /** A section header (`header`): the shell marks it itself from its `section:` kind. */
  header: boolean;
  /** An attribute `git={…}` that is not given (`git={undefined}`) does not count. */
}

/** Every `<TreeRowShell>`, `<ItemRow>` and `<FolderList>` of the window with its kind and whether it says what it is for git. */
function rows(): Row[] {
  const out: Row[] = [];
  for (const f of files(src)) {
    const sf = ts.createSourceFile(f, readFileSync(f, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const visit = (n: ts.Node) => {
      if (ts.isJsxOpeningElement(n) || ts.isJsxSelfClosingElement(n)) {
        const tag = n.tagName.getText(sf);
        if (tag === 'TreeRowShell' || tag === 'ItemRow' || tag === 'FolderList' || tag === 'Section') {
          const attrs = n.attributes.properties.filter(ts.isJsxAttribute);
          const attr = (name: string) => attrs.find((a) => a.name.getText(sf) === name);
          const kindAttr = attr('kind');
          const literals: string[] = [];
          const walk = (x: ts.Node) => {
            if (ts.isStringLiteralLike(x)) literals.push(x.text);
            else if (ts.isTemplateExpression(x)) literals.push(`${x.head.text}*`); // `section:${kind}` → "section:*"
            ts.forEachChild(x, walk);
          };
          if (kindAttr?.initializer) walk(kindAttr.initializer);
          const expr = kindAttr?.initializer && ts.isJsxExpression(kindAttr.initializer) ? kindAttr.initializer.expression : undefined;
          const bare = expr && ts.isAsExpression(expr) ? expr.expression : expr;
          const computed = !!bare && !(ts.isStringLiteralLike(bare) || ts.isConditionalExpression(bare) || ts.isTemplateExpression(bare));
          out.push({
            file: relative(src, f).split(sep).join('/'),
            tag,
            kinds: computed ? undefined : literals,
            header: !!attr('header') || tag === 'Section',
            git: tag === 'FolderList' || tag === 'Section' ? true : !!attr('git'),
          });
        }
      }
      ts.forEachChild(n, visit);
    };
    visit(sf);
  }
  return out;
}

const all = rows();
const versioned = new Set(
  liveKinds()
    .filter((k) => k.capabilities.versioned === true)
    .map((k) => k.id),
);
/** A row of a kind that has items in git (not a section header, which the shell marks itself). */
const itemOrFolder = (kind: string) => !kind.startsWith('section:') && !kind.endsWith('*') && versioned.has(baseKind(kind as never));

describe('every row of a versioned kind says what it is for git', () => {
  it('the window has rows (the walk finds the shells)', () => {
    expect(all.filter((r) => r.tag === 'TreeRowShell').length).toBeGreaterThan(15);
  });

  it('a TreeRowShell or ItemRow of a versioned kind has `git`; a computed kind has it too', () => {
    const bad = all
      .filter((r) => r.tag !== 'FolderList' && !r.header && !r.git && (r.kinds === undefined || r.kinds.some(itemOrFolder)))
      .map((r) => `${r.file}: <${r.tag}> ${r.kinds?.join(' | ') ?? '(computed kind)'}`);
    // rows of kinds with no storage of their own (a category, favorites, runs, history, a record) are not versioned: no mark
    expect(bad).toEqual([]);
  });

  it('every kind that is versioned has a row that draws its mark (a flow is a test file; requests and folders are the collection tree’s)', () => {
    const drawn = new Set<string>();
    for (const r of all.filter((x) => x.git))
      for (const k of r.kinds ?? []) {
        const base = baseKind(k as never);
        drawn.add(base);
        if (base === 'test') drawn.add('flow');
      }
    const missing = [...versioned].filter((id: KindId) => !drawn.has(id));
    expect(missing, 'a versioned kind with no row that shows its change mark: give its rows `git={…}`, or plan the capability').toEqual([]);
  });

  it('every versioned kind that is listed has a section header (marked by the shell from its kind)', () => {
    const headers = new Set(
      all
        .flatMap((r) => (r.tag === 'TreeRowShell' || r.tag === 'Section' ? (r.kinds ?? []) : []))
        .filter((k) => k.startsWith('section:') && !k.endsWith('*'))
        .map((k) => baseKind(k as never)),
    );
    const fromList = new Set(all.filter((r) => r.tag === 'FolderList').flatMap((r) => r.kinds ?? []));
    const missing = liveKinds()
      .filter((k) => k.listed && versioned.has(k.id) && k.id !== 'collection')
      .map((k) => k.id)
      .filter((id) => !headers.has(id) && !fromList.has(id));
    expect(missing).toEqual([]);
  });
});
