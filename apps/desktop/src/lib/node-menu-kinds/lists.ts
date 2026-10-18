import { ArchiveRestore, Bot, CheckCircle2, Copy, Download, ExternalLink, FileText, Pause, Pencil, Play, RotateCcw, Sparkles, Terminal, Workflow } from 'lucide-react';
import type { ActionDef } from '../node-menu-actions';
import { LABEL } from '../vocabulary';

/** The actions of the library views (monitors, load tests, evaluations, prompts), the Tests tree and the record lists. */
export const LIST_ACTIONS: readonly ActionDef[] = [
  // monitors
  { id: 'edit', group: 'open', label: LABEL.edit, icon: Pencil, kinds: ['monitor'] },
  { id: 'pause', group: 'run', label: LABEL.pause, icon: Pause, kinds: ['monitor'] },
  { id: 'resume', group: 'run', label: LABEL.resume, icon: Play, kinds: ['monitor'] },
  // test files and runs
  { id: 'runWithData', group: 'run', label: LABEL.runWithData, icon: Play, kinds: ['test'] },
  { id: 'runInEnvironments', group: 'run', label: LABEL.runInEnvironments, icon: Play, kinds: ['test'] },
  { id: 'rerunFailed', group: 'run', label: LABEL.rerunFailed, icon: RotateCcw, kinds: ['run'] },
  { id: 'copyCli', group: 'share', label: LABEL.copyCliCommand, icon: Terminal, kinds: ['test', 'run'] },
  { id: 'copyRunId', group: 'share', label: LABEL.copyRunId, icon: Copy, kinds: ['run'] },
  { id: 'exposeMcp', group: 'tools', label: LABEL.exposeMcp, icon: Bot, kinds: ['test'] },
  { id: 'exportArazzo', group: 'share', label: LABEL.exportArazzo, icon: Workflow, kinds: ['test'] },
  { id: 'triage', group: 'tools', label: LABEL.triageWithAi, icon: Sparkles, kinds: ['run'] },
  { id: 'exportReport', group: 'share', label: LABEL.exportReport, icon: Download, kinds: ['run'] },
  // history, traces, environments
  { id: 'openRequest', group: 'open', label: LABEL.openRequest, icon: ExternalLink, kinds: ['history'] },
  { id: 'openTrace', group: 'open', label: LABEL.openTrace, icon: FileText, kinds: ['history'] },
  { id: 'openRun', group: 'open', label: LABEL.openRun, icon: ExternalLink, kinds: ['trace'] },
  { id: 'makeActive', group: 'run', label: LABEL.makeActive, icon: CheckCircle2, kinds: ['environment'] },
  { id: 'recentlyDeleted', group: 'open', label: LABEL.recentlyDeleted, icon: ArchiveRestore, kinds: ['section:environment', 'section:collection'] },
];
