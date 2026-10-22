import { Eye, Sparkles } from 'lucide-react';
import { useRef, useState } from 'react';
import type { AiTaskResult } from '@testpion/core';
import { call } from '../../api';
import { useApp, type AssistantRequest } from '../../store';
import { useAiEnabled } from '../../lib/use-ai-enabled';
import { Button, cx, IconButton, LinkButton } from '../ui';
import { AiEstimateLine, estimateText } from './AiEstimateLine';
import { AiPreviewDialog, taskParams } from './AiPreviewDialog';

/**
 * Start an AI action: the assistant panel opens on it, runs it (streamed, Stop cancels) and shows the answer — and, for
 * a task that proposes changes, the verified proposal with Review. Every AI entry point of the window goes through
 * here (or the AiAction button), so setup, privacy, cost and review behave the same everywhere.
 */
export function startAi(req: AssistantRequest): void {
  // from a menu item or a button without an estimate: the panel opens on "Ready to send" (the estimate and "What will be sent"),
  // so no model is called before the person has seen what goes and what it can cost; a free question is sent as it is typed
  useApp.getState().set({ assistant: { ...req, preflight: req.preflight ?? req.task !== 'free' } });
}

/** The free question with what is on screen (the palette, the rail, Home, Ctrl+J). */
export const askAssistant = (): void => startAi({ task: 'free', title: 'Ask the assistant', context: {} });

/** Whether a model is chosen for the AI features (else the panel shows how to set one up). */
const aiConfigured = (s = useApp.getState().settings) => !!(s?.assistantProvider || s?.ai?.small?.provider || s?.ai?.large?.provider);

/**
 * The one AI button (AIB-10): ✦ label, and beside it "What will be sent…" (the exact payload, the privacy level, the
 * token and cost estimate). Hovering it shows the model, whether it stays on this computer, and the estimate. The
 * request is built when used (`request` may be a function), so a big context costs nothing until then.
 */
export function AiAction({
  request,
  label,
  variant = 'button',
  className,
  hint,
  preview = true,
  onStart,
  open,
}: {
  /** Built when used; may read data first (a monitor's per-request numbers). */
  request: AssistantRequest | (() => AssistantRequest | undefined | Promise<AssistantRequest | undefined>);
  label: string;
  /** button: a small default button; ghost: a quiet one; link: inline text; primary: the view's main action. */
  variant?: 'button' | 'ghost' | 'link' | 'primary';
  className?: string;
  /** What it does, for the tooltip. */
  hint?: string;
  /** Show "What will be sent…" beside it (default on). */
  preview?: boolean;
  /** Told when the action starts (a dialog closes itself to show the assistant). */
  onStart?(): void;
  /** An analysis with a dialog of its own (triage, flaky analysis): opened instead of the assistant panel; `request` still gives the estimate and What will be sent. */
  open?(): void;
}) {
  const enabled = useAiEnabled();
  const configured = useApp((s) => aiConfigured(s.settings));
  const [previewing, setPreviewing] = useState<AssistantRequest>();
  const [estimate, setEstimate] = useState<string>();
  // the estimate shows beside the button while the pointer or the keyboard focus is on it (a tooltip alone never reaches a keyboard or a screen reader)
  const [near, setNear] = useState(false);
  const asked = useRef(false);
  const build = (): Promise<AssistantRequest | undefined> => Promise.resolve(typeof request === 'function' ? request() : request).catch(() => undefined);
  const go = () => {
    if (open) return void (open(), onStart?.());
    void build().then((r) => {
      if (!r) return;
      // the button shows the estimate (hover, focus) and "What will be sent…" beside it: no second question
      startAi({ ...r, preflight: r.preflight ?? false });
      onStart?.();
    });
  };
  // the estimate is built once, on the first hover or focus (nothing is sent)
  const onHover = () => {
    setNear(true);
    if (asked.current || !configured) return;
    asked.current = true;
    void build().then((r) => {
      if (!r) return;
      call<AiTaskResult>('ai.preview', taskParams(r, useApp.getState().environment)).then(
        ({ preview: p }) =>
          setEstimate(estimateText(p)),
        () => setEstimate(undefined),
      );
    });
  };
  const title = [hint, configured ? (estimate ?? 'AI: the answer is a suggestion you review') : 'Set up the AI assistant first (Settings ▸ AI assistant)'].filter(Boolean).join('\n');
  const icon = <Sparkles size={12} />;
  // Settings ▸ AI assistant ▸ Hide all AI actions: the button is not there at all
  if (!enabled) return null;
  const main =
    variant === 'link' ? (
      <LinkButton icon={icon} onClick={go} onPointerEnter={onHover} onFocus={onHover} onPointerLeave={() => setNear(false)} onBlur={() => setNear(false)} title={title} data-ai-action>
        {label}
      </LinkButton>
    ) : (
      <Button size="sm" variant={variant === 'primary' ? 'primary' : variant === 'ghost' ? 'ghost' : undefined} icon={icon} onClick={go} onPointerEnter={onHover} onFocus={onHover} onPointerLeave={() => setNear(false)} onBlur={() => setNear(false)} title={title} data-ai-action>
        {label}
      </Button>
    );
  return (
    <span className={cx('relative inline-flex items-center gap-0.5', className)}>
      {main}
      <AiEstimateLine
        waiting={false}
        className={near && estimate ? 'absolute left-0 top-full z-30 mt-1 whitespace-nowrap rounded-md border border-line bg-popover px-2 py-1 text-xs text-muted shadow-md pointer-events-none' : 'sr-only'}
        estimate={near && estimate ? { ok: true, text: estimate } : undefined}
        data-ai-action-estimate=""
      />
      {preview && configured && (
        <IconButton label="What will be sent…" className="h-6 w-6" onClick={() => void build().then((r) => r && setPreviewing(r))} data-ai-preview-open>
          <Eye size={12} />
        </IconButton>
      )}
      {previewing && (
        <AiPreviewDialog
          request={previewing}
          onClose={() => setPreviewing(undefined)}
          onSend={(privacy) => {
            const r = previewing;
            setPreviewing(undefined);
            if (open) open();
            else startAi({ ...r, privacy, preflight: false });
            onStart?.();
          }}
        />
      )}
    </span>
  );
}
