import { describe, expect, it } from 'vitest';
import { DEFAULT_FOLDER, folderNamesOf, folderOf, groupByFolder, keptFolders, storedFolder } from '../../apps/desktop/src/lib/folders';
import { LABEL } from '../../apps/desktop/src/lib/vocabulary';

/** Every list of saved items keeps its items in folders: the ones with none are in General (a view, never stored). */
describe('groupByFolder', () => {
  const items = [
    { id: 'a', folder: undefined },
    { id: 'b', folder: 'Zeta' },
    { id: 'c', folder: 'Alpha' },
    { id: 'd', folder: 'General' },
    { id: 'e', folder: '' },
  ];

  it('is called General, from the vocabulary', () => {
    expect(DEFAULT_FOLDER).toBe('General');
    expect(LABEL.defaultFolder).toBe(DEFAULT_FOLDER);
  });

  it('puts the loose items in General, first, and a stored General merges into it', () => {
    const { names, byFolder } = groupByFolder(items, []);
    expect(names[0]).toBe('General');
    expect(byFolder.get('General')!.map((i) => i.id)).toEqual(['a', 'd', 'e']);
  });

  it('sorts the other folders, kept empty ones included', () => {
    const { names, byFolder } = groupByFolder(items, ['Middle', 'Alpha']);
    expect(names).toEqual(['General', 'Alpha', 'Middle', 'Zeta']);
    expect(byFolder.get('Middle')).toEqual([]);
    expect(byFolder.get('Alpha')!.map((i) => i.id)).toEqual(['c']);
  });

  it('leaves nothing at the top level: every item is in exactly one folder', () => {
    const { byFolder } = groupByFolder(items, ['Kept']);
    const all = [...byFolder.values()].flat().map((i) => i.id);
    expect(all.sort()).toEqual(['a', 'b', 'c', 'd', 'e']);
  });

  it('has General even when the list is empty, and never lists it twice', () => {
    expect(groupByFolder([], []).names).toEqual(['General']);
    expect(groupByFolder([], ['General', 'X', 'General']).names).toEqual(['General', 'X']);
    expect(folderNamesOf(['General'], [{ folder: 'General' }])).toEqual(['General']);
  });

  it('keeps the stored data as it is: General is shown, stored as no folder', () => {
    expect(folderOf(undefined)).toBe('General');
    expect(folderOf('Mine')).toBe('Mine');
    expect(storedFolder('General')).toBeUndefined();
    expect(storedFolder(undefined)).toBeUndefined();
    expect(storedFolder('Mine')).toBe('Mine');
    expect(keptFolders(['General', 'Mine'])).toEqual(['Mine']);
    const loose = { id: 'x' } as { id: string; folder?: string };
    groupByFolder([loose], []);
    expect('folder' in loose).toBe(false);
  });
});
