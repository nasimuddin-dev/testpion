/** The text on a tinted chip or a selected row is at least 4.5:1 in both themes (the 2026-10-27 review: accent on accent-soft was 4.19:1 in light). */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const css = readFileSync(join(__dirname, '../../apps/desktop/src/styles.css'), 'utf8');
const block = (selector: string) => {
  const at = css.indexOf(`${selector} {`);
  return css.slice(at, css.indexOf('\n}', at));
};
const light = block(':root');
const dark = block("[data-theme='dark']");
const token = (b: string, name: string) => new RegExp(`${name}:\\s*([^;]+);`).exec(b)?.[1]?.trim();
const lin = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const rgb = (v: string): [number, number, number] => {
  if (v.startsWith('#')) return [1, 3, 5].map((i) => lin(parseInt(v.slice(i, i + 2), 16) / 255)) as [number, number, number];
  const [l, c, h] = /oklch\(([\d.]+) ([\d.]+) ([\d.]+)/.exec(v)!.slice(1).map(Number) as [number, number, number];
  const a = c * Math.cos((h * Math.PI) / 180);
  const b = c * Math.sin((h * Math.PI) / 180);
  const l_ = (l + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m_ = (l - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s_ = (l - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [4.0767416621 * l_ - 3.3077115913 * m_ + 0.2309699292 * s_, -1.2684380046 * l_ + 2.6097574011 * m_ - 0.3413193965 * s_, -0.0041960863 * l_ - 0.7034186147 * m_ + 1.707614701 * s_].map((x) => Math.min(1, Math.max(0, x))) as [number, number, number];
};
const lum = (v: string) => {
  const [r, g, b] = rgb(v);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const ratio = (a: string, b: string) => {
  const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
  return (x! + 0.05) / (y! + 0.05);
};

describe('token pairs that carry text', () => {
  const PAIRS: Array<[string, string]> = [
    ['--chip-fg', '--chip'],
    ['--fg', '--chip'],
    ['--fg', '--hover'],
    ['--chip-fg', '--hover'],
  ];
  for (const [name, b] of [['light', light], ['dark', dark]] as const)
    for (const [fg, bg] of PAIRS)
      it(`${name}: ${fg} on ${bg} is at least 4.5:1`, () => {
        const f = token(b, fg) ?? token(light, fg)!;
        const g = token(b, bg) ?? token(light, bg)!;
        expect(ratio(f, g)).toBeGreaterThanOrEqual(4.5);
      });

  it('the chip tokens are defined for both themes and exposed as utilities', () => {
    expect(token(light, '--chip')).toBeTruthy();
    expect(token(dark, '--chip')).toBeTruthy();
    expect(css).toContain('--color-chip: var(--chip)');
  });
});
