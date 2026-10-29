import { describe, expect, it } from 'vitest';
import { sameData } from '../../apps/desktop/src/lib/same-data';

describe('sameData: an item in its stable order and a draft in the editor order are the same data', () => {
  it('ignores the order of object keys at every level, not the order of lists', () => {
    expect(sameData({ a: 1, b: { x: 1, y: [1, 2] } }, { b: { y: [1, 2], x: 1 }, a: 1 })).toBe(true);
    expect(sameData({ a: [1, 2] }, { a: [2, 1] })).toBe(false);
    expect(sameData({ a: 1 }, { a: 2 })).toBe(false);
    // a value that is not there is not a difference (undefined is not written)
    expect(sameData({ a: 1, b: undefined }, { a: 1 })).toBe(true);
  });
});
