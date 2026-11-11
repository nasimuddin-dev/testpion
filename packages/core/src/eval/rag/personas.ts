/**
 * The team's own personas for simulated users: `personas.yaml` next to workspace.json, a list of `{ id, label?, text,
 * attack? }`. A dataset record names one by its id in the `persona` column, as it names a built-in one (simulate.ts). The
 * file is plain text the team edits and git carries; the app's Personas dialog writes the same file.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ApsError } from '../../errors.js';
import { atomicWrite } from '../../storage/fsutil.js';
import { parseYamlShared, stringifyYaml } from '../../util/lazy-yaml.js';
import { PERSONAS } from './simulate.js';

export const PERSONAS_FILE = 'personas.yaml';
const MAX_PERSONAS = 200;
const MAX_TEXT = 2000;

export interface Persona {
  id: string;
  label: string;
  /** The user in words: how they write, what they leave out, when they give up. */
  text: string;
  /** An attacker: its goal is what the system must not do. */
  attack?: boolean;
}
export interface ListedPersona extends Persona {
  /** Shipped with TestPion (cannot be changed) or kept in the workspace's personas.yaml. */
  source: 'built-in' | 'workspace';
}

const ID = /^[a-z0-9][a-z0-9-]{0,39}$/;

function clean(raw: unknown, where: string): Persona {
  const p = (raw ?? {}) as Record<string, unknown>;
  const id = String(p.id ?? '')
    .trim()
    .toLowerCase();
  if (!ID.test(id)) throw new ApsError('ValidationError', `${where}: a persona needs an id of lower-case letters, digits and dashes (at most 40), not "${String(p.id ?? '')}"`);
  if (PERSONAS.some((b) => b.id === id))
    throw new ApsError('ValidationError', `${where}: "${id}" is a built-in persona`, { suggestions: ['Give yours another id; a record can also describe the user in words in its persona column.'] });
  const text = String(p.text ?? '').trim();
  if (!text) throw new ApsError('ValidationError', `${where}: the persona "${id}" needs a text: the user in words`);
  if (text.length > MAX_TEXT) throw new ApsError('ValidationError', `${where}: the text of "${id}" is ${text.length} characters (at most ${MAX_TEXT})`);
  const label = String(p.label ?? '').trim() || id;
  return { id, label: label.slice(0, 80), text, ...(p.attack === true ? { attack: true } : {}) };
}

/** The workspace's own personas; [] without the file. A file that cannot be read throws with its reason. */
export function readPersonas(root: string): Persona[] {
  const file = join(root, PERSONAS_FILE);
  if (!existsSync(file)) return [];
  const value = parseYamlShared(readFileSync(file, 'utf8'));
  if (value === null || value === undefined) return [];
  const list = Array.isArray(value) ? value : (value as { personas?: unknown }).personas;
  if (!Array.isArray(list)) throw new ApsError('ValidationError', `${PERSONAS_FILE} must be a list of personas (id, text, optional label and attack)`);
  const out: Persona[] = [];
  for (const [i, raw] of list.slice(0, MAX_PERSONAS).entries()) {
    const p = clean(raw, `${PERSONAS_FILE} #${i + 1}`);
    if (out.some((x) => x.id === p.id)) throw new ApsError('ValidationError', `${PERSONAS_FILE}: the id "${p.id}" is there twice`);
    out.push(p);
  }
  return out;
}

/** The personas a simulated user can be: the built-in ones, then the workspace's own. */
export function listPersonas(root?: string): ListedPersona[] {
  return [...PERSONAS.map((p) => ({ ...p, source: 'built-in' as const })), ...(root ? readPersonas(root) : []).map((p) => ({ ...p, source: 'workspace' as const }))];
}

function write(root: string, personas: Persona[]): void {
  const head =
    '# Personas for simulated users (TestPion). A dataset record names one in its "persona" column.\n# id: lower-case letters, digits, dashes. text: the user in words. attack: true for a red-team persona.\n';
  atomicWrite(join(root, PERSONAS_FILE), head + stringifyYaml(personas.map((p) => ({ id: p.id, label: p.label, text: p.text, ...(p.attack ? { attack: true } : {}) }))));
}

/** Adds a persona to the workspace, or replaces the one with the same id. */
export function savePersona(root: string, raw: unknown): Persona {
  const p = clean(raw, 'Persona');
  const all = readPersonas(root);
  const i = all.findIndex((x) => x.id === p.id);
  if (i < 0 && all.length >= MAX_PERSONAS) throw new ApsError('ValidationError', `A workspace keeps at most ${MAX_PERSONAS} personas`);
  if (i >= 0) all[i] = p;
  else all.push(p);
  write(root, all);
  return p;
}

/** Removes a workspace persona; the removed one is returned so the caller can offer Undo (savePersona puts it back). */
export function deletePersona(root: string, id: string): Persona {
  const all = readPersonas(root);
  const i = all.findIndex((x) => x.id === id.trim().toLowerCase());
  if (i < 0) throw new ApsError('ValidationError', PERSONAS.some((b) => b.id === id) ? `"${id}" is a built-in persona and stays` : `No persona "${id}" in ${PERSONAS_FILE}`);
  const [gone] = all.splice(i, 1);
  write(root, all);
  return gone!;
}
