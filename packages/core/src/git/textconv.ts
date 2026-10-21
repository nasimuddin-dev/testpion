import { isRecord } from '@testpion/shared';
import { readFileSync } from 'node:fs';
import { stableValue } from '../storage/stable-files.js';
import { parseYaml, stringifyYaml } from '../util/lazy-yaml.js';
import { runGit } from './git.js';

/**
 * The readable-diff driver (release C of planning/git-everything.md §4d): `git diff` and `git log -p` of a collection, an
 * environment, a library file, the MCP servers or the AI providers show the items that changed, each under its own
 * heading, instead of lines of JSON whose braces moved.
 *
 * Git calls the driver with a temporary file and no path, so the kind is recognised by the file's shape, as the merge
 * driver does. It is one-way (a view for people; git still stores and merges the JSON itself) and never reorders the
 * file's content: the same item prints the same lines every time, so only a real change shows.
 *
 * Set up by "Fix git setup" (`testpion git fix`): `diff=testpion` lines in .gitattributes and `diff.testpion.textconv` in
 * the repository's config. For people who never open TestPion: `git config diff.testpion.textconv "testpion git textconv"`
 * and `git config diff.testpion.xfuncname "^== (.*) ==$"` do the same by hand (docs/getting-started/git.md).
 */

type Rec = Record<string, unknown>;
const body = (v: unknown): string => JSON.stringify(stableValue(v), null, 2);

/** The heading of an item: the line `diff.testpion.xfuncname` shows as the hunk's context. */
const head = (path: string[], id: unknown, what: string) => `== ${path.join(' ▸ ')} [${what}${typeof id === 'string' ? ` ${id}` : ''}] ==`;

/** A collection's folders and requests, each one block; the collection's own settings first. */
function collection(c: Rec): string {
  const out: string[] = [head([String(c.name ?? c.id ?? 'Collection')], c.id, 'collection'), body(Object.fromEntries(Object.entries(c).filter(([k]) => k !== 'items')))];
  const walk = (nodes: unknown, trail: string[]) => {
    if (!Array.isArray(nodes)) return;
    for (const n of nodes) {
      if (!isRecord(n)) continue;
      const path = [...trail, String(n.name ?? n.id ?? '?')];
      out.push(head(path, n.id, String(n.kind ?? 'item')), body(Object.fromEntries(Object.entries(n).filter(([k]) => k !== 'items'))));
      walk(n.items, path);
    }
  };
  walk(c.items, [String(c.name ?? c.id ?? 'Collection')]);
  return out.join('\n') + '\n';
}

/** A file that is a list of items with ids: MCP servers, providers, a library's items. */
function list(doc: Rec, key: string, what: string, label: string): string {
  const out: string[] = [head([label], undefined, what), body(Object.fromEntries(Object.entries(doc).filter(([k]) => k !== key)))];
  for (const i of doc[key] as unknown[]) {
    if (!isRecord(i)) continue;
    out.push(head([label, String(i.name ?? i.key ?? i.id ?? '?')], i.id, what), body(i));
  }
  return out.join('\n') + '\n';
}

/**
 * A test or flow file (YAML): the file's own settings first, then each step under a heading of its own, as YAML, so a
 * `git diff` of a flow names the step that changed. Steps are the list under `steps:` (a flow) or `tests:` (a test file);
 * a YAML document without one (an API definition, a mock) is not read this way.
 */
function steps(doc: Rec, label: string): string | undefined {
  const key = Array.isArray(doc.steps) ? 'steps' : Array.isArray(doc.tests) ? 'tests' : undefined;
  if (!key) return undefined;
  const list = (doc[key] as unknown[]).filter(isRecord);
  if (!list.length || !list.every((s) => 'id' in s || 'name' in s || 'request' in s)) return undefined;
  const title = String(doc.name ?? label);
  const rest = Object.fromEntries(Object.entries(doc).filter(([k]) => k !== key));
  const out: string[] = [head([title], undefined, key === 'steps' ? 'flow' : 'test file'), Object.keys(rest).length ? stringifyYaml(rest).trimEnd() : '(no settings)'];
  for (const st of list) out.push(head([title, String(st.name ?? st.id ?? '?')], st.id, 'step'), stringifyYaml(st).trimEnd());
  return out.join('\n') + '\n';
}

/**
 * The readable text of a TestPion JSON file or a test / flow YAML file, or undefined when the text is not one (a raw
 * document, other JSON or YAML, a broken file): the caller then prints the text as it is.
 */
export function textconvText(text: string): string | undefined {
  let doc: unknown;
  try {
    doc = JSON.parse(text.replace(/^﻿/, ''));
  } catch {
    // not JSON: a test or flow file is YAML (anything else YAML prints as it is)
    if (!/^(?:tests|steps):\s*$/m.test(text)) return undefined;
    try {
      const y = parseYaml(text);
      return isRecord(y) ? steps(y, 'Test file') : undefined;
    } catch {
      return undefined;
    }
  }
  if (!isRecord(doc)) return undefined;
  if (Array.isArray(doc.servers)) return list(doc, 'servers', 'MCP server', 'MCP servers');
  if (Array.isArray(doc.providers)) return list(doc, 'providers', 'AI provider', 'AI providers');
  if (Array.isArray(doc.items) && Array.isArray(doc.folders)) return list(doc, 'items', 'saved item', 'Saved items');
  if (Array.isArray(doc.items) && typeof doc.id === 'string') return collection(doc);
  if (Array.isArray(doc.variables) && typeof doc.id === 'string') return list(doc, 'variables', 'variable', String(doc.name ?? doc.id));
  return undefined;
}

/** What `testpion git textconv <file>` prints: the readable text of the file, or the file itself. */
export function textconvFile(path: string): string {
  const text = readFileSync(path, 'utf8');
  return textconvText(text) ?? text;
}

/**
 * Register the driver for this repository (local config only): `command` runs it with the temporary file appended, e.g.
 * `testpion git textconv` or `"C:/…/TestPion.exe" --textconv`. The hunk header names the item (xfuncname), and git keeps
 * the converted text of a blob in its cache so a long `git log -p` converts each version once.
 */
export async function gitSetupTextconv(ws: string, command: string): Promise<void> {
  await runGit(ws, ['config', 'diff.testpion.textconv', command]);
  await runGit(ws, ['config', 'diff.testpion.xfuncname', '^== (.*) ==$']);
  await runGit(ws, ['config', 'diff.testpion.cachetextconv', 'true']);
}
