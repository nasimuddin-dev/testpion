import { describe, expect, it } from 'vitest';
import { paletteScore, rankPalette } from '../../apps/desktop/src/lib/palette-rank';

// The palette's ranking: the label first (exact, prefix, word start, inside), then the hint / detail / group, stable within a rank.
const blocks = [
  { label: 'HTTP request', group: 'Requests', detail: 'A REST call' },
  { label: 'LLM prompt', group: 'Requests', detail: 'Ask a model' },
  { label: 'Condition (if / else)', group: 'Logic', detail: 'Branch on an expression' },
  { label: 'For each (loop)', group: 'Logic', detail: 'Run a request once per row; set the rows' },
  { label: 'Delay', group: 'Logic', detail: 'Pause the flow for a while' },
  { label: 'Set variable', group: 'Data', detail: 'Keep a value for later steps' },
  { label: 'Log', group: 'Data', detail: 'Show a value in the run results' },
  { label: 'Log in (get a JWT)', group: 'Saved requests' },
  { label: 'Delete the post', group: 'Saved requests' },
  { label: 'Catalog', group: 'Saved requests' },
];
const labels = (q: string) => rankPalette(blocks, q).map((b) => b.label);

describe('palette ranking', () => {
  it('puts the exact label first, then labels starting with the text', () => {
    expect(labels('Log')[0]).toBe('Log');
    expect(labels('log').slice(0, 2)).toEqual(['Log', 'Log in (get a JWT)']);
    expect(labels('del')[0]).toBe('Delay');
    expect(labels('del').slice(0, 2)).toEqual(['Delay', 'Delete the post']);
    expect(labels('set')[0]).toBe('Set variable');
  });

  it('ranks a word start above a match inside a word, and the label above the detail or group', () => {
    expect(paletteScore({ label: 'Log in' }, 'in')).toBe(2);
    expect(paletteScore({ label: 'Catalog' }, 'log')).toBe(3);
    expect(paletteScore({ label: 'Condition', group: 'Logic' }, 'log')).toBe(4);
    // 'log' is in Catalog (inside the label): before the Logic group's blocks
    const l = labels('log');
    expect(l.indexOf('Catalog')).toBeLessThan(l.indexOf('Condition (if / else)'));
  });

  it('needs every word somewhere, keeps the list order within a rank and keeps everything for no text', () => {
    expect(labels('request zzz')).toEqual([]);
    expect(labels('a value')).toEqual(['Set variable', 'Log']);
    expect(labels('')).toEqual(blocks.map((b) => b.label));
    expect(labels('  ')).toEqual(blocks.map((b) => b.label));
    expect(labels('HTTP REQUEST')).toEqual(['HTTP request']);
  });
});
