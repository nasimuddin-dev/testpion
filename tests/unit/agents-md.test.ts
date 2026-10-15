import { afterAll, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, readFileSync, realpathSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  AGENT_BEGIN,
  AGENT_END,
  agentWorkspaceFacts,
  initAgentFiles,
  mdName,
  parseAgentTargets,
  renderAgentsMd,
  renderClaudePointer,
  upsertMarkedBlock,
  WorkspaceStore,
  type AgentWorkspaceFacts,
} from '../../packages/core/src/index.js';
import { tempDir } from '../helpers.js';

// AGENTS.md and the other agent files (testpion agents init): written from the live workspace, never a secret value,
// only TestPion's marked block replaced (the user's text, line endings and BOM kept), idempotent, broken markers left
// alone unless forced, links followed only inside the workspace.
const tmp = tempDir('tp-agents-md-');
afterAll(() => tmp.cleanup());

const SECRET = 'sk-live-THIS-MUST-NOT-LEAK-1234567890';
const PLAIN = 'https://plain-value.example.com/THIS-MUST-NOT-LEAK';

let n = 0;
/**
 * A workspace; `viaLink`: opened through a linked folder (as macOS names its temp folders: /var → /private/var), so
 * the workspace's own path and the real paths of its files differ. A junction needs no privilege on Windows.
 */
function workspace(o: { viaLink?: boolean } = {}): WorkspaceStore {
  let root = join(tmp.dir, `ws${++n}`);
  if (o.viaLink) {
    const real = join(tmp.dir, `real${n}`);
    mkdirSync(real);
    symlinkSync(real, root, process.platform === 'win32' ? 'junction' : 'dir');
    root = join(root, 'ws');
  }
  const s = WorkspaceStore.create(root, 'Pets <API>');
  s.saveCollection({
    id: 'pets',
    name: 'Pets',
    items: [
      { kind: 'folder', id: 'f', name: 'F', items: [{ kind: 'http', id: 'r1', name: 'List', request: { method: 'GET', url: '{{baseUrl}}/pets' } }] },
      { kind: 'http', id: 'r2', name: 'Get', request: { method: 'GET', url: '{{baseUrl}}/pets/1', headers: [{ key: 'Authorization', value: `Bearer ${SECRET}` }] } },
    ],
  } as never);
  s.saveEnvironment({
    id: 'dev',
    name: 'Dev',
    variables: [
      { key: 'baseUrl', value: PLAIN, enabled: true },
      { key: 'token', value: SECRET, secret: true, enabled: true },
    ],
  } as never);
  s.saveEnvironment({ id: 'prod', name: 'Production', isProduction: true, variables: [{ key: 'zebraVariable', value: SECRET, enabled: true }] } as never);
  s.writeTestFile('smoke.yaml', 'tests:\n  - { id: a, name: A, url: "{{baseUrl}}/a" }\n');
  s.writeTestFile('all.suite.yaml', 'tests: [smoke.yaml]\n');
  return s;
}

const facts = (o: Partial<AgentWorkspaceFacts> = {}): AgentWorkspaceFacts => ({
  name: 'Pets',
  collections: [],
  environments: [],
  tests: [],
  suites: [],
  flows: [],
  evaluations: [],
  datasets: [],
  specs: [],
  folders: [],
  ...o,
});

