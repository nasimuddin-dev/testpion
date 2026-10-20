import type { ShareResult } from '@testpion/core';
import { call } from '../api';
import { confirmAction, toastError, useApp } from '../store';
import { plural } from './format';
import { toastWithUndo } from './git-items';

/**
 * Share session (release C of planning/git-everything.md §4f): a saved Debugger session is git-ignored; sharing it puts a
 * copy, masked once more with the redaction every export uses, in debugger/shared/, which git tracks. The preview says what
 * goes where and whether the masking found more to hide than the capture had; the toast has Undo.
 */
export async function shareDebuggerSession(name: string): Promise<boolean> {
  try {
    const plan = await call<ShareResult>('git.shareSession', { name, dryRun: true });
    const ok = await confirmAction({
      title: `Share session ${plan.name}`,
      message: `Copy ${plural(plan.entries, 'exchange')} to ${plan.to}?`,
      detail: [
        'The copy is tracked by git, so commit it to share it with your team. The saved session itself stays on this computer.',
        plan.masked ? 'Credentials the capture had not masked were hidden in the copy.' : 'Credentials are masked in the copy, as in every export.',
        plan.replaced ? 'A shared copy of this session exists: it is replaced.' : '',
      ]
        .filter(Boolean)
        .join('\n\n'),
      confirmLabel: 'Share',
    });
    if (!ok) return false;
    const r = await call<ShareResult>('git.shareSession', { name });
    toastWithUndo(`Shared ${r.name}: commit ${r.to} to send it to your team`, r.undoId);
    return true;
  } catch (e) {
    toastError(e);
    return false;
  }
}

/** Stop sharing: the tracked copy is deleted (the saved session stays). */
export async function unshareDebuggerSession(name: string): Promise<void> {
  try {
    const r = await call<{ removed: boolean }>('git.unshareSession', { name });
    useApp.getState().toast(r.removed ? `Stopped sharing ${name}: commit the removal` : `${name} is not shared`, 'info');
  } catch (e) {
    toastError(e);
  }
}
