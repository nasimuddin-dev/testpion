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
/** Every <Empty …>…</Empty> with its children (empty for a self-closing tag). */
function emptyBlocks(text: string): Array<{ tag: string; children: string }> {
  const out: Array<{ tag: string; children: string }> = [];
  for (const tag of emptyTags(text)) {
    const at = text.indexOf(tag);
    if (tag.endsWith('/>')) out.push({ tag, children: '' });
    else {
      const end = text.indexOf('</Empty>', at + tag.length);
      out.push({ tag, children: end < 0 ? '' : text.slice(at + tag.length, end) });
    }
  }
  return out;
}
const all = files(SRC).flatMap((f) => emptyBlocks(readFileSync(f, 'utf8')).map((b) => ({ file: f.slice(SRC.length + 1).replace(/\\/g, '/'), ...b })));

/** The dead ends of the plan's table: each must offer its next step. */
const MUST_ACT = [
  'No saved load tests',
  'No saved evaluations',
  'No saved prompts',
  'Nothing sent yet',
  'No open requests',
  'No cookies yet',
  'No history yet',
  'No traces yet',
  // UI audit 2026-10-21 (§1): they named the step without offering it
  'No collections yet',
  'Nothing captured yet',
  'No schema loaded',
  'Describe the service with .proto files',
  'Configure and start a load test',
  'No examples to serve',
  'No evaluation runs yet',
  'No rules in this profile',
  'No datasets yet',
  'Git is not installed',
  'No commits yet',
];

/**
 * An empty state titled "No …", "Nothing …" or "Couldn't …" offers the next step (`actions`: Retry for a failure).
 * These are the ones where nothing applies, each with why.
 */
const DEAD_ENDS: Record<string, string> = {
  'No prompts': 'the MCP server offers no prompts: only the server can change that',
  'No commits yet': 'the commit box is right above it (Stage, then Commit)',
  'No trace stored for this result': 'traces are kept by the run that made them; this result has none',
  'No results in this run': 'a finished run: nothing to start here',
  'No results match': 'the filter field is right above it',
  'No rule matches': 'the filter field is right above it (Change the filter)',
  'No messages yet': 'messages come in on their own once connected',
  'No earlier responses yet': 'a response is kept each time the saved request is sent (the Send button is above)',
  'No earlier response to compare with': 'the next Send is compared with this one (the Send button is above)',
  'No matching cookies': 'the filter field is right above it',
  'No matches': 'the filter field is right above it',
  'No runs match': 'offers Clear filter',
  'No prompts run yet': 'a usage report: prompts are run in the Playground beside it',
  'Nothing finished yet': 'a report of live traffic: it fills as requests complete',
  'No connections yet': 'a report of live traffic: it fills as programs connect',
  'No tool calls yet': 'a usage report: tools are called in the Tools tab beside it',
};
const titleOf = (tag: string) => /\stitle="([^"]*)"/.exec(tag)?.[1];

describe('empty states', () => {
  it('use one API: no `action=` element, only `actions`', () => {
    expect(all.filter((e) => /\saction=\{/.test(e.tag)).map((e) => e.file)).toEqual([]);
  });

  it("the plan's dead ends offer their next step", () => {
    const missing = MUST_ACT.filter((title) => {
      const tags = all.filter((e) => e.tag.includes(`title="${title}"`));
      return !tags.length || tags.some((e) => !/\sactions=\{/.test(e.tag));
    }).filter((t) => !(t in DEAD_ENDS));
    expect(missing).toEqual([]);
  });

  it('a first run ("No … yet", "Nothing … yet") and a failure ("Couldn\'t …") offer the next step (Retry for a failure), unless nothing applies', () => {
    const missing = all.filter((e) => {
      const t = titleOf(e.tag);
      return t && /^((No|Nothing) .* yet|Couldn't .*)$/.test(t) && !/\sactions=\{/.test(e.tag) && !(t in DEAD_ENDS);
    });
    expect(missing.map((e) => `${e.file}: ${titleOf(e.tag)}`)).toEqual([]);
    // a failure's next step is to try again
    const noRetry = all.filter((e) => /^Couldn't /.test(titleOf(e.tag) ?? '') && !/label: 'Retry'/.test(e.tag));
    expect(noRetry.map((e) => `${e.file}: ${titleOf(e.tag)}`)).toEqual([]);
    for (const why of Object.values(DEAD_ENDS)) expect(why).toMatch(/.{12,}/);
  });

  it('a button of an empty state is an action: no <Button> or <LinkButton> among its children', () => {
    expect(all.filter((e) => /<(Link)?Button\b/.test(e.children)).map((e) => `${e.file}: ${titleOf(e.tag)}`)).toEqual([]);
  });

  it('a wait is not an empty state: no Empty titled "Loading…", the shared Busy instead', () => {
    // (a live list that is empty while it waits, "Waiting for requests…" while recording, is an empty state: its title is not a constant)
    expect(all.filter((e) => /\stitle="[^"]*…"/.test(e.tag)).map((e) => `${e.file}: ${titleOf(e.tag)}`)).toEqual([]);
  });

  it('an empty state that says where to click offers that button instead', () => {
    // (double-click and Ctrl+click describe the list beside it, not a button)
    expect(all.filter((e) => /(?<![-+])\b[Cc]lick\b/.test(e.children) && !/\sactions=\{/.test(e.tag)).map((e) => `${e.file}: ${titleOf(e.tag)}`)).toEqual([]);
  });

  it('the plain-text empties the audit found are Empty now', () => {
    const src = (rel: string) => readFileSync(join(SRC, rel), 'utf8');
    expect(src('views/GitView.tsx')).not.toMatch(/>No commits yet\.</);
    expect(src('views/MonitorsView.tsx')).not.toMatch(/>No runs yet\. /);
    expect(src('components/TraceView.tsx')).not.toMatch(/>Select a span</);
  });
});
