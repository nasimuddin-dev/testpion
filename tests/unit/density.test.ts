import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { COMPACT_SCALE, densityScale, scaledRow } from '../../apps/desktop/src/lib/density';

// Compact density is design tokens only (styles.css): the spacing every utility is made of, small text, form fields;
// VirtualList rows scale by the same ratio.
const css = readFileSync(join(__dirname, '../../apps/desktop/src/styles.css'), 'utf8');
const block = css.slice(css.indexOf(":root[data-density='compact']"), css.indexOf('}', css.indexOf(":root[data-density='compact']")));

describe('density', () => {
  it('compact is one block of tokens, and rows scale like the spacing', () => {
    const spacing = Number(/--spacing: ([\d.]+)rem/.exec(block)?.[1]);
    expect(spacing).toBeGreaterThan(0);
    expect(COMPACT_SCALE).toBeCloseTo(spacing / 0.25, 2);
    for (const t of ['--text-xs', '--text-sm', '--control-h', '--control-px', '--control-py']) expect(block).toContain(t);
    // the small text sizes are theme variables (not inlined), or compact could not change them
    expect(css).not.toMatch(/@theme inline \{[^}]*--text-sm:/);
    expect(css).toMatch(/\.field \{[^}]*min-height: var\(--control-h\)/);
  });

  it('row heights in whole pixels', () => {
    expect(densityScale('comfortable')).toBe(1);
    expect(scaledRow(28, 'comfortable')).toBe(28);
    expect(scaledRow(28, 'compact')).toBe(24);
    expect(scaledRow(44, 'compact')).toBe(38);
    expect(scaledRow(20, 'compact')).toBe(17);
  });
});
