import { useEffect, useState } from 'react';
import { call, on } from '../api';
import { runMenuCommand } from '../menu-commands';
import { toastError, useApp } from '../store';
import { Button, Callout } from './ui';

/**
 * Home's card when the workspace that was open last time could not be opened at the start (a damaged or newer workspace.json, an
 * unmounted drive): the reason the engine gave, and the two ways on. It was a toast that was gone in seconds, with an empty window left.
 */
export function StartupProblem() {
  const open = useApp((s) => s.workspace?.id);
  const [problem, setProblem] = useState<{ path?: string; message: string } | null>(null);
  const [retrying, setRetrying] = useState(false);
  useEffect(() => {
    let alive = true;
    const read = () =>
      void call<{ path?: string; message: string } | null>('ws.openProblem').then(
        (p) => alive && setProblem(p),
        () => undefined,
      );
    read();
    const off = on('workspace.problem', read);
    return () => {
      alive = false;
      off();
    };
  }, [open]);
  if (!problem || open) return null;
  const retry = async () => {
    setRetrying(true);
    try {
      await call('ws.open', { ref: problem.path });
      await useApp.getState().refreshWorkspace();
    } catch (e) {
      toastError(e);
    } finally {
      setRetrying(false);
    }
  };
  return (
    <Callout tone="bad" block as="section" className="rounded-2xl px-5 py-4 grid gap-2" aria-label="The last workspace could not be opened" data-startup-problem="1">
      <p className="font-medium">The workspace from last time could not be opened</p>
      <p className="text-sm break-words">{problem.message}</p>
      <div className="flex gap-2 flex-wrap">
        {problem.path && (
          <Button size="sm" variant="primary" loading={retrying} onClick={() => void retry()}>
            Retry
          </Button>
        )}
        <Button size="sm" onClick={() => void runMenuCommand('open-workspace')}>
          Open another…
        </Button>
      </div>
    </Callout>
  );
}
