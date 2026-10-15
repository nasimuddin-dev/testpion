import { describe, expect, it } from 'vitest';
import { fitText, textWidth } from '../../apps/desktop/src/lib/fit-text';

// the flow canvas fits every label to its box: a fixed-width measure makes the cuts exact
const measure = (t: string, f: { size: number }) => [...t].length * f.size * 0.5;
const font = { size: 10 };

describe('fitText', () => {
  it('keeps a text that fits', () => {
    expect(fitText('Log in', 60, font, measure)).toBe('Log in');
    expect(fitText('', 60, font, measure)).toBe('');
  });
  it('cuts a long text to the width, with an ellipsis, never wider than the room', () => {
    const t = fitText('GET https://api.example.com/orders/12345/items', 100, font, measure);
    expect(t.endsWith('…')).toBe(true);
    expect(measure(t, font)).toBeLessThanOrEqual(100);
    // the longest cut that fits: one more character would not
    const body = t.slice(0, -1);
    expect(measure(`${'GET https://api.example.com/orders/12345/items'.slice(0, body.length + 1)}…`, font)).toBeGreaterThan(100);
  });
  it('drops the text when not even the ellipsis fits, and trims a space before the ellipsis', () => {
    expect(fitText('Anything', 4, font, measure)).toBe('');
    expect(fitText('Anything', 0, font, measure)).toBe('');
    expect(fitText('ab cdefgh', 20, font, measure)).toBe('ab…');
  });
  it('measures without a canvas (a server, tests) with an estimate, and caches it', () => {
    const w = textWidth('Read the profile', { size: 13 });
    expect(w).toBeGreaterThan(0);
    expect(textWidth('Read the profile', { size: 13 })).toBe(w);
    expect(textWidth('Read the profile', { size: 13, mono: true })).not.toBe(w);
  });
});
