/**
 * The flow designer's run dock, under the canvas: the data runs and environment matrices of the file (ScaleRunPanel
 * with its grids) or the timeline of one run (RunTimeline: picking a bar selects that step on the canvas). The
 * components are the Tests view's own; the dock only places them beside the canvas.
 */
import { GanttChart, Layers, X } from 'lucide-react';
import { ScaleRunPanel } from './FlowScaleGrids';
import { RunTimeline } from './RunTimeline';
import { IconButton } from './ui';

/** What the dock shows: a data run / matrix (by id), or a run's timeline. */
export type FlowDock = { kind: 'scale'; id: string } | { kind: 'timeline'; runId: string };

export function FlowRunDock({ file, dock, onChange, onClose, onPickStep }: { file: string; dock: FlowDock; onChange(d: FlowDock): void; onClose(): void; onPickStep(id: string): void }) {
  return (
    <div className="h-full flex flex-col min-h-0 border-t border-line" data-flow-dock={dock.kind}>
      <div className="flex items-center gap-2 px-3 h-8 border-b border-line shrink-0 text-xs">
        {dock.kind === 'scale' ? <Layers size={13} className="text-muted" /> : <GanttChart size={13} className="text-muted" />}
        <span className="font-medium flex-1 truncate">
          {dock.kind === 'scale' ? (
            'Data runs and environment matrices of this flow'
          ) : (
            <>
              Timeline of run <span className="mono">{dock.runId}</span>: click a bar to select its step
            </>
          )}
        </span>
        <IconButton label="Close the dock" className="h-6 w-6" onClick={onClose}>
          <X size={13} />
        </IconButton>
      </div>
      <div className="flex-1 min-h-0">
        {dock.kind === 'scale' ? (
          <ScaleRunPanel file={file} id={dock.id} onSelect={(id) => onChange({ kind: 'scale', id })} />
        ) : (
          <div className="h-full overflow-auto">
            <RunTimeline key={dock.runId} runId={dock.runId} file={file} onPickStep={(_name, id) => onPickStep(id)} />
          </div>
        )}
      </div>
    </div>
  );
}