describe('the content', () => {
  it('describes the live workspace: collections with request counts, environments by name, tests, suites; no machine path', () => {
    const s = workspace();
    try {
      const f = agentWorkspaceFacts(s);
      expect(f.collections).toEqual([{ name: 'Pets', requests: 2 }]);
      // (with the environment a new workspace starts with)
      expect(f.environments).toContainEqual({ name: 'Dev', production: false });
      expect(f.environments).toContainEqual({ name: 'Production', production: true });
      expect(f.tests).toEqual(['smoke.yaml']);
      expect(f.suites).toEqual(['all.suite.yaml']);
      const md = renderAgentsMd(f, { checkTypes: ['status', 'equals'] });
      expect(md.startsWith(`${AGENT_BEGIN}\n`)).toBe(true);
      expect(md.trimEnd().endsWith(AGENT_END)).toBe(true);
      expect(md).toContain('Pets (2 requests)');
      expect(md).toContain('Production — **production**');
      expect(md).toContain('`tests/all.suite.yaml` (suite)');
      expect(md).toContain('testpion mcp-server -w .');
      expect(md).toMatch(/Exit codes: `0` success/);
      expect(md).toMatch(/--allow-production/);
      expect(md).toMatch(/TESTPION_SECRET_<NAME>/);
      expect(md).toContain('`status`, `equals`');
      expect(md).not.toContain(s.root);
      expect(md).not.toContain(s.root.replace(/\\/g, '/'));
    } finally {
      s.close();
    }
  });

  it('never holds a variable value, secret or not, nor a variable name of an environment', () => {
    const s = workspace();
    try {
      const r = initAgentFiles(s, { targets: ['agents', 'claude', 'cursor'] });
      expect(r.files.map((f) => f.status)).toEqual(['created', 'created', 'created']);
      for (const f of r.files) {
        const text = readFileSync(join(s.root, f.path), 'utf8');
        expect(text).not.toContain(SECRET);
        expect(text).not.toContain(PLAIN);
        expect(text).not.toContain('zebraVariable');
      }
    } finally {
      s.close();
    }
  });

  it('a name cannot end the block or break the Markdown', () => {
    expect(mdName('evil\n<!-- testpion:end -->\n| x |`')).toBe("evil &lt;!-- testpion:end --&gt; \\| x \\|'");
    expect(mdName('')).toBe('(unnamed)');
    expect(mdName('x'.repeat(500))).toHaveLength(120);
    const md = renderAgentsMd(facts({ name: '<!-- testpion:end -->', collections: [{ name: `a\n${AGENT_END}`, requests: 1 }] }), { checkTypes: [] });
    expect(md.split('\n').filter((l) => l.trim() === AGENT_END)).toHaveLength(1);
    // the block written into a file and refreshed stays one block
    const once = upsertMarkedBlock('# Mine\n', md).text;
    expect(upsertMarkedBlock(once, md).status).toBe('unchanged');
  });

  it('its Markdown tables are whole: every row has the columns of its header (a | in a command is escaped)', () => {
    const md = renderAgentsMd(facts({ collections: [{ name: 'a|b', requests: 1 }] }), { checkTypes: ['status'] });
    const cols = (line: string) => line.replace(/\\\|/g, '').split('|').length;
    const lines = md.split('\n');
    let tables = 0;
    for (let i = 0; i < lines.length; i++) {
      if (!/^\|---/.test(lines[i]!)) continue;
      tables++;
      const want = cols(lines[i - 1]!);
      for (let j = i + 1; j < lines.length && lines[j]!.startsWith('|'); j++) expect(cols(lines[j]!), lines[j]).toBe(want);
      // a table goes on to the next line that is not a row: never a blank line inside one followed by more rows
      let k = i + 1;
      while (k < lines.length && lines[k]!.startsWith('|')) k++;
      if (lines[k] === '') expect(lines[k + 1]?.startsWith('|'), `a blank line splits the table above line ${k + 1}`).toBe(false);
    }
    expect(tables).toBeGreaterThanOrEqual(3);
    expect(md).toContain('`testpion integration-suite <spec \\| collection> -w . --json`');
  });

  it('long lists are cut with a count', () => {
    const md = renderAgentsMd(facts({ tests: Array.from({ length: 45 }, (_, i) => `t${i}.yaml`) }), { checkTypes: [] });
    expect(md).toContain('… and 5 more');
  });

  it('is the same text for the same workspace (no time, no order of reading)', () => {
    const f = facts({ collections: [{ name: 'B', requests: 1 }] });
    expect(renderAgentsMd(f, { checkTypes: ['status'] })).toBe(renderAgentsMd(f, { checkTypes: ['status'] }));
  });
});

