/**
 * A step drawn on the flow canvas (FlowDiagram): its box, kind, request line, result, marks (breakpoint, pin, paused,
 * a search match, a problem) and, in the designer, its ports. Memoised: a node re-renders only when its own data does.
 */
import { memo } from 'react';
import { stepDetail, untilLabel, type FlowEdge, type flowGraph, type FlowStep } from '@testpion/shared';
import { fitText, textWidth, type TextFont } from '../lib/fit-text';
import { STATUS_STROKE } from './FlowCanvasParts';
import type { FlowMark } from './FlowDiagram';
import { TEST_KINDS } from './TreeParts';
import { cx } from './ui';

/** The + that shows beside an output port while the step is hovered: add a block after it. */
function PortAdd({ x, y, onClick }: { x: number; y: number; onClick(at: { x: number; y: number }): void }) {
  return (
    <g
      data-flow-port-add
      className="opacity-0 group-hover:opacity-100 transition-opacity cursor-pointer"
      onClick={(e) => {
        e.stopPropagation();
        onClick({ x: e.clientX, y: e.clientY });
      }}
    >
      <title>Add a block here</title>
      <circle cx={x} cy={y} r={8} className="fill-panel stroke-accent" strokeWidth={1.25} />
      <path d={`M ${x - 4} ${y} H ${x + 4} M ${x} ${y - 4} V ${y + 4}`} className="stroke-accent" strokeWidth={1.5} />
    </g>
  );
}

const STATUS_FILL: Record<string, string> = { passed: 'fill-ok', failed: 'fill-bad', error: 'fill-bad', skipped: 'fill-muted', running: 'fill-accent' };
// the fonts of the node's texts (as their classes draw them): every text is fitted to the room it has in the box
const F_NAME: TextFont = { size: 13, weight: 500 };
const F_LINE: TextFont = { size: 11, mono: true };
const F_LINE_BOLD: TextFont = { size: 11, mono: true, weight: 700 };
const F_SMALL: TextFont = { size: 11 };
const F_LOOP: TextFont = { size: 11, weight: 600 };
const F_COMPACT: TextFont = { size: 22, weight: 500 };
const F_EDGE: TextFont = { size: 10, mono: true };
/** Room kept free at a box's right edge (its border, a port). */
const PAD = 10;
/** A condition's true port is in the upper part of its right edge, its false port in the lower part. */
export const portY = (h: number, when: boolean) => (when ? h * 0.32 : h * 0.72);

/** A step on the canvas; memoised (see useStable): dragging one node or hovering re-renders that node, not all 500. */
export const FlowNodeView = memo(FlowNodeViewImpl);

