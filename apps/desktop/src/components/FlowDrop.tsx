/**
 * Dropping onto the flow canvas: items dragged from anywhere in the app (requests, folders and collections from the
 * explorer, History entries, Debugger exchanges, test files — they carry ItemRefs, lib/drag-ref.ts) and blocks from the
 * canvas's palette. While a drag is over the canvas it shows where the drop lands: after a step (the step is outlined),
 * on a condition's true / false branch, into a connection (the connection is outlined: "insert between"), or alone on
 * the empty canvas (a ghost step at the pointer). The drop itself is the designer's (one flow edit, one undo step).
 */
import { useCallback, useRef, useState } from 'react';
import type { ItemRef } from '@testpion/shared';
import { hasDragBlock, hasDragRefs, readDragBlock, readDragRefs } from '../lib/drag-ref';
import { portY } from './FlowNode';

/** Where a drag would land. */
export type DropHint = { kind: 'node'; id: string } | { kind: 'port'; id: string; when: boolean } | { kind: 'edge'; from: string; to: string } | { kind: 'canvas'; at: [number, number] };

/** A drop: the items or the block, where, and the point of the canvas it was released at. */
export interface FlowDropEvent {
  refs: ItemRef[];
  block?: string;
  hint: DropHint;
  at: [number, number];
}

const keyOf = (h: DropHint | undefined) =>
  !h
    ? ''
    : h.kind === 'canvas'
      ? `canvas:${Math.round(h.at[0] / 8)}:${Math.round(h.at[1] / 8)}`
      : h.kind === 'edge'
        ? `edge:${h.from}>${h.to}`
        : h.kind === 'port'
          ? `port:${h.id}:${h.when}`
          : `node:${h.id}`;

/** What is under the pointer of a drag: a port, a step, a connection, or the empty canvas. */
function hintAt(target: Element | null, at: [number, number]): DropHint {
  const port = target?.closest('[data-flow-port="out"][data-flow-when]');
  const node = target?.closest('[data-flow-node]')?.getAttribute('data-flow-node');
  if (port && node) return { kind: 'port', id: node, when: port.getAttribute('data-flow-when') === 'true' };
  if (node) return { kind: 'node', id: node };
  const edge = target?.closest('[data-flow-edge-hit], [data-flow-edge]');
  const key = edge?.getAttribute('data-flow-edge-hit') ?? edge?.getAttribute('data-flow-edge');
  if (key && key.includes('>')) {
    const [from, to] = key.split('>') as [string, string];
    return { kind: 'edge', from, to };
  }
  return { kind: 'canvas', at };
}

/**
 * The canvas's drop handlers and what to show while a drag is over it. `toGraph` turns a pointer into the diagram's
 * units. A dragover arrives many times a second: the hint changes (and the canvas renders) only when the place does.
 */
export function useFlowDrop({ enabled, toGraph, onDrop }: { enabled: boolean; toGraph(x: number, y: number): [number, number]; onDrop?(d: FlowDropEvent): void }) {
  const [hint, setHint] = useState<DropHint>();
  const last = useRef('');
  const show = useCallback((h: DropHint | undefined) => {
    const k = keyOf(h);
    if (k === last.current) return;
    last.current = k;
    setHint(h);
  }, []);
  const accepts = (e: React.DragEvent) => enabled && !!onDrop && (hasDragRefs(e) || hasDragBlock(e));
  const handlers = {
    onDragOver: (e: React.DragEvent) => {
      if (!accepts(e)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
      show(hintAt(e.target as Element, toGraph(e.clientX, e.clientY)));
    },
    onDragLeave: (e: React.DragEvent) => {
      // leaving for a child is not leaving the canvas
      if (e.relatedTarget && (e.currentTarget as Element).contains(e.relatedTarget as Node)) return;
      show(undefined);
    },
    onDrop: (e: React.DragEvent) => {
      if (!accepts(e)) return;
      e.preventDefault();
      const at = toGraph(e.clientX, e.clientY);
      const h = hintAt(e.target as Element, at);
      show(undefined);
      const refs = readDragRefs(e);
      const block = readDragBlock(e);
      if (refs.length || block) onDrop!({ refs, block, hint: h, at });
    },
  };
  return { hint, handlers };
}

/** The place a drag would land, drawn on the canvas (in the diagram's units). */
export function DropHintLayer({ hint, box, name }: { hint: DropHint; box(id: string): { x: number; y: number; w: number; h: number } | undefined; name(id: string): string }) {
  if (hint.kind === 'canvas') {
    const [x, y] = hint.at;
    return (
      <g className="pointer-events-none" data-flow-drop-hint="canvas">
        <rect x={x - 110} y={y - 36} width={220} height={72} rx={8} className="fill-accent/10 stroke-accent" strokeWidth={1.5} strokeDasharray="6 4" />
        <text x={x} y={y + 4} textAnchor="middle" className="fill-accent text-[12px] font-medium">
          Drop to add here
        </text>
      </g>
    );
  }
  if (hint.kind === 'edge') {
    const a = box(hint.from);
    const b = box(hint.to);
    if (!a || !b) return null;
    const x1 = a.x + a.w;
    const y1 = a.y + a.h / 2;
    const x2 = b.x;
    const y2 = b.y + b.h / 2;
    const dx = Math.max(24, Math.abs(x2 - x1) / 2);
    return (
      <g className="pointer-events-none" data-flow-drop-hint="edge">
        <path d={`M ${x1} ${y1} C ${x1 + dx} ${y1}, ${x2 - dx} ${y2}, ${x2} ${y2}`} className="fill-none stroke-accent" strokeWidth={5} strokeOpacity={0.5} />
        <text x={(x1 + x2) / 2} y={(y1 + y2) / 2 - 10} textAnchor="middle" className="fill-accent stroke-bg text-[11px] font-semibold" strokeWidth={3} paintOrder="stroke">
          insert between
        </text>
      </g>
    );
  }
  const n = box(hint.id);
  if (!n) return null;
  const label = hint.kind === 'port' ? `on the ${hint.when} branch of ${name(hint.id)}` : `after ${name(hint.id)}`;
  return (
    <g className="pointer-events-none" data-flow-drop-hint={hint.kind}>
      <rect x={n.x - 5} y={n.y - 5} width={n.w + 10} height={n.h + 10} rx={11} className="fill-accent/10 stroke-accent" strokeWidth={2} />
      {hint.kind === 'port' && <circle cx={n.x + n.w} cy={n.y + portY(n.h, hint.when)} r={10} className="fill-none stroke-accent" strokeWidth={2} />}
      <text x={n.x + n.w / 2} y={n.y - 10} textAnchor="middle" className="fill-accent stroke-bg text-[11px] font-semibold" strokeWidth={3} paintOrder="stroke">
        {label.length > 48 ? `${label.slice(0, 47)}…` : label}
      </text>
    </g>
  );
}
