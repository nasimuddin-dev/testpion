import { Bot, CircleHelp, Flag, MessageSquare, Wrench, Check, X } from 'lucide-react';
import type { ReactNode } from 'react';
import type { TrajectoryItem, TrajectoryPin } from '@testpion/core';
import { cx } from './ui';

/**
 * A story in steps (A-1): the question, each model call, each tool call with its arguments and result, the final answer, down one
 * line, with the checks pinned to the step that decided them — green where a "should call" was met, red where a forbidden call
 * happened, grey where something never happened. One component for the steps of an agent case; a flow run's steps can use it too
 * (an item is a title, a detail and pins).
 */
const ICON: Record<TrajectoryItem['kind'], ReactNode> = {
  input: <MessageSquare size={13} />,
  model: <Bot size={13} />,
  tool: <Wrench size={13} />,
  answer: <Flag size={13} />,
};

export function PinBadge({ pin }: { pin: TrajectoryPin }) {
  return (
    <span
      className={cx('inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs', pin.state === 'ok' ? 'border-ok/40 bg-ok/10 text-ok' : pin.state === 'bad' ? 'border-bad/40 bg-bad/10 text-bad' : 'border-line text-muted')}
      title={pin.check}
      data-pin={pin.state}
    >
      {pin.state === 'ok' ? <Check size={11} /> : pin.state === 'bad' ? <X size={11} /> : <CircleHelp size={11} />}
      {pin.text}
    </span>
  );
}

export function StepTimeline({ items, endPins, label }: { items: readonly TrajectoryItem[]; endPins?: readonly TrajectoryPin[]; label: string }) {
  return (
    <ol className="relative px-3 py-2 text-xs" aria-label={label} data-step-timeline>
      {items.map((it) => (
        <li key={it.id} className="relative pl-6 pb-2 last:pb-0" data-step={it.id} data-step-kind={it.kind} data-step-error={it.error ? 'true' : undefined}>
          <span className="absolute left-0 top-0.5 flex size-4 items-center justify-center rounded-full border border-line bg-surface text-muted">{ICON[it.kind]}</span>
          <span className="absolute left-[7px] top-5 bottom-0 w-px bg-line" aria-hidden />
          <div className={cx(it.kind === 'tool' ? 'mono' : 'font-medium', it.error && 'text-bad')}>{it.title}</div>
          {it.detail && it.kind !== 'tool' && <div className="text-muted whitespace-pre-wrap break-words max-h-24 overflow-auto">{it.detail}</div>}
          {it.kind === 'tool' && it.detail && (
            <details className="text-muted">
              <summary className="cursor-pointer truncate">
                {it.error ? 'Error: ' : 'Result: '}
                {it.detail.replace(/\s+/g, ' ').slice(0, 100)}
              </summary>
              <pre className="mono whitespace-pre-wrap break-words max-h-40 overflow-auto p-1.5">{it.detail}</pre>
            </details>
          )}
          {it.pins.length > 0 && (
            <div className="mt-1 flex flex-wrap gap-1" data-pins>
              {it.pins.map((p, i) => (
                <PinBadge key={`${p.check}-${i}`} pin={p} />
              ))}
            </div>
          )}
        </li>
      ))}
      {endPins && endPins.length > 0 && (
        <li className="pl-6 pt-1" data-step="end-checks">
          <div className="text-muted mb-1">Checks about the tools as a whole</div>
          <div className="flex flex-wrap gap-1" data-pins>
            {endPins.map((p, i) => (
              <PinBadge key={`${p.check}-${i}`} pin={p} />
            ))}
          </div>
        </li>
      )}
    </ol>
  );
}
