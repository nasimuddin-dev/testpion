import { describe, expect, it } from 'vitest';
import { followChanges, type FollowedItem } from '../../apps/desktop/src/lib/follow-changes';

// WF-15: open editors follow their item's file. A clean editor takes the new version; one with edits asks once
// (Keep mine / Take the new version); unchanged, unsaved, gone or closed items are left alone.
function editor(items: FollowedItem[], disk: Record<string, string>) {
  const log: string[] = [];
  let open = items;
  return {
    log,
    close: (key: string) => (open = open.filter((i) => i.key !== key)),
    o: {
      items: () => open,
      read: async (keys: string[]) => new Map(keys.filter((k) => k in disk).map((k) => [k, { snapshot: disk[k]!, value: disk[k]! }])),
      take: (key: string, value: string) => void log.push(`take ${key}=${value}`),
      keep: (key: string, snapshot: string) => void log.push(`keep ${key}=${snapshot}`),
    },
  };
}

describe('followChanges', () => {
  it('takes the new version silently without edits, asks with edits, leaves the rest', async () => {
    const e = editor(
      [
        { key: 'clean', label: 'Clean', base: 'v1', dirty: false },
        { key: 'edited', label: 'Edited', base: 'v1', dirty: true },
        { key: 'same', label: 'Same', base: 'v1', dirty: true },
        { key: 'unsaved', label: 'New', base: undefined, dirty: true },
        { key: 'gone', label: 'Gone', base: 'v1', dirty: false },
      ],
      { clean: 'v2', edited: 'v2', same: 'v1', unsaved: 'v9' },
    );
    const asked: string[] = [];
    await followChanges(e.o, async (label) => (asked.push(label), 'theirs'));
    expect(asked).toEqual(['Edited']);
    expect(e.log).toEqual(['take clean=v2', 'take edited=v2']);
  });

  it('Keep mine makes the new version the base', async () => {
    const e = editor([{ key: 'a', label: 'A', base: 'v1', dirty: true }], { a: 'v2' });
    await followChanges(e.o, async () => 'mine');
    expect(e.log).toEqual(['keep a=v2']);
  });

  it('an item closed while its version was read is left alone', async () => {
    const e = editor([{ key: 'a', label: 'A', base: 'v1', dirty: false }], { a: 'v2' });
    const read = e.o.read;
    e.o.read = async (k) => (e.close('a'), read(k));
    await followChanges(e.o, async () => 'theirs');
    expect(e.log).toEqual([]);
  });

  it('two changes of the same item at once ask once; questions never overlap', async () => {
    let open = 0;
    let most = 0;
    const decide = async () => {
      most = Math.max(most, ++open);
      await new Promise((r) => setTimeout(r, 20));
      open--;
      return 'theirs' as const;
    };
    const a = editor([{ key: 'x', label: 'X', base: 'v1', dirty: true }], { x: 'v2' });
    const b = editor([{ key: 'y', label: 'Y', base: 'v1', dirty: true }], { y: 'v2' });
    const asked: string[] = [];
    const counting = async (l: string) => (asked.push(l), decide());
    await Promise.all([followChanges(a.o, counting), followChanges(a.o, counting), followChanges(b.o, counting)]);
    expect(asked.sort()).toEqual(['X', 'Y']);
    expect(most).toBe(1);
  });
});
