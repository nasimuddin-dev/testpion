import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { deletePolicy, KIND_INFO, KIND_IDS } from '@testpion/shared';

/**
 * One delete behaviour per kind, wherever the delete is asked for (UI audit 2026-10-21, I1 and the delete table): the
 * registry says how each kind is deleted (`undo`: at once, with Undo in the message; `confirm`: asked first, it cannot
 * be put back), and the window reaches every delete RPC through the two helpers of lib/undo-delete.ts that apply it.
 */
const SRC = join(__dirname, '../../apps/desktop/src');
const files = (dir: string): string[] => readdirSync(dir).flatMap((f) => (statSync(join(dir, f)).isDirectory() ? files(join(dir, f)) : /\.tsx?$/.test(f) ? [join(dir, f)] : []));

describe('the delete policy of every kind', () => {
  it('every kind that can be deleted says how (undo or confirm) and why; the others have no policy', () => {
    for (const id of KIND_IDS) {
      const k = KIND_INFO[id];
      if (k.capabilities.delete === true) {
        expect(k.deletes, `${id} can be deleted: it needs a delete policy`).toBeTruthy();
        expect(['undo', 'confirm']).toContain(k.deletes!.mode);
        expect(k.deletes!.reason.length, `${id}: "${k.deletes!.reason}" is not a reason`).toBeGreaterThanOrEqual(12);
      } else expect(k.deletes, `${id} has no delete, so no delete policy`).toBeUndefined();
    }
  });

  it('a kind kept in Recently deleted is undone, never confirmed', () => {
    for (const id of KIND_IDS) if (KIND_INFO[id].capabilities.trash === true) expect(deletePolicy(id).mode, id).toBe('undo');
  });

  it('deletePolicy says why a kind has no delete', () => {
    expect(deletePolicy('trace')).toEqual({ mode: 'none', reason: expect.stringMatching(/cleared from their own view/) });
    expect(deletePolicy('history').mode).toBe('confirm');
    expect(deletePolicy('environment').mode).toBe('undo');
  });
});

/**
 * The calls that delete or clear something; each must be reached through deleteWithUndo or confirmDelete (it sits in
 * one of their `run`s, or in a list op whose result such a helper's `run` returns), so the policy, the message, Undo and
 * the error toast are the same everywhere. The allow-list names the others, each with why it is not a delete of an item.
 */
const DELETE_CALL = /call(?:<[^>]*>)?\(\s*'([a-zA-Z]+(?:\.[a-zA-Z]+)*\.(?:delete\w*|clear\w*|deleteRule|deleteFilterPreset|deleteServer))'/g;
const ALLOW: Record<string, string> = {
  'views/TestsView.tsx:tests.delete:movePath': 'a rename or a move writes the file at its new path first, then removes the old one',
  'views/TestsView.tsx:tests.delete:renameFolder': 'a folder rename: the files are written at the new path first, then the old folder goes',
  'components/ConsolePanel.tsx:console.clear': 'the Console is a log of this session, cleared like a terminal',
  'components/AuthEditor.tsx:auth.clearTokens': 'forgets cached tokens: the next request gets new ones, nothing is lost',
  'components/rag/RagLabelControl.tsx:rag.label.clear': 'clicking a label again takes it back (a toggle), not a delete',
  'components/WorkspaceMenu.tsx:ws.delete': 'its own dialog asks for the workspace name and says whether the folder goes',
};

describe('every delete in the window goes through the one helper', () => {
  it('finds no delete or clear call outside deleteWithUndo / confirmDelete and the allow-list', () => {
    const found: string[] = [];
    const used = new Set<string>();
    for (const f of files(SRC)) {
      const rel = f.slice(SRC.length + 1).replace(/\\/g, '/');
      if (rel === 'lib/undo-delete.ts') continue;
      const text = readFileSync(f, 'utf8');
      for (const m of text.matchAll(DELETE_CALL)) {
        const before = text.slice(0, m.index);
        // the handler the call is in: the nearest `const name = async` (or `async function name`) above it
        const fn = [...before.matchAll(/(?:const (\w+) = async\b|async function (\w+))/g)].map((x) => x[1] ?? x[2]).at(-1);
        const keys = [`${rel}:${m[1]}`, ...(fn ? [`${rel}:${m[1]}:${fn}`] : [])];
        const allowed = keys.find((k) => k in ALLOW);
        if (allowed) {
          used.add(allowed);
          continue;
        }
        // inside a helper's run (or a list op handed to one): the helper is called in the 40 lines above, or the op is a FolderListOps delete
        const near = before.split('\n').slice(-40).join('\n');
        if (/\b(deleteWithUndo|confirmDelete|deleteMcpServerWithUndo|deleteRuleWithUndo)\(/.test(near) || /\bdelete(Item|Folder):\s*async/.test(near)) continue;
        found.push(`${keys[keys.length - 1]} (line ${before.split('\n').length})`);
      }
    }
    expect(found).toEqual([]);
    expect(Object.keys(ALLOW).filter((k) => !used.has(k))).toEqual([]);
  });
});
