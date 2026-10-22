import { Button, Modal } from './ui';
import type { SaveConflictRequest } from '../lib/save-conflict';

/** The choice when a save would overwrite what someone else changed on disk (lib/save-conflict.ts). Nothing is saved until one is chosen. */
export function SaveConflictDialog({ request }: { request: SaveConflictRequest }) {
  const { what, canKeepBoth, resolve } = request;
  return (
    <Modal
      title="Changed on disk"
      onClose={() => resolve('cancel')}
      onSubmit={canKeepBoth ? () => resolve('both') : undefined}
      width={520}
      footer={
        <>
          <Button onClick={() => resolve('cancel')}>Cancel</Button>
          <Button data-testid="conflict-theirs" onClick={() => resolve('theirs')}>
            Take theirs
          </Button>
          <Button data-testid="conflict-mine" onClick={() => resolve('mine')}>
            Keep mine
          </Button>
          {canKeepBoth && (
            <Button variant="primary" data-testid="conflict-both" onClick={() => resolve('both')}>
              Open both
            </Button>
          )}
        </>
      }
    >
      <div className="flex flex-col gap-2 text-sm">
        <p>
          <b>{what}</b> was changed outside this window since you opened it (a git pull, another window, the command line). Saving now would replace those changes.
        </p>
        <ul className="list-disc pl-5 text-muted">
          <li>
            <b>Take theirs</b>: show the version on disk and drop your edit.
          </li>
          <li>
            <b>Keep mine</b>: save your version over the one on disk.
          </li>
          {canKeepBoth && (
            <li>
              <b>Open both</b>: save your version as a copy named "(my changes)" and show the one on disk.
            </li>
          )}
        </ul>
      </div>
    </Modal>
  );
}
