import { Terminal, Workflow } from 'lucide-react';
import { createElement } from 'react';
import { call } from '../api';
import { toastError, useApp, type CiRequest } from '../store';
import { copyText } from './clipboard';
import { LABEL } from './vocabulary';
import type { MenuItem } from '../components/ui';

interface RunCi {
  request: CiRequest & { grep?: string; tags?: string[] };
  command: string;
  note?: string;
}

/**
 * WF-09 Run → CI in one click: a finished run as a pipeline (the Run in CI dialog preselected with its files or
 * collection, folders and environment) or as the `testpion` command that runs it on this computer. The backend's
 * `runs.ci` (core `ciTargetOfRun`) decides what the run was, so `testpion ci --run` and the `ci_config` tool's
 * `runId` agree. `runId` 'last' is the latest run.
 */
export async function runInCi(runId: string): Promise<void> {
  try {
    const r = await call<RunCi>('runs.ci', { runId });
    if (r.note) useApp.getState().toast(r.note, 'info');
    useApp.getState().set({ ci: r.request });
  } catch (e) {
    toastError(e);
  }
}

/** Copy the command that runs `runId` again from a terminal (the same files or collection, filter and environment). */
export async function copyRunCommand(runId: string): Promise<string | undefined> {
  try {
    const r = await call<RunCi>('runs.ci', { runId });
    await copyText(r.command, 'the CLI command');
    return r.command;
  } catch (e) {
    toastError(e);
    return undefined;
  }
}

/** The run header's CI items (the run group of its ⋯ / right-click menu), the same in every run view. */
export function runCiMenuItems(runId: string): MenuItem[] {
  return [
    { label: LABEL.runInCi, icon: createElement(Workflow, { size: 14 }), onSelect: () => void runInCi(runId) },
    { label: LABEL.copyCliCommand, icon: createElement(Terminal, { size: 14 }), onSelect: () => void copyRunCommand(runId) },
  ];
}
