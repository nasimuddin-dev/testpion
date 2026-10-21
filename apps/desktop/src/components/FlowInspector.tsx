import { AlignCenterVertical, AlignHorizontalSpaceAround, AlignStartHorizontal, AlignStartVertical, Bug, ClipboardPaste, Copy, CopyPlus, FileCode2, Frame, GanttChart, History, StepForward, Trash2 } from 'lucide-react';
import type { FlowGroup, FlowStep } from '@testpion/shared';
import type { TestResult } from '../types';
import { FlowOutputEditor } from './FlowBlockFields';
import type { DesignerFlow } from './FlowDesigner';
import { debugItems, type DesignerActions } from './FlowDesignerMenus';
import { PausePanel, VariablesTimeline, type FlowPause } from './FlowDebugParts';
import type { FlowSelection } from './FlowDiagram';
import { StepInspector } from './FlowDesignerParts';
import { getCopied, newGroup } from './flow-designer-lib';
import { ResultDetail } from './RunPanel';
import { Button, LinkButton, Menu, SectionTitle, Segmented } from './ui';

/**
 * The panel beside the canvas (FlowDesigner): the paused run's variables, a run shown from the history (the selected step's
 * result and the variables over the steps), and the editor of the selected step; with several steps selected their actions
 * (duplicate, copy, group, frame, align); with none, what the canvas does and the flow's output.
 */
