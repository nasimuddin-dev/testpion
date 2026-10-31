import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

/**
 * The docs are for every kind of reader (planning: easy docs). The front-door pages, the ones a new person opens first, keep to plain
 * language: short sentences, short paragraphs, and a short "In short" box that says what the page is and what you need. This guards
 * them; the other pages are measured by `docs-readability` below and may only get easier.
 */
const root = resolve('docs');

/** The pages a new reader meets first. */
const FRONT_DOOR = ['getting-started/start-here', 'getting-started/troubleshooting', 'getting-started/first-request', 'getting-started/installation', 'getting-started/check-a-rag-bot', 'getting-started/check-an-agent'];
/** Pages that carry an In short box (the key guides and references). */
const WITH_IN_SHORT = [
  ...FRONT_DOOR,
  'features',
  'getting-started/glossary',
  'getting-started/finding-your-way',
  'getting-started/first-ai-test',
  'getting-started/workspaces',
  'getting-started/save-and-export-results',
  'getting-started/git',
  'getting-started/team',
  'test-runner/overview',
  'test-runner/ci-cd',
  'test-runner/assertions',
  'test-runner/datasets',
  'test-runner/monitors',
  'test-runner/integration-testing',
  'api-testing/rest',
  'api-testing/authentication',
  'api-testing/environments',
  'api-testing/http-debugger',
  'mcp/overview',
  'ai-testing/overview',
  'ai-testing/evaluations',
  'ai-testing/prompts',
  'ai-testing/agents',
  'ai-testing/safety',
  'security/secrets',
  'security/privacy',
  'performance/load-testing',
  'migrate/index',
  'cli/reference',
];

const read = (page: string) => readFileSync(join(root, `${page}.md`), 'utf8').replace(/\r\n/g, '\n');
const words = (s: string) => s.match(/[A-Za-z’']+/g) ?? [];

/** Prose only: no front matter, code, HTML, tables, headings or container lines; links and emphasis reduced to their text. */
function prose(md: string): string[] {
  const t = md
    .replace(/^---[\s\S]*?---/, '')
    .replace(/```[\s\S]*?```/g, '')
    .replace(/<[^>]+>/g, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/[`*]/g, '');
  return t.split(/\n\s*\n/).filter((p) => p.trim() && !/^\s*(\||#|:::)/.test(p));
}

function stats(md: string) {
  const paragraphs = prose(md);
  const sentences = paragraphs.flatMap((p) => p.split('\n').flatMap((l) => l.replace(/^\s*(?:[-*]|\d+\.)\s+/, '').split(/(?<=[.!?])\s+/))).filter((s) => words(s).length > 2);
  const avg = sentences.reduce((n, s) => n + words(s).length, 0) / Math.max(1, sentences.length);
  const longest = Math.max(0, ...paragraphs.map((p) => words(p).length));
  return { avg, longest, sentences: sentences.length };
}

describe('docs for every reader', () => {
  it('every page that should have one starts with an In short box (a tip right under the title)', () => {
    const bad: string[] = [];
    for (const page of WITH_IN_SHORT) {
      expect(existsSync(join(root, `${page}.md`)), page).toBe(true);
      const md = read(page);
      const h1 = md.search(/^# /m);
      const tip = md.search(/^::: tip In short$/m);
      // right under the first heading, before any other heading
      const nextHeading = md.slice(h1 + 1).search(/^##? /m);
      if (tip < 0 || tip < h1 || (nextHeading >= 0 && tip > h1 + 1 + nextHeading)) bad.push(page);
    }
    expect(bad).toEqual([]);
  });

  it('an In short box is short: at most two sentences or 45 words', () => {
    const bad: string[] = [];
    for (const page of WITH_IN_SHORT) {
      const m = /^::: tip In short\n([\s\S]*?)\n:::/m.exec(read(page));
      if (!m) continue;
      const w = words(m[1]!.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')).length;
      if (w > 45) bad.push(`${page}: ${w} words`);
    }
    expect(bad).toEqual([]);
  });

  it('the front-door pages use short sentences and short paragraphs', () => {
    const bad: string[] = [];
    for (const page of FRONT_DOOR) {
      const s = stats(read(page));
      if (s.avg > 18) bad.push(`${page}: sentences average ${s.avg.toFixed(1)} words (at most 18)`);
      if (s.longest > 100) bad.push(`${page}: a paragraph of ${s.longest} words (at most 100)`);
    }
    expect(bad).toEqual([]);
  });

  it('Start here answers the questions a newcomer has: who am I, what first, which page for my task, what does this word mean', () => {
    const md = read('getting-started/start-here');
    for (const h of ['## Who are you?', '## Try it in two minutes', '## I want to… (find a task)', '## The words you will meet']) expect(md).toContain(h);
    // every link on the page points at a page that exists
    const missing: string[] = [];
    for (const m of md.matchAll(/\]\((\/[^)#]+)(#[^)]*)?\)/g)) {
      const page = m[1]!.replace(/^\//, '').replace(/\/$/, '');
      if (!existsSync(join(root, `${page}.md`)) && !existsSync(join(root, page, 'index.md'))) missing.push(m[1]!);
    }
    expect(missing).toEqual([]);
  });

  it('the glossary and the home page link only to pages that exist', () => {
    const missing: string[] = [];
    for (const page of ['getting-started/glossary', 'index']) {
      for (const m of read(page).matchAll(/\]\((\/[^)#\s]+)(#[^)]*)?\)/g)) {
        const target = m[1]!.replace(/^\//, '').replace(/\/$/, '');
        if (/^(images|download|changelog|faq|roadmap)/.test(target) && !target.includes('/')) continue;
        if (!existsSync(join(root, `${target}.md`)) && !existsSync(join(root, target, 'index.md')) && !existsSync(join(root, 'public', target))) missing.push(`${page}: ${m[1]}`);
      }
    }
    expect(missing).toEqual([]);
  });
});
