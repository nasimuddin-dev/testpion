import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { AI_TAB_NAME, RAG_TAB_NAME, SETTINGS_TAB_NAME, VIEW_NAME, inSettings, where } from '../../apps/desktop/src/lib/ui-names';

const SRC = join(__dirname, '../../apps/desktop/src');
const files = (dir: string): string[] =>
  readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? files(p) : /\.tsx?$/.test(n) ? [p] : [];
  });

// the names that are more than one common word: spelled out in code they would drift when a place is renamed
const NAMES = [VIEW_NAME.aiQuality, VIEW_NAME.rag, AI_TAB_NAME.playground, AI_TAB_NAME.providers, SETTINGS_TAB_NAME.privacy, SETTINGS_TAB_NAME.load, SETTINGS_TAB_NAME.agents];
// two names are also plain words in sentences (the assistant, the price table): only their exact spelling is a place
const EXACT = [SETTINGS_TAB_NAME.assistant, SETTINGS_TAB_NAME.pricing];

describe('the names of the places are written once', () => {
  it('points at a place through the constants', () => {
    expect(inSettings('assistant')).toBe('Settings ▸ AI Assistant');
    expect(where(VIEW_NAME.aiQuality, AI_TAB_NAME.checks)).toBe('AI Quality ▸ Checks');
    expect(RAG_TAB_NAME.checks).toBe('Checks');
  });

  it('no code line of the app spells one out (comments may)', () => {
    const found: string[] = [];
    const lower = NAMES.map((n) => n.toLowerCase());
    for (const f of files(SRC)) {
      if (f.endsWith('ui-names.ts')) continue;
      readFileSync(f, 'utf8')
        .split(/\r?\n/)
        .forEach((line, i) => {
          const t = line.trim();
          if (t.startsWith('//') || t.startsWith('*') || t.startsWith('/*')) return;
          const code = line.replace(/\/\*.*?\*\//g, '').replace(/\s\/\/ .*$/, '');
          if (lower.some((n) => code.toLowerCase().includes(n)) || EXACT.some((n) => code.includes(n))) found.push(`${f.slice(SRC.length + 1)}:${i + 1}: ${t.slice(0, 100)}`);
        });
    }
    expect(found).toEqual([]);
  });
});
