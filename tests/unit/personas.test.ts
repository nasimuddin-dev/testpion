/**
 * The team's own personas for simulated users (personas.yaml of a workspace): read, saved, deleted, and resolved when a
 * dataset record names one.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { PERSONAS, deletePersona, listPersonas, readPersonas, savePersona, simulationOf } from '@testpion/core';

const root = mkdtempSync(join(tmpdir(), 'tp-personas-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe('personas of a workspace', () => {
  it('a workspace without the file has only the built-in ones', () => {
    expect(readPersonas(root)).toEqual([]);
    expect(listPersonas(root).every((p) => p.source === 'built-in')).toBe(true);
    expect(listPersonas(root)).toHaveLength(PERSONAS.length);
  });

  it('saves, replaces and deletes; the file is YAML a person can read', () => {
    savePersona(root, { id: 'Night-Nurse', label: 'Night nurse', text: 'Short messages with abbreviations.' });
    savePersona(root, { id: 'insider', text: 'Claims to work here.', attack: true });
    savePersona(root, { id: 'night-nurse', label: 'Night nurse', text: 'Short messages, stops after one unhelpful answer.' });
    expect(readPersonas(root)).toEqual([
      { id: 'night-nurse', label: 'Night nurse', text: 'Short messages, stops after one unhelpful answer.' },
      { id: 'insider', label: 'insider', text: 'Claims to work here.', attack: true },
    ]);
    const text = readFileSync(join(root, 'personas.yaml'), 'utf8');
    expect(text).toMatch(/^# Personas for simulated users/);
    expect(text).toContain('- id: night-nurse');
    expect(
      listPersonas(root)
        .slice(-2)
        .map((p) => [p.id, p.source]),
    ).toEqual([
      ['night-nurse', 'workspace'],
      ['insider', 'workspace'],
    ]);
    const gone = deletePersona(root, 'insider');
    expect(gone.attack).toBe(true);
    expect(readPersonas(root).map((p) => p.id)).toEqual(['night-nurse']);
  });

  it('refuses a built-in id, a bad id, an empty text and a persona that is not there', () => {
    expect(() => savePersona(root, { id: 'terse', text: 'x' })).toThrow(/built-in persona/);
    expect(() => savePersona(root, { id: 'Has Space', text: 'x' })).toThrow(/needs an id/);
    expect(() => savePersona(root, { id: 'ok', text: '  ' })).toThrow(/needs a text/);
    expect(() => deletePersona(root, 'nobody')).toThrow(/No persona "nobody"/);
    expect(() => deletePersona(root, 'terse')).toThrow(/built-in persona and stays/);
  });

  it("a record that names a workspace persona gets its text; unknown words stay the record's own description", () => {
    const own = readPersonas(root);
    const record = { expectedOutcome: 'Book a visit' } as never;
    expect(simulationOf({ persona: 'night-nurse' }, record, own)).toMatchObject({ personaId: 'night-nurse', persona: 'Short messages, stops after one unhelpful answer.', goal: 'Book a visit' });
    expect(simulationOf({ persona: 'A sleepy vet' }, record, own)).toMatchObject({ persona: 'A sleepy vet' });
    expect(simulationOf({ persona: 'A sleepy vet' }, record, own)?.personaId).toBeUndefined();
    expect(simulationOf({ persona: 'terse' }, record, own)?.personaId).toBe('terse');
  });

  it('says what is wrong with a file written by hand', () => {
    const bad = mkdtempSync(join(tmpdir(), 'tp-personas-bad-'));
    try {
      writeFileSync(join(bad, 'personas.yaml'), '- id: a\n  text: one\n- id: a\n  text: two\n');
      expect(() => readPersonas(bad)).toThrow(/"a" is there twice/);
      writeFileSync(join(bad, 'personas.yaml'), 'name: x\n');
      expect(() => readPersonas(bad)).toThrow(/must be a list of personas/);
    } finally {
      rmSync(bad, { recursive: true, force: true });
    }
  });
});