function FlowNodeViewImpl({
  node: n,
  selected,
  editable,
  onClick,
  onOpen,
  onSelect,
  onOpenResult,
  mark,
  onMenu,
  match,
  problem,
  onHover,
  onPortAdd,
  compact,
  tiny,
}: {
  /** Bumped when the web fonts finish loading: the texts are fitted again with the real widths. */
  fonts?: number;
  node: ReturnType<typeof flowGraph>['nodes'][number];
  selected: boolean;
  editable?: boolean;
  onClick(s: FlowStep, e: React.MouseEvent): void;
  onOpen?(s: FlowStep): void;
  onSelect?(s: FlowStep): void;
  onOpenResult?(s: FlowStep): void;
  mark?: FlowMark;
  onMenu?(s: FlowStep, at: { x: number; y: number }): void;
  /** A match of the canvas search (the current one is drawn stronger). */
  match?: 'match' | 'current';
  /** The worst check on the step (other than an unset variable, marked with its own !). */
  problem?: 'error' | 'warning';
  onHover?(id: string | undefined): void;
  /** The + beside an output port: add a block after this step (on that branch of a condition). */
  onPortAdd?(from: string, when: boolean | undefined, at: { x: number; y: number }): void;
  /** Drawn small (the canvas is zoomed far out): only the box, the status and the name. */
  compact?: boolean;
  /** So far out that the name would be under 4.5 px on screen (unreadable): not drawn at all (and not painted on every frame of a drag). */
  tiny?: boolean;
}) {
  const s = n.step;
  const kind = TEST_KINDS[s.type] ?? [s.type.toUpperCase().slice(0, 4), 'text-muted'];
  // the kind badge already says IF / LOG: the expression and the message stand alone
  const where =
    s.method && s.url ? s.url : s.type === 'condition' ? (s.if ?? '') : s.type === 'log' ? (s.message ?? '') : ['delay', 'flow', 'set', 'assert'].includes(s.type) ? stepDetail(s) : (s.url ?? '');
  const until = untilLabel(s);
  const condition = s.type === 'condition';
  const missingVars = s.unresolved?.length ? s.unresolved : undefined;
  // the marks at the right of the first line (a problem, an unset variable) and the loop label take their room from the name
  const marksRoom = (problem ? 18 : 0) + (missingVars ? 18 : 0);
  const loop = s.loop ? fitText(s.loop, 64, F_LOOP) : '';
  const result =
    s.status && s.status !== 'running'
      ? `${mark?.pinned && s.status === 'passed' ? 'pinned · ' : ''}${s.status}${s.durationMs !== undefined && !(mark?.pinned && s.status === 'passed') ? ` · ${s.durationMs} ms` : ''}`
      : s.status === 'running'
        ? 'running…'
        : undefined;
  // the third line: what it waits for (or extracts, its if, its until) on the left, the result on the right
  const resultRight = n.w - (condition && editable ? 44 : PAD);
  const resultText = result ? fitText(result, (n.w - 24) * 0.55, F_SMALL) : '';
  const thirdRoom = (resultText ? resultRight - textWidth(resultText, F_SMALL) - 8 : n.w - PAD) - 12;
  // the node's own attributes, the same drawn full or compact (tests and the canvas read data-flow-node, data-status …)
  const gProps: React.SVGProps<SVGGElement> & Record<`data-${string}`, unknown> = {
    'data-flow-node': s.id,
    'data-status': s.status,
    'data-selected': selected || undefined,
    'data-breakpoint': mark?.breakpoint || undefined,
    'data-pinned': mark?.pinned || undefined,
    'data-paused': mark?.paused || undefined,
    'data-flow-match': match,
    'data-flow-problem': problem,
    onPointerEnter: onHover ? () => onHover(s.id) : undefined,
    onPointerLeave: onHover ? () => onHover(undefined) : undefined,
    transform: `translate(${n.x} ${n.y})`,
    // the keyboard focus shows as a ring (drawn below: an SVG group has no outline of its own)
    className: cx('group outline-none', editable ? 'cursor-move' : 'cursor-pointer'),
    role: 'button',
    tabIndex: 0,
    'aria-label': s.name,
    'aria-pressed': editable ? selected : undefined,
    onClick: (e) => onClick(s, e),
    onDoubleClick: () => onOpen?.(s),
    onKeyDown: (e) => {
      if (e.key !== 'Enter') return;
      // handled here: the editor the step opens must not also get the Enter (a newline in the YAML)
      e.preventDefault();
      e.stopPropagation();
      if (editable) onOpen?.(s);
      else onSelect?.(s);
    },
    onContextMenu: onMenu
      ? (e) => {
          e.preventDefault();
          e.stopPropagation();
          onMenu(s, { x: e.clientX, y: e.clientY });
        }
      : undefined,
  };
  if (compact)
    // far out (a big flow fitted in the pane): the box, the status and the name; ports and details are too small to use
    return (
      <g {...gProps}>
        <title>{s.name}</title>
        <rect
          width={n.w}
          height={n.h}
          rx={8}
          className={cx('fill-panel', s.status ? (STATUS_STROKE[s.status] ?? 'stroke-line-strong') : 'stroke-line-strong', selected && 'stroke-accent')}
          strokeWidth={selected ? 4 : 2}
        />
        {match && <rect x={-6} y={-6} width={n.w + 12} height={n.h + 12} rx={12} className="fill-warn/25 stroke-warn pointer-events-none" strokeWidth={3} />}
        {mark?.paused && <rect x={-8} y={-8} width={n.w + 16} height={n.h + 16} rx={13} className="fill-none stroke-accent" strokeWidth={5} strokeDasharray="12 8" data-flow-paused-ring />}
        <FocusRing w={n.w} h={n.h} width={5} />
        {s.status && <circle cx={18} cy={n.h / 2} r={8} className={STATUS_FILL[s.status] ?? 'fill-muted'} />}
        {!tiny && (
          <text x={s.status ? 34 : 14} y={n.h / 2 + 8} className="fill-fg text-[22px] font-medium">
            {fitText(s.name, n.w - (s.status ? 34 : 14) - PAD - (problem ? 36 : 0) - (missingVars ? 36 : 0), F_COMPACT)}
          </text>
        )}
        {/* the marks, drawn big enough to read far out: a breakpoint, a pinned response, a problem, a variable nothing sets */}
        {mark?.breakpoint && <circle cx={0} cy={0} r={13} className="fill-bad stroke-panel" strokeWidth={3} data-flow-breakpoint-dot />}
        {mark?.pinned && (
          <g transform={`translate(${mark?.breakpoint ? 18 : 10} -16)`} data-flow-pin>
            <rect width={70} height={28} rx={14} className="fill-warn" />
            <text x={35} y={20} textAnchor="middle" className="fill-bg text-[18px] font-bold">
              PIN
            </text>
          </g>
        )}
        {problem && (
          <g transform={`translate(${n.w - (missingVars ? 56 : 22)} 22)`} data-flow-problem-mark={problem}>
            <circle r={14} className={problem === 'error' ? 'fill-bad' : 'fill-warn'} />
            <text y={7} textAnchor="middle" className="fill-bg text-[20px] font-bold">
              ×
            </text>
          </g>
        )}
        {missingVars && (
          <g transform={`translate(${n.w - 22} 22)`} data-flow-unresolved={missingVars.join(',')}>
            <circle r={14} className="fill-warn" />
            <text y={7} textAnchor="middle" className="fill-bg text-[20px] font-bold">
              !
            </text>
          </g>
        )}
        {/* the ports stay usable: big enough to grab at this zoom */}
        {editable && (
          <>
            <circle data-flow-port="in" cx={0} cy={n.h / 2} r={10} className="fill-panel stroke-line-strong" strokeWidth={3} />
            {condition ? (
              ([true, false] as const).map((w) => (
                <circle key={String(w)} data-flow-port="out" data-flow-when={String(w)} cx={n.w} cy={portY(n.h, w)} r={12} className={cx('stroke-panel cursor-crosshair', w ? 'fill-ok' : 'fill-bad')} strokeWidth={3} />
              ))
            ) : (
              <circle data-flow-port="out" cx={n.w} cy={n.h / 2} r={12} className="fill-accent stroke-panel cursor-crosshair" strokeWidth={3} />
            )}
          </>
        )}
      </g>
    );
  return (
    <g {...gProps}>
      <title>
        {[
          s.name,
          s.method && s.url ? `${s.method} ${s.url}` : s.type === 'delay' && s.ms !== undefined ? `waits ${s.ms} ms` : stepDetail(s),
          !condition && s.if ? `runs only if ${s.if}` : '',
          s.when !== undefined ? `on the ${s.when} branch of ${s.dependsOn?.join(', ') ?? 'its condition'}` : '',
          s.loop ? `runs ${s.loop}` : '',
          until ? `runs again ${until}` : '',
          s.parallel ? `parallel group ${s.parallel}: may run at the same time as the group's other steps` : '',
          s.finally ? 'finally: runs after every other step, whatever happened' : '',
          s.extract?.length ? `extracts ${s.extract.join(', ')}` : '',
          s.dependsOn?.length ? `after ${s.dependsOn.join(', ')}` : '',
          missingVars ? `reads ${missingVars.map((v) => `{{${v}}}`).join(', ')}, which no earlier step extracts and the environment does not define` : '',
          result ?? '',
          mark?.breakpoint ? 'breakpoint: a debug run pauses before this step' : '',
          mark?.pinned ? 'pinned: runs from the designer use its pinned response instead of calling the API' : '',
          mark?.paused ? 'paused here: Continue, Step over or Stop in the inspector' : '',
          editable
            ? condition
              ? 'Drag to move · drag the true or false dot onto a step: it runs on that branch · double-click opens it in the editor'
              : 'Drag to move · drag the right dot onto another step to connect · double-click opens it in the editor'
            : '',
        ]
          .filter(Boolean)
          .join('\n')}
      </title>
      {match && (
        <rect
          x={-6}
          y={-6}
          width={n.w + 12}
          height={n.h + 12}
          rx={12}
          className={cx('pointer-events-none', match === 'current' ? 'fill-warn/25 stroke-warn' : 'fill-warn/10 stroke-warn/60')}
          strokeWidth={match === 'current' ? 2.5 : 1.5}
        />
      )}
      <FocusRing w={n.w} h={n.h} width={2.5} />
      {mark?.paused && <rect x={-5} y={-5} width={n.w + 10} height={n.h + 10} rx={11} className="fill-none stroke-accent" strokeWidth={2} strokeDasharray="6 4" data-flow-paused-ring />}
      <rect
        width={n.w}
        height={n.h}
        rx={8}
        className={cx('fill-panel', s.status ? (STATUS_STROKE[s.status] ?? 'stroke-line-strong') : 'stroke-line-strong', selected && 'stroke-accent')}
        strokeWidth={selected ? 2.5 : 1.5}
        strokeDasharray={s.status === 'skipped' ? '4 3' : undefined}
      />
      {mark?.breakpoint && <circle cx={0} cy={0} r={6} className="fill-bad stroke-panel" strokeWidth={1.5} data-flow-breakpoint-dot />}
      {(mark?.pinned || mark?.paused) && (
        <g transform={`translate(${mark?.breakpoint ? 12 : 8} -8)`}>
          {mark?.pinned && (
            <g data-flow-pin>
              <rect width={40} height={15} rx={7.5} className="fill-warn" />
              <text x={20} y={11} textAnchor="middle" className="fill-bg text-[9.5px] font-bold">
                PINNED
              </text>
            </g>
          )}
          {mark?.paused && (
            <g transform={`translate(${mark?.pinned ? 46 : 0} 0)`}>
              <rect width={46} height={15} rx={7.5} className="fill-accent" />
              <text x={23} y={11} textAnchor="middle" className="fill-bg text-[9.5px] font-bold">
                PAUSED
              </text>
            </g>
          )}
        </g>
      )}
      {s.status && <circle cx={14} cy={17} r={4} className={STATUS_FILL[s.status] ?? 'fill-muted'} />}
      <text x={s.status ? 24 : 12} y={21} className="fill-fg text-[13px] font-medium">
        {fitText(s.name, n.w - (s.status ? 24 : 12) - PAD - marksRoom - (loop ? textWidth(loop, F_LOOP) + 8 : 0), F_NAME)}
      </text>
      {loop && (
        <text x={n.w - PAD - marksRoom} y={21} textAnchor="end" className="fill-accent text-[11px] font-semibold tabular-nums" data-flow-loop={s.loop}>
          {loop}
        </text>
      )}
      {problem && (
        <g transform={`translate(${n.w - (missingVars ? 34 : 16)} 15)`} data-flow-problem-mark={problem}>
          <circle r={7} className={problem === 'error' ? 'fill-bad' : 'fill-warn'} />
          <text y={3.5} textAnchor="middle" className="fill-bg text-[10px] font-bold">
            ×
          </text>
        </g>
      )}
      {missingVars && (
        <g transform={`translate(${n.w - 16} 15)`} data-flow-unresolved={missingVars.join(',')}>
          <circle r={7} className="fill-warn" />
          <text y={3.5} textAnchor="middle" className="fill-bg text-[10px] font-bold">
            !
          </text>
        </g>
      )}
      <text x={12} y={42} className="text-[11px] mono">
        <tspan className={kind[1]} fill="currentColor" fontWeight="bold">
          {kind[0]}
        </tspan>
        {s.method && (
          <tspan dx={8} className={s.type === 'http' ? `method-${s.method}` : 'fill-muted'} fill="currentColor">
            {s.method}
          </tspan>
        )}
        <tspan dx={6} className="fill-muted">
          {fitText(where, n.w - 12 - PAD - textWidth(kind[0], F_LINE_BOLD) - (s.method ? 8 + textWidth(s.method, F_LINE) : 0) - 6, F_LINE)}
        </tspan>
      </text>
      <text x={12} y={60} className="fill-muted text-[11px]">
        {until ? (
          <tspan data-flow-until={until} className="fill-accent">
            {fitText(until, thirdRoom, F_SMALL)}
          </tspan>
        ) : (
          fitText(!condition && s.if ? `if ${s.if}` : s.extract?.length ? `→ ${s.extract.join(', ')}` : s.dependsOn?.length ? `after ${s.dependsOn.join(', ')}` : '', thirdRoom, F_SMALL)
        )}
      </text>
      {result && (
        <text
          x={resultRight}
          y={60}
          textAnchor="end"
          data-flow-result
          className={cx(
            'text-[11px] tabular-nums',
            s.status === 'passed' ? 'fill-ok' : s.status === 'skipped' || s.status === 'running' ? 'fill-muted' : 'fill-bad',
            onOpenResult && s.status !== 'running' && 'underline cursor-pointer',
          )}
          onClick={(e) => {
            if (!onOpenResult || s.status === 'running') return;
            e.stopPropagation();
            onOpenResult(s);
          }}
        >
          {resultText}
        </text>
      )}
      {editable && (
        <>
          <circle data-flow-port="in" cx={0} cy={n.h / 2} r={5} className="fill-panel stroke-line-strong" strokeWidth={1.5}>
            <title>Input: drop a connection here</title>
          </circle>
          {condition ? (
            ([true, false] as const).map((w) => (
              <g key={String(w)}>
                <text x={n.w - 10} y={portY(n.h, w) + 3.5} textAnchor="end" className={cx('text-[10px] font-semibold pointer-events-none', w ? 'fill-ok' : 'fill-bad')}>
                  {String(w)}
                </text>
                <circle data-flow-port="out" data-flow-when={String(w)} cx={n.w} cy={portY(n.h, w)} r={6} className={cx('stroke-panel cursor-crosshair', w ? 'fill-ok' : 'fill-bad')} strokeWidth={1.5}>
                  <title>{`Click to add a block on the ${w} branch; drag onto a step: it runs when the condition is ${w}`}</title>
                </circle>
                {onPortAdd && <PortAdd x={n.w + 16} y={portY(n.h, w)} onClick={(at) => onPortAdd(s.id, w, at)} />}
              </g>
            ))
          ) : (
            <>
              <circle data-flow-port="out" cx={n.w} cy={n.h / 2} r={6} className="fill-accent stroke-panel cursor-crosshair" strokeWidth={1.5}>
                <title>Click to add a block after this step; drag onto another step: it then waits for this one</title>
              </circle>
              {onPortAdd && <PortAdd x={n.w + 16} y={n.h / 2} onClick={(at) => onPortAdd(s.id, undefined, at)} />}
            </>
          )}
        </>
      )}
      {!editable && condition && (
        <>
          <circle cx={n.w} cy={portY(n.h, true)} r={3} className="fill-ok" />
          <circle cx={n.w} cy={portY(n.h, false)} r={3} className="fill-bad" />
        </>
      )}
    </g>
  );
}

