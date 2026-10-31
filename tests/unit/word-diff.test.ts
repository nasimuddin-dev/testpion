import { describe, expect, it } from 'vitest';
import { wordDiff } from '../../packages/shared/src/word-diff.js';

const rebuild = (d: ReturnType<typeof wordDiff>, keep: 'add' | 'del') => d.segments.filter((s) => s.type === 'same' || s.type === keep).map((s) => s.text).join('');

describe('wordDiff', () => {
  it('says nothing changed for equal texts', () => {
    expect(wordDiff('Be brief.', 'Be brief.')).toMatchObject({ added: 0, removed: 0, text: 'No change.', segments: [{ type: 'same', text: 'Be brief.' }] });
  });
  it('finds the added and removed words, and both texts can be rebuilt from the segments', () => {
    const a = 'Summarise the review in one sentence.';
    const b = 'Summarise the customer review in two short sentences.';
    const d = wordDiff(a, b);
    expect(rebuild(d, 'add')).toBe(b);
    expect(rebuild(d, 'del')).toBe(a);
    expect(d.added).toBeGreaterThan(0);
    expect(d.text).toMatch(/^Added \d+ words?, removed \d+ words?\.$/);
    expect(d.segments.filter((s) => s.type === 'add').map((s) => s.text.trim())).toContain('customer');
  });
  it('speaks of words in the singular and of spacing', () => {
    expect(wordDiff('a b', 'a b c').text).toBe('Added 1 word.');
    expect(wordDiff('a b c', 'a b').text).toBe('Removed 1 word.');
    expect(wordDiff('a  b', 'a b').text).toBe('Only spacing changed.');
  });
  it('handles empty texts and very long ones quickly', () => {
    expect(wordDiff('', 'new').added).toBe(1);
    expect(wordDiff('old', '').removed).toBe(1);
    const long = Array.from({ length: 5000 }, (_, i) => `word${i}`).join(' ');
    const t = Date.now();
    const d = wordDiff(long + '\nline', long + '\nother line');
    expect(Date.now() - t).toBeLessThan(2000);
    expect(d.added + d.removed).toBeGreaterThan(0);
  });
});
