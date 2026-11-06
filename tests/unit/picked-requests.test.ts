import { describe, expect, it } from 'vitest';
import { pickRequest } from '../../apps/desktop/src/lib/picked-requests.js';

// Several requests of one collection picked in the Collections tree: Ctrl/⌘+click toggles one, Shift+click picks a range
// from the last one toggled; picking in another collection starts over there.
const order = ['a', 'b', 'c', 'd', 'e'];

describe('picking requests in the tree', () => {
  it('toggles, in the order the tree shows them', () => {
    let p = pickRequest(undefined, 'shop', 'c', 'toggle', order);
    p = pickRequest(p, 'shop', 'a', 'toggle', order);
    expect(p).toEqual({ collectionId: 'shop', ids: ['a', 'c'], anchor: 'a' });
    p = pickRequest(p, 'shop', 'c', 'toggle', order);
    expect(p?.ids).toEqual(['a']);
    expect(pickRequest(p, 'shop', 'a', 'toggle', order)).toBeUndefined();
  });

  it('a Shift+click adds the range from the last one toggled, either way', () => {
    const p = pickRequest(undefined, 'shop', 'b', 'toggle', order);
    expect(pickRequest(p, 'shop', 'd', 'range', order)?.ids).toEqual(['b', 'c', 'd']);
    expect(pickRequest(p, 'shop', 'a', 'range', order)?.ids).toEqual(['a', 'b']);
    // the anchor stays, so a second Shift+click widens or moves the range from the same place
    expect(pickRequest(pickRequest(p, 'shop', 'd', 'range', order), 'shop', 'e', 'range', order)).toEqual({ collectionId: 'shop', ids: ['b', 'c', 'd', 'e'], anchor: 'b' });
  });

  it('another collection starts over; one picked that is hidden now (a closed folder, a filter) stays picked', () => {
    const p = pickRequest(undefined, 'shop', 'b', 'toggle', order);
    expect(pickRequest(p, 'users', 'x', 'toggle', ['x', 'y'])).toEqual({ collectionId: 'users', ids: ['x'], anchor: 'x' });
    // b's folder closed: only d and e are shown; picking d keeps b
    expect(pickRequest(p, 'shop', 'd', 'toggle', ['d', 'e'])?.ids).toEqual(['d', 'b']);
    expect(pickRequest(p, 'shop', 'z', 'range', order)?.ids).toEqual(['b', 'z']);
  });
});