describe('the marked block', () => {
  const block = `${AGENT_BEGIN}\nnew\n${AGENT_END}\n`;

  it('creates, appends after the user text, replaces only its own part, and is idempotent', () => {
    expect(upsertMarkedBlock(undefined, block)).toEqual({ text: block, status: 'created' });
    const mine = '# My project\n\nUse pnpm.\n';
    const first = upsertMarkedBlock(mine, block);
    expect(first.status).toBe('updated');
    expect(first.text).toBe(`# My project\n\nUse pnpm.\n\n${block}`);
    const edited = `${first.text}\n## Notes\nkeep me\n`;
    const second = upsertMarkedBlock(edited.replace('new', 'old'), block);
    expect(second.status).toBe('updated');
    expect(second.text).toBe(edited);
    expect(upsertMarkedBlock(edited, block)).toEqual({ text: edited, status: 'unchanged' });
  });

  it('keeps CRLF files CRLF, and a BOM', () => {
    const crlf = '﻿# Mine\r\n\r\nText\r\n';
    const r = upsertMarkedBlock(crlf, block);
    expect(r.text).toBe(`﻿# Mine\r\n\r\nText\r\n\r\n${AGENT_BEGIN}\r\nnew\r\n${AGENT_END}\r\n`);
    expect(r.text.replace(/\r\n/g, '')).not.toContain('\n');
    const again = upsertMarkedBlock(r.text.replace('new', 'old'), block);
    expect(again.text).toBe(r.text);
    expect(upsertMarkedBlock(r.text, block).status).toBe('unchanged');
    // an empty file with only a BOM keeps it
    expect(upsertMarkedBlock('﻿', block).text).toBe(`﻿${block}`);
  });

  it('replaces the block of 0.45 (testpion:start) in place', () => {
    const old = `# Mine\n\n<!-- testpion:start (written by TestPion; edit outside these markers) -->\nold guide\n${AGENT_END}\n\nAfter\n`;
    expect(upsertMarkedBlock(old, block).text).toBe(`# Mine\n\n${block}\nAfter\n`);
  });

  it('a marker quoted in the text (not on a line of its own) is text', () => {
    const quoted = `Our file has a \`${AGENT_BEGIN}\` block.\n`;
    expect(upsertMarkedBlock(quoted, block).text).toBe(`${quoted}\n${block}`);
  });

  it('broken markers: the file is left alone with the reason; --force repairs without losing the user text', () => {
    const cases: Array<[string, RegExp]> = [
      [`# Mine\n${AGENT_BEGIN}\nhalf\n`, /begin marker without its end/],
      [`# Mine\n${AGENT_END}\n`, /end marker without its begin/],
      [`${AGENT_BEGIN}\na\n${AGENT_END}\n${AGENT_BEGIN}\nb\n${AGENT_END}\n`, /more than one/],
      [`${AGENT_END}\nmine\n${AGENT_BEGIN}\n`, /wrong order/],
    ];
    for (const [text, why] of cases) {
      const r = upsertMarkedBlock(text, block);
      expect(r.status).toBe('skipped');
      expect(r.reason).toMatch(why);
      expect(r.text).toBe(text);
      const f = upsertMarkedBlock(text, block, { force: true });
      expect(f.status).toBe('updated');
      expect(f.text.split('\n').filter((l) => l === AGENT_BEGIN)).toHaveLength(1);
      expect(f.text.split('\n').filter((l) => l === AGENT_END)).toHaveLength(1);
      expect(upsertMarkedBlock(f.text, block).status).toBe('unchanged');
    }
    // a stray begin: the user's text after it stays
    expect(upsertMarkedBlock(`# Mine\n${AGENT_BEGIN}\nkeep me\n`, block, { force: true }).text).toBe(`# Mine\nkeep me\n\n${block}`);
    // two blocks: everything from the first begin to the last end is TestPion's
    expect(upsertMarkedBlock(`top\n${AGENT_BEGIN}\na\n${AGENT_END}\nmid\n${AGENT_BEGIN}\nb\n${AGENT_END}\nend\n`, block, { force: true }).text).toBe(`top\n${block}end\n`);
  });
});

