import { describe, expect, it } from 'vitest';
import { parseGates } from '../../packages/core/src/index.js';
import { gatesText, parseGatesText } from '../../apps/desktop/src/lib/gates-text';

// The gates field of an evaluation says the same thing as `--min` and as the monitor's field.
describe('the gates field', () => {
  it('reads metric=minimum, comma or line separated, and says nothing for an empty field', () => {
    expect(parseGatesText('faithfulness=0.8, recall@5=0.9')).toEqual({ faithfulness: 0.8, 'recall@5': 0.9 });
    expect(parseGatesText('faithfulness: 0.8\ncontext-recall = 0.7')).toEqual({ faithfulness: 0.8, 'context-recall': 0.7 });
    expect(parseGatesText('')).toEqual({});
    expect(parseGatesText('  ')).toEqual({});
  });
  it('refuses text that is not a gate, so the field can say so', () => {
    expect(parseGatesText('faithfulness')).toBeUndefined();
    expect(parseGatesText('faithfulness=high')).toBeUndefined();
    expect(parseGatesText('0.8')).toBeUndefined();
  });
  it('writes the gates back the way it reads them, and the command line reads the same text', () => {
    const g = { faithfulness: 0.8, 'recall@5': 0.9 };
    expect(gatesText(g)).toBe('faithfulness=0.8, recall@5=0.9');
    expect(parseGatesText(gatesText(g))).toEqual(g);
    expect(parseGates(gatesText(g))).toEqual(g);
    expect(gatesText(undefined)).toBe('');
  });
});
