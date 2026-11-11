/**
 * The documentation as plain Markdown for AI agents (N-5): what the docs build writes as `<page>.md` and `llms-full.txt`.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { llmsFull, pageMarkdown, plainPage } from '../../docs/.vitepress/llms-full.js';

const SITE = 'https://example.test/docs/';
const SRC = `---
title: "Tools"
description: "Call the tools of an MCP server."
---

# Tools

::: tip In short
Connect, pick a tool, fill its arguments.
:::

::: v-pre

## Are the tools easy for an agent? {#lint}

See [mocking](/mcp/mocking) and [the section](/ai-testing/rag#simulated-users), or [another site](https://other.test/x).

<!-- a note for editors -->

\`\`\`bash
testpion mcp --lint   # ::: not a container {#keep}
\`\`\`

:::
`;

describe('a docs page as plain Markdown', () => {
  it('drops the front matter, container fences, anchors and comments; keeps code as it is; makes site links absolute', () => {
    const p = plainPage('mcp/tools.md', SRC, SITE);
    expect(p).toMatchObject({ path: 'mcp/tools.md', title: 'Tools', description: 'Call the tools of an MCP server.' });
    expect(p.body).toBe(
      [
        '# Tools',
        '',
        '**In short**',
        'Connect, pick a tool, fill its arguments.',
        '',
        '## Are the tools easy for an agent?',
        '',
        'See [mocking](https://example.test/docs/mcp/mocking) and [the section](https://example.test/docs/ai-testing/rag#simulated-users), or [another site](https://other.test/x).',
        '',
        '```bash',
        'testpion mcp --lint   # ::: not a container {#keep}',
        '```',
      ].join('\n'),
    );
    expect(pageMarkdown(p).startsWith('# Tools\n\n**In short**')).toBe(true);
    // a page without a heading gets its title
    expect(pageMarkdown(plainPage('x.md', '---\ntitle: X page\n---\nJust text.', SITE))).toBe('# X page\n\nJust text.\n');
    expect(plainPage('a/b.md', 'No title here.', SITE).title).toBe('a/b');
  });

  it('puts every page in one file under its address', () => {
    const pages = [plainPage('index.md', '# Home\n\nWelcome.', SITE), plainPage('mcp/tools.md', SRC, SITE)];
    const all = llmsFull(pages, { site: SITE, name: 'TestPion', summary: 'A testing app.', version: '9.9.9' });
    expect(all.startsWith('# TestPion documentation (version 9.9.9)\n\n> A testing app.\n')).toBe(true);
    expect(all).toContain('<!-- page: https://example.test/docs/ -->\n# Home');
    expect(all).toContain('<!-- page: https://example.test/docs/mcp/tools -->\n_Call the tools of an MCP server._\n\n# Tools');
    expect(all.endsWith('```\n')).toBe(true);
  });

  it('reads the real pages of the site without leaving a container fence or an anchor behind', () => {
    for (const path of ['mcp/tools.md', 'ai-testing/safety.md', 'ai-testing/rag.md']) {
      const p = plainPage(path, readFileSync(`docs/${path}`, 'utf8'), SITE);
      const prose = p.body.replace(/```[\s\S]*?```/g, '');
      expect(prose, path).not.toMatch(/^:::/m);
      expect(prose, path).not.toMatch(/^#+ .*\{#[\w-]+\}\s*$/m);
      expect(p.body.length, path).toBeGreaterThan(500);
    }
  });
});