export function FlowInspector({
  file,
  flow,
  sel,
  selSteps,
  one,
  version,
  mode,
  onMode,
  pause,
  onResume,
  viewRun,
  viewedResult,
  lastRunId,
  edgeCount,
  actions,
  update,
  onRunStep,
  onOpenStep,
  onDuplicate,
  onRemove,
  onGroup,
  onFrame,
  onArrange,
  onPaste,
  onSetOutput,
  onSelect,
  onTimeline,
}: {
  file: string;
  flow: DesignerFlow;
  sel: FlowSelection;
  selSteps: string[];
  /** The one step selected. */
  one: FlowStep | undefined;
  /** Bumped by undo and redo: the fields take the restored values. */
  version: number;
  mode: 'result' | 'step';
  onMode(m: 'result' | 'step'): void;
  pause: FlowPause | undefined;
  onResume(action: 'continue' | 'step' | 'stop', vars: Record<string, unknown>): void;
  /** A past run shown on the canvas. */
  viewRun: { runId: string; results: TestResult[] } | undefined;
  /** That run's result of the selected step. */
  viewedResult: TestResult | undefined;
  /** The run whose result the step's last response is read from. */
  lastRunId: string | undefined;
  /** Connections in the flow. */
  edgeCount: number;
  actions: DesignerActions;
  update(id: string, set: Record<string, unknown>): Promise<unknown>;
  onRunStep(id: string): void;
  onOpenStep(step: FlowStep): void;
  onDuplicate(ids: string | string[]): void;
  onRemove(): void;
  onGroup(ids: string[], g: Pick<FlowGroup, 'kind' | 'name'> | { kind: 'parallel'; name: null }): void;
  onFrame(): void;
  onArrange(how: 'left' | 'top' | 'center' | 'distribute'): void;
  onPaste(): void;
  onSetOutput(output: Record<string, string> | null): Promise<unknown>;
  onSelect(s: FlowSelection): void;
  onTimeline(runId: string): void;
}) {
  const timelineIndex = viewRun ? Math.max(0, one ? viewRun.results.findIndex((r) => r.id === one.id) : viewRun.results.length - 1) : 0;
  const copied = getCopied();
  return (
    <div className="h-full overflow-auto text-sm" data-flow-inspector>
      {pause && <PausePanel key={`${pause.runId}:${pause.stepId}`} pause={pause} stepName={flow.steps.find((s) => s.id === pause.stepId)?.name ?? pause.stepId} onResume={onResume} />}
      {viewRun && (
        <div className="grid gap-3 p-3 border-b border-line" data-flow-run-view={viewRun.runId}>
          <div className="flex items-center gap-2 text-xs">
            <History size={13} className="text-muted shrink-0" />
            <span className="flex-1 truncate">
              Run <span className="mono">{viewRun.runId}</span>
            </span>
            <LinkButton icon={<GanttChart size={12} />} onClick={() => onTimeline(viewRun.runId)} data-flow-timeline-open>
              Timeline
            </LinkButton>
            {one && (
              <Segmented
                label="Inspector"
                value={mode}
                onChange={onMode}
                options={[
                  { value: 'result', label: 'Run result' },
                  { value: 'step', label: 'Edit step' },
                ]}
              />
            )}
          </div>
          {(!one || mode === 'result') && (
            <>
              {one &&
                (viewedResult ? (
                  <div className="h-[380px] border border-line rounded-md overflow-hidden" data-flow-run-result={one.id}>
                    <ResultDetail r={viewedResult} runId={viewRun.runId} initialTab="io" />
                  </div>
                ) : (
                  <p className="text-xs text-muted">&quot;{one.name}&quot; did not run in this run.</p>
                ))}
              <VariablesTimeline results={viewRun.results} index={timelineIndex} onIndex={(i) => onSelect({ steps: [viewRun.results[i]!.id] })} />
            </>
          )}
        </div>
      )}
      {(!viewRun || !one || mode === 'step') &&
        (one ? (
          <StepInspector
            key={`${one.id}:${version}`}
            file={file}
            step={one}
            raw={flow.raw?.[one.id]}
            inheritedAuth={flow.inheritedAuth?.[one.id]}
            steps={flow.steps}
            lastRunId={lastRunId}
            update={(set) => update(one.id, set)}
            actions={
              <>
                <Button size="sm" icon={<StepForward size={12} />} onClick={() => onRunStep(one.id)}>
                  Run step
                </Button>
                <Menu
                  align="start"
                  width={230}
                  items={debugItems(actions, one)}
                  trigger={
                    <Button size="sm" icon={<Bug size={12} />} data-inspector-debug-menu title="Run from here, run to here, breakpoint, pin the response">
                      Debug
                    </Button>
                  }
                />
                <Button size="sm" icon={<FileCode2 size={12} />} onClick={() => onOpenStep(one)} title="Show the step in the YAML editor">
                  Open in editor
                </Button>
                <Button size="sm" icon={<CopyPlus size={12} />} onClick={() => onDuplicate(one.id)} title="Ctrl+D">
                  Duplicate
                </Button>
                <Button size="sm" variant="danger" icon={<Trash2 size={12} />} onClick={onRemove} title="Delete">
                  Delete step
                </Button>
              </>
            }
          />
        ) : selSteps.length > 1 ? (
          <div className="p-3 grid gap-3">
            <SectionTitle>{selSteps.length} steps selected</SectionTitle>
            <div className="flex flex-wrap gap-1.5">
              <Button size="sm" icon={<CopyPlus size={12} />} onClick={() => onDuplicate(selSteps)}>
                Duplicate
              </Button>
              <Button size="sm" icon={<Copy size={12} />} onClick={() => actions.copy(selSteps)}>
                Copy
              </Button>
              <Button size="sm" variant="danger" icon={<Trash2 size={12} />} onClick={onRemove}>
                Delete steps
              </Button>
            </div>
            <div className="flex flex-wrap gap-1.5" data-flow-group-actions>
              <Button
                size="sm"
                data-flow-make-parallel
                onClick={() => onGroup(selSteps, { kind: 'parallel', name: flow.steps.find((s) => selSteps.includes(s.id) && s.parallel)?.parallel ?? newGroup(flow.steps) })}
                title="Put the selected steps in one parallel group: they may run at the same time (what they wait for still applies)"
              >
                Run together (parallel group)
              </Button>
              <Button size="sm" onClick={() => onGroup(selSteps, { kind: 'parallel', name: null })} disabled={!flow.steps.some((s) => selSteps.includes(s.id) && s.parallel)}>
                Leave the group
              </Button>
              <Button size="sm" onClick={() => onGroup(selSteps, { kind: 'finally', name: 'finally' })} title="Clean-up: run these steps after every other step, whatever happened">
                Make finally
              </Button>
            </div>
            <div className="flex flex-wrap gap-1.5" data-flow-arrange-actions>
              <Button size="sm" icon={<Frame size={12} />} onClick={onFrame} data-flow-frame-selection title="A coloured frame with a title around the selected steps (only on the canvas)">
                Frame selection
              </Button>
              <Button size="sm" icon={<AlignStartVertical size={12} />} onClick={() => onArrange('left')} data-flow-align="left" title="Line the left edges up">
                Align left
              </Button>
              <Button size="sm" icon={<AlignStartHorizontal size={12} />} onClick={() => onArrange('top')} data-flow-align="top" title="Line the top edges up">
                Align top
              </Button>
              <Button size="sm" icon={<AlignCenterVertical size={12} />} onClick={() => onArrange('center')} data-flow-align="center" title="Line the centres up (one above the other)">
                Align centres
              </Button>
              <Button size="sm" icon={<AlignHorizontalSpaceAround size={12} />} onClick={() => onArrange('distribute')} disabled={selSteps.length < 3} data-flow-align="distribute" title="Space three or more steps evenly">
                Distribute
              </Button>
            </div>
          </div>
        ) : (
          <div className="p-3 grid gap-2 text-xs text-muted">
            <SectionTitle>Flow</SectionTitle>
            <p>
              {flow.steps.length} step{flow.steps.length === 1 ? '' : 's'}, {edgeCount} connection{edgeCount === 1 ? '' : 's'}.{' '}
              {sel.edge ? (
                <>
                  <b className="text-fg">{sel.edge.to}</b> waits for <b className="text-fg">{sel.edge.from}</b>: Delete removes the connection.
                </>
              ) : (
                'Select a step to edit it.'
              )}
            </p>
            <ul className="list-disc ml-4 grid gap-1">
              <li>Drag the dot on a step's right edge onto another step: that step then waits for it and can use what it extracts.</li>
              <li>A condition has a true and a false dot: the step you drop it on runs only on that branch; the other branch shows as skipped after a run.</li>
              <li>Drag steps to arrange them; Shift+click selects several; Delete removes the selection; Ctrl+Z undoes.</li>
              <li>Ctrl+C / Ctrl+V copy steps between flows; Ctrl+D duplicates.</li>
              <li>
                Steps that wait for nothing run side by side. A <b className="text-accent">parallel</b> frame marks steps that may run together: drop a step into it to add it, drag its label to
                move it. The <b className="text-warn">Finally</b> lane runs last, whatever happened.
              </li>
              <li>
                A <span className="text-warn font-bold">!</span> marks a step that reads a variable no earlier step extracts and the environment does not define; the problems under the canvas
                list it and other mistakes (steps that never run, cycles): click one to select its step.
              </li>
              <li>Double-click empty canvas for a sticky note; select steps and Frame selection to group them in a coloured frame. Hover a step for its last response.</li>
              <li>Ctrl+F finds steps; Ctrl+K lists the canvas's actions first; dragged steps line up with others (Snap puts them on a grid).</li>
            </ul>
            {copied && (
              <LinkButton icon={<ClipboardPaste size={12} />} onClick={onPaste}>
                Paste {copied.ids.length} copied step{copied.ids.length === 1 ? '' : 's'}
              </LinkButton>
            )}
            <FlowOutputEditor key={`output:${version}`} output={flow.output} update={onSetOutput} />
          </div>
        ))}
    </div>
  );
}