type Box = { x: number; y: number; w: number; h: number };

/**
 * A connection: the curve from a step's output (or a condition's true / false port) to the step that waits, labelled
 * with the variables that flow along it. Memoised: dragging a step re-renders only the connections of the steps moved.
 */
export const FlowEdgeView = memo(function FlowEdgeView({
  edge: e,
  from: a,
  to: b,
  selected,
  near,
  bad,
  editable,
  compact,
  arrow,
  onSelect,
}: {
  edge: FlowEdge;
  from: Box;
  to: Box;
  selected: boolean;
  near: boolean;
  bad: boolean;
  editable?: boolean;
  compact: boolean;
  arrow: string;
  onSelect(e: FlowEdge): void;
}) {
  const x1 = a.x + a.w;
  const y1 = a.y + (e.when === undefined ? a.h / 2 : portY(a.h, e.when));
  const x2 = b.x;
  const y2 = b.y + b.h / 2;
  const dx = Math.max(24, Math.abs(x2 - x1) / 2);
  const d = `M ${x1} ${y1} C ${x1 + dx} ${y1}, ${x2 - dx} ${y2}, ${x2} ${y2}`;
  const key = `${e.from}>${e.to}`;
  const label = e.vars?.length ? e.vars.map((v) => `{{${v}}}`).join(' ') : '';
  return (
    <g>
      <path
        data-flow-edge={key}
        d={d}
        data-flow-edge-problem={bad || undefined}
        className={cx('fill-none', bad ? 'stroke-bad' : selected || near ? 'stroke-accent' : 'stroke-line-strong')}
        strokeWidth={selected ? 2.5 : 1.5}
        markerEnd={`url(#${arrow})`}
      />
      {editable && (
        <path data-flow-edge-hit={key} d={d} className="fill-none stroke-transparent cursor-pointer" strokeWidth={12} onClick={() => onSelect(e)}>
          <title>{`${e.to} waits for ${e.from}${label ? ` (${label})` : ''}: click to select, Delete removes it`}</title>
        </path>
      )}
      {label && !compact && (
        <text x={(x1 + x2) / 2} y={(y1 + y2) / 2 - 6} textAnchor="middle" className="fill-accent stroke-bg text-[10px] mono pointer-events-none" strokeWidth={3} paintOrder="stroke" data-flow-edge-vars={key}>
          {fitText(label, Math.max(80, Math.min(240, Math.abs(x2 - x1) - 16)), F_EDGE)}
        </text>
      )}
      {e.when !== undefined && !compact && (
        <text
          x={x1 + 12}
          y={y1 + (e.when ? -6 : 13)}
          className={cx('stroke-bg text-[10px] font-semibold pointer-events-none', e.when ? 'fill-ok' : 'fill-bad')}
          strokeWidth={3}
          paintOrder="stroke"
          data-flow-edge-when={key}
        >
          {String(e.when)}
        </text>
      )}
    </g>
  );
});

/** The keyboard focus of a step: a ring that shows when the step has the focus from the keyboard (Tab, arrow keys). */
function FocusRing({ w, h, width }: { w: number; h: number; width: number }) {
  return <rect x={-4} y={-4} width={w + 8} height={h + 8} rx={11} className="fill-none stroke-accent opacity-0 group-focus-visible:opacity-100 pointer-events-none" strokeWidth={width} data-flow-focus-ring />;
}