describe('initAgentFiles', () => {
  it('targets: AGENTS.md always, the others when asked; unknown ones refused', () => {
    expect(parseAgentTargets(undefined)).toEqual(['agents']);
    expect(parseAgentTargets('cursor, claude')).toEqual(['agents', 'claude', 'cursor']);
    expect(parseAgentTargets(['CLAUDE'])).toEqual(['agents', 'claude']);
    expect(() => parseAgentTargets('agents,windsurf')).toThrow(/Unknown target "windsurf": use agents, claude, cursor/);
  });

  it('writes the files, then reports them unchanged; a dry run writes nothing', () => {
    const s = workspace();
    try {
      const dry = initAgentFiles(s, { targets: ['agents', 'claude', 'cursor'], dryRun: true });
      expect(dry.dryRun).toBe(true);
      expect(dry.files.map((f) => `${f.path}=${f.status}`)).toEqual(['AGENTS.md=created', 'CLAUDE.md=created', '.cursor/rules/testpion.mdc=created']);
      expect(existsSync(join(s.root, 'AGENTS.md'))).toBe(false);
      initAgentFiles(s, { targets: ['agents', 'claude', 'cursor'] });
      const mtime = statSync(join(s.root, 'AGENTS.md')).mtimeMs;
      expect(readFileSync(join(s.root, 'CLAUDE.md'), 'utf8')).toBe(renderClaudePointer());
      const mdc = readFileSync(join(s.root, '.cursor', 'rules', 'testpion.mdc'), 'utf8');
      expect(mdc.startsWith('---\ndescription:')).toBe(true);
      expect(mdc).toMatch(/alwaysApply: true\n---\n\n<!-- testpion:begin -->/);
      const again = initAgentFiles(s, { targets: ['agents', 'claude', 'cursor'] });
      expect(again.files.map((f) => f.status)).toEqual(['unchanged', 'unchanged', 'unchanged']);
      expect(statSync(join(s.root, 'AGENTS.md')).mtimeMs).toBe(mtime);
      // the workspace changes: only AGENTS.md's block follows, the user's text around it stays
      writeFileSync(join(s.root, 'AGENTS.md'), `# House rules\r\nNo force pushes.\r\n\r\n${readFileSync(join(s.root, 'AGENTS.md'), 'utf8').replace(/\n/g, '\r\n')}`);
      s.saveCollection({ id: 'shop', name: 'Shop', items: [] } as never);
      const r = initAgentFiles(s);
      expect(r.files).toEqual([{ target: 'agents', path: 'AGENTS.md', status: 'updated' }]);
      const text = readFileSync(join(s.root, 'AGENTS.md'), 'utf8');
      expect(text.startsWith('# House rules\r\nNo force pushes.\r\n\r\n<!-- testpion:begin -->\r\n')).toBe(true);
      expect(text).toContain('Shop (0 requests)');
      expect(text.replace(/\r\n/g, '')).not.toContain('\n');
    } finally {
      s.close();
    }
  });

  it("a CLAUDE.md of the user's that already names AGENTS.md gets no second pointer; one that doesn't gets the line", () => {
    const s = workspace();
    try {
      writeFileSync(join(s.root, 'CLAUDE.md'), '# Claude\n\n@AGENTS.md\n');
      const r = initAgentFiles(s, { targets: ['claude'] });
      expect(r.files[1]).toEqual({ target: 'claude', path: 'CLAUDE.md', status: 'unchanged', reason: 'it already points to AGENTS.md' });
      writeFileSync(join(s.root, 'CLAUDE.md'), '# Claude\n\nBe brief.\n');
      expect(initAgentFiles(s, { targets: ['claude'] }).files[1]!.status).toBe('updated');
      expect(readFileSync(join(s.root, 'CLAUDE.md'), 'utf8')).toBe(`# Claude\n\nBe brief.\n\n${renderClaudePointer()}`);
    } finally {
      s.close();
    }
  });

  it('one file that cannot be written does not stop the others', () => {
    const s = workspace();
    try {
      mkdirSync(join(s.root, 'CLAUDE.md'));
      writeFileSync(join(s.root, '.cursor'), 'a file where a folder should be');
      const r = initAgentFiles(s, { targets: ['agents', 'claude', 'cursor'] });
      expect(r.files.map((f) => f.status)).toEqual(['created', 'skipped', 'skipped']);
      expect(r.files[1]!.reason).toBe('it is not a file');
      expect(r.files[2]!.reason).toBeTruthy();
    } finally {
      s.close();
    }
  });

  it('a folder on the way that links outside the workspace (.cursor → elsewhere) is not written through', () => {
    const s = workspace();
    try {
      const outside = join(tmp.dir, `outside-dir-${n}`);
      mkdirSync(join(outside, 'rules'), { recursive: true });
      // a junction needs no privilege on Windows; elsewhere it is a directory link
      symlinkSync(outside, join(s.root, '.cursor'), process.platform === 'win32' ? 'junction' : 'dir');
      const r = initAgentFiles(s, { targets: ['cursor'] });
      expect(r.files.map((f) => f.status)).toEqual(['created', 'skipped']);
      expect(r.files[1]!.reason).toBe('its folder is a link to a folder outside the workspace');
      expect(existsSync(join(outside, 'rules', 'testpion.mdc'))).toBe(false);
    } finally {
      s.close();
    }
  });

  it('a workspace opened through a linked folder is itself: its files are written, once, and a link out is still refused', () => {
    const s = workspace({ viaLink: true });
    try {
      // .cursor → a folder of the workspace named by its REAL path (the other way round from the workspace's own path)
      mkdirSync(join(realpathSync(s.root), 'agent-rules', 'rules'), { recursive: true });
      symlinkSync(join(realpathSync(s.root), 'agent-rules'), join(s.root, '.cursor'), process.platform === 'win32' ? 'junction' : 'dir');
      const r = initAgentFiles(s, { targets: ['agents', 'claude', 'cursor'] });
      expect(r.files.map((f) => f.status)).toEqual(['created', 'created', 'created']);
      expect(existsSync(join(realpathSync(s.root), 'agent-rules', 'rules', 'testpion.mdc'))).toBe(true);
      expect(initAgentFiles(s, { targets: ['agents', 'claude', 'cursor'] }).files.map((f) => f.status)).toEqual(['unchanged', 'unchanged', 'unchanged']);
      const outside = join(tmp.dir, `outside-linked-${n}`);
      mkdirSync(join(outside, 'rules'), { recursive: true });
      const s2 = workspace({ viaLink: true });
      try {
        symlinkSync(outside, join(s2.root, '.cursor'), process.platform === 'win32' ? 'junction' : 'dir');
        expect(initAgentFiles(s2, { targets: ['cursor'] }).files[1]).toMatchObject({ status: 'skipped', reason: 'its folder is a link to a folder outside the workspace' });
        expect(existsSync(join(outside, 'rules', 'testpion.mdc'))).toBe(false);
      } finally {
        s2.close();
      }
    } finally {
      s.close();
    }
  });

  it('a link: followed inside the workspace (CLAUDE.md → AGENTS.md is written once), refused outside it', () => {
    // opened through a linked folder, as on macOS (/var → /private/var): the link's target is a real path, the
    // workspace's own paths are not, and both name the same AGENTS.md
    const s = workspace({ viaLink: true });
    try {
      try {
        symlinkSync(join(s.root, 'AGENTS.md'), join(s.root, 'CLAUDE.md'), 'file');
      } catch {
        return; // no symlinks without the privilege (Windows): nothing to check here
      }
      writeFileSync(join(s.root, 'AGENTS.md'), '# Mine\n');
      const r = initAgentFiles(s, { targets: ['agents', 'claude'] });
      expect(r.files.map((f) => f.status)).toEqual(['updated', 'unchanged']);
      expect(r.files[1]!.reason).toBe('it is a link to AGENTS.md');
      expect(readFileSync(join(s.root, 'AGENTS.md'), 'utf8').match(/testpion:begin/g)).toHaveLength(1);
      const outside = join(tmp.dir, `outside-${n}.md`);
      writeFileSync(outside, 'theirs\n');
      const s2 = workspace();
      try {
        symlinkSync(outside, join(s2.root, 'AGENTS.md'), 'file');
        expect(initAgentFiles(s2).files[0]).toMatchObject({ status: 'skipped', reason: 'it is a link to a file outside the workspace' });
        expect(readFileSync(outside, 'utf8')).toBe('theirs\n');
      } finally {
        s2.close();
      }
    } finally {
      s.close();
    }
  });
});
