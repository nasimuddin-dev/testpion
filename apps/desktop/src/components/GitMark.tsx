import { gitFolderKey, gitRefKey, gitSectionKey, type ItemRef, type KindId } from '@testpion/shared';
import { useGitMarkInfo } from '../lib/git';
import { ChangeMark } from './ChangeMark';

/**
 * What a row's change mark is about: an item (its ItemRef), a folder of a kind's list, or a kind's section header. The
 * one thing a row says to get its mark; `<TreeRowShell git={…}>` draws it (planning/git-everything.md §4c).
 */
export type GitTarget = ItemRef | { folder: KindId; name: string } | { section: KindId };

const gitKeyOfTarget = (t: GitTarget): string => ('section' in t ? gitSectionKey(t.section) : 'folder' in t ? gitFolderKey(t.folder, t.name) : gitRefKey(t));

/** The change mark of a row: A / M / D / R for an item, the number of changes inside for a folder or a section; nothing when unchanged. */
export function GitMark({ to }: { to: GitTarget }) {
  const info = useGitMarkInfo(gitKeyOfTarget(to));
  return info ? <ChangeMark change={info.change} count={info.count} /> : null;
}
