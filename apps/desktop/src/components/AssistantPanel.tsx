import { BookOpen, Bot, Check, Copy, Eye, ListChecks, Paperclip, RotateCcw, Square, X } from 'lucide-react';
import { memo, useEffect, useRef, useState } from 'react';
import { extractCodeBlock } from '@testpion/shared';
import { stringify as toYaml } from 'yaml';
import type { AiTaskResult, Proposal, ProposalItem } from '@testpion/core';
import { asError, call, on } from '../api';
import { currentViewContext, type ViewContext } from '../lib/assistant-context';
import { useApp, type AssistantRequest, toastError } from '../store';
import { Markdown } from './Markdown';
import { AiGeneratedNotice, ErrorPanel } from './Results';
import { Badge, Button, cx, IconButton, Input, Spinner } from './ui';
import { copyText } from '../lib/clipboard';
import { aiSetupAction } from '../lib/ai-errors';
import { offerUndo } from '../lib/undo';
import { AiPreviewDialog, taskParams, type AiPrivacy } from './ai/AiPreviewDialog';
import { ProposalReview, VerificationBadgeView } from './ai/ProposalReview';

interface Turn {
  role: 'user' | 'assistant';
  content: string;
  /** The first turn of a task (Explain this response, …): sent, but shown as the task's title. */
  task?: boolean;
  provider?: string;
  model?: string;
  /** What the answer proposes (verified items to review and apply). */
  proposal?: Proposal;
  /** The answer stopped at the output limit. */
  truncated?: boolean;
}

/**
 * The AI assistant drawer: a conversation about the task it was opened for (or a free question with the context of the
 * current view). Follow-ups remember the conversation; answers stream and can be stopped. Output is always labelled
 * as an AI-generated suggestion.
 */
export function AssistantPanel() {
  const stored = useApp((s) => s.assistant)!;
  // "What will be sent" can change the privacy level of this conversation
  const [privacy, setPrivacy] = useState<AiPrivacy | undefined>(stored.privacy);
  const req = privacy === stored.privacy ? stored : { ...stored, privacy };
  const [previewing, setPreviewing] = useState(false);
  const set = useApp((s) => s.set);
  const env = useApp((s) => s.environment);
  const free = req.task === 'free';
  const [turns, setTurns] = useState<Turn[]>([]);
  const [question, setQuestion] = useState(req.question ?? '');
  const [streaming, setStreaming] = useState('');
  const [busy, setBusy] = useState<string>();
  const [error, setError] = useState<ReturnType<typeof asError>>();
  // a free question carries what the current view shows (the open request, …) unless the user leaves it out
  const [viewCtx, setViewCtx] = useState<ViewContext | undefined>(() => (free ? currentViewContext() : undefined));
  const end = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => on<Array<{ id: string; delta: string }>>('assistant.deltas', (items) => setStreaming((s) => s + items.filter((d) => d.id === busyRef.current).map((d) => d.delta).join(''))), []);
  const busyRef = useRef<string | undefined>(undefined);
  busyRef.current = busy;

  // which conversation an answer belongs to: New conversation starts another, and answers to the old one are dropped
  const conversation = useRef(0);
  const ask = async (q?: string, fresh = false, hint?: string) => {
    const text = q?.trim();
    if (!fresh && (busy || (!text && turns.length))) return;
    const mine = conversation.current;
    const id = `as-${Date.now().toString(36)}`;
    const userTurn: Turn = text ? { role: 'user', content: text } : { role: 'user', content: `Task: ${req.title}`, task: true };
    const history = fresh ? [] : turns.map(({ role, content }) => ({ role, content }));
    setTurns((t) => [...t, userTurn]);
    setQuestion('');
    setError(undefined);
    setStreaming('');
    setBusy(id);
    try {
      const context = free ? (viewCtx?.context ?? {}) : req.context;
      // the core task runner (packages/core/src/ai/tasks): redaction, budgets, caps, verification and proposals happen there
      const r = await call<AiTaskResult>('ai.runTask', { ...taskParams({ ...req, context }, env), question: text, hint, history, requestId: id });
      if (mine !== conversation.current) return;
      setTurns((t) => [...t, { role: 'assistant', content: r.text, provider: r.provider, model: r.model, proposal: r.proposal, truncated: r.truncated }]);
    } catch (e) {
      if (mine !== conversation.current) return;
      const err = asError(e);
      // stopped: keep what had arrived
      if (err.kind === 'CancelledError' || /abort|cancel/i.test(err.message)) setTurns((t) => [...t, { role: 'assistant', content: `${streamingRef.current}\n\n*(stopped)*`.trim() }]);
      else {
        setError(err);
        setTurns((t) => (t[t.length - 1] === userTurn ? t.slice(0, -1) : t));
        if (text) setQuestion(text);
      }
    } finally {
      if (mine === conversation.current) {
        setBusy(undefined);
        setStreaming('');
        input.current?.focus();
      }
    }
  };
  const streamingRef = useRef('');
  streamingRef.current = streaming;

  useEffect(() => {
    if (!free || req.question) void ask(req.question);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    end.current?.scrollIntoView({ block: 'end' });
  }, [turns.length, streaming]);

  const stop = () => busy && void call('ai.cancel', { id: busy }).catch(toastError);
  const restart = () => {
    stop();
    conversation.current++;
    setBusy(undefined);
    setTurns([]);
    setError(undefined);
    setStreaming('');
    if (free) setViewCtx(currentViewContext());
    // a task runs again, in the new conversation
    else void ask(undefined, true);
  };
  // a key, a model or Local only: the one setup helper says what to open (lib/ai-errors.ts)
  const setup = error ? aiSetupAction(error) : undefined;

  return (
    <aside
      // its width is the side panel's (RightPanel: pinned and resizable, or sliding over the content)
      className="flex-1 min-h-0 w-full min-w-0 bg-bg flex flex-col"
      aria-label="AI assistant"
      // Esc closes it like any panel (while an answer is being written, Esc stops it first)
      onKeyDown={(e) => {
        if (e.key !== 'Escape' || e.defaultPrevented) return;
        e.preventDefault();
        if (busy) stop();
        else set({ assistant: undefined });
      }}
    >
      <div className="h-10 flex items-center gap-1 px-3 border-b border-line">
        <Bot size={16} className="text-judge shrink-0" />
        <span className="font-medium text-sm truncate ml-1">{req.title}</span>
        <IconButton label="What will be sent…" className="ml-auto" onClick={() => setPreviewing(true)} data-ai-preview-open>
          <Eye size={14} />
        </IconButton>
        <IconButton label="New conversation" onClick={restart} disabled={!turns.length && !error}>
          <RotateCcw size={14} />
        </IconButton>
        <IconButton label="Close assistant" onClick={() => (stop(), set({ assistant: undefined }))}>
          <X size={15} />
        </IconButton>
      </div>
      <AiGeneratedNotice />
      <div className="flex-1 overflow-auto p-3 text-sm flex flex-col gap-3" aria-live="polite">
        {turns.map((t, i) =>
          t.role === 'user' ? (
            t.task ? null : (
              <div key={i} className="self-end max-w-[85%] rounded-xl rounded-br-sm bg-accent-soft px-3 py-2 whitespace-pre-wrap" data-turn="user">
                {t.content}
              </div>
            )
          ) : (
            <Answer
              key={i}
              turn={t}
              apply={req.apply}
              onRegenerate={(hint) => void ask(undefined, true, hint)}
              // a generating task's first answer opens its review at once (checks, tests, a request)
              autoReview={!!req.autoReview && i === 1}
              response={req.response}
              onRunNow={req.rerun}
            />
          ),
        )}
        {busy && (streaming ? <Answer turn={{ role: 'assistant', content: streaming }} live /> : (
          <div className="flex items-center gap-2 text-muted">
            <Spinner /> Thinking…
          </div>
        ))}
        {setup ? (
          <div className="rounded-xl border border-line bg-panel p-4 flex flex-col gap-2" data-ai-setup>
            <div className="font-medium">{setup.label === 'Add the key' ? 'Add the API key' : setup.label === 'Change the limits' ? 'Over an AI limit' : 'Set up the AI assistant'}</div>
            <p className="text-sm text-muted">
              {error!.message}.{' '}
              {setup.label === 'Add the key'
                ? 'The key is kept in the OS secret store.'
                : setup.label === 'Change the limits'
                  ? 'Nothing was sent. Send less (Metadata only, a smaller selection) or raise the limit.'
                  : 'Save your Claude (Anthropic) API key in Settings, or choose a provider of this workspace such as a local model.'}
            </p>
            <div>
              <Button variant="primary" size="sm" onClick={setup.onClick}>
                {setup.label}
              </Button>
            </div>
          </div>
        ) : (
          error && <ErrorPanel error={error} />
        )}
        {free && !turns.length && !busy && !error && (
          <div className="flex flex-col gap-3">
            <p className="text-muted">Ask about an API error, a GraphQL schema, an MCP tool, or how to write a test. Follow-up questions remember the conversation.</p>
            <div className="flex flex-col items-start gap-1.5" aria-label="Suggested questions">
              {suggestedQuestions(viewCtx).map((q) => (
                <button key={q} className="text-left text-sm rounded-lg border border-line px-2.5 py-1.5 hover:bg-hover hover:border-accent/40 transition-colors" onClick={() => void ask(q)} data-suggestion>
                  {q}
                </button>
              ))}
            </div>
          </div>
        )}
        <div ref={end} />
      </div>
      {previewing && (
        <AiPreviewDialog
          request={free ? { ...req, context: viewCtx?.context ?? {} } : req}
          onClose={() => setPreviewing(false)}
          onSend={(p) => {
            setPreviewing(false);
            setPrivacy(p);
            // the conversation starts again with the chosen level
            conversation.current++;
            setTurns([]);
            setError(undefined);
            if (!free) setTimeout(() => void ask(undefined, true), 0);
          }}
        />
      )}
      <div className="p-3 border-t border-line flex flex-col gap-2">
        {free && viewCtx && !turns.length && (
          <div className="flex items-center gap-1.5 text-xs text-muted min-w-0" data-assistant-context>
            <Paperclip size={12} className="shrink-0" />
            <span className="truncate" title="Sent with your question (secrets are hidden)">
              Context: {viewCtx.label}
            </span>
            <button className="shrink-0 rounded hover:text-fg hover:bg-hover p-0.5" aria-label="Leave out the context" title="Leave out the context" onClick={() => setViewCtx(undefined)}>
              <X size={12} />
            </button>
          </div>
        )}
        <div className="flex gap-2">
          <Input
            ref={input}
            className="flex-1"
            placeholder={turns.length ? 'Ask a follow-up…' : 'Ask a question…'}
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && !e.nativeEvent.isComposing && void ask(question)}
            aria-label="Question for the assistant"
          />
          {busy ? (
            <Button icon={<Square size={12} />} onClick={stop}>
              Stop
            </Button>
          ) : (
            <Button variant="primary" onClick={() => void ask(question)} disabled={!question.trim() && (!!turns.length || free)}>
              Ask
            </Button>
          )}
        </div>
      </div>
    </aside>
  );
}

/** Questions worth asking about what is on screen: a failure first, then explaining it, then what to check. */
export function suggestedQuestions(view?: ViewContext): string[] {
  const c = view?.context as
    | { response?: { status?: number; errors?: unknown[] }; error?: unknown; graphql?: unknown; grpc?: unknown; result?: { code?: number }; connection?: unknown; mcpServer?: unknown; tools?: unknown[] }
    | undefined;
  if (!c) return ['How do I use a value from one response in the next request?', 'How do I run my tests in CI?', 'What can I test with an MCP server?'];
  const failed = !!c.error || (c.response?.status ?? 0) >= 400 || !!c.response?.errors?.length || (c.result?.code ?? 0) > 0;
  if (c.mcpServer) return c.error ? ['Why does the connection fail?', 'How do I set up this server?'] : ['What can this server do?', 'Which tool should I try first, and with what arguments?', 'How do I test these tools automatically?'];
  if (c.connection) return ['Explain these messages', 'How do I test this connection automatically?'];
  const what = c.graphql ? 'query' : c.grpc ? 'call' : 'request';
  if (failed) return [`Why did this ${what} fail?`, 'How do I fix it?', 'Which checks would catch this?'];
  if (c.response || c.result) return [`Explain this ${c.grpc ? 'call' : 'response'}`, 'Which checks should I add?', 'How do I use a value from it in the next request?'];
  return c.graphql ? ['Explain this query', 'Which checks should I add?', 'Write a query for related data'] : [`What will this ${what} do?`, 'How do I add authentication?', 'Which checks should I add?'];
}

/** The text an editor's own Apply takes for the chosen items: checks as one YAML list, anything else as its text. */
export function codeOfItems(items: ProposalItem[]): string {
  const checks = items.filter((i) => i.kind === 'assertion');
  if (checks.length === items.length) return toYaml(checks.map((i) => i.data)).trim();
  return items.map((i) => i.after).join('\n\n');
}

/**
 * Accept the chosen items of a proposal: into the editor that asked when it has its own Apply (a tab's unsaved checks, a
 * query, the flow designer's one-undo-step replace), else into the workspace (`ai.applyProposal`: test files, a saved request's checks or script), with Undo.
 */
async function acceptItems(proposal: Proposal, items: ProposalItem[], apply?: AssistantRequest['apply']): Promise<boolean> {
  const toast = useApp.getState().toast;
  try {
    if (apply) {
      const r = await apply.run(codeOfItems(items));
      if (typeof r === 'string') {
        toast(`Couldn't use the answer: ${r}`, 'error');
        return false;
      }
      if (r) toast(r.done, 'success', r.action);
      else toast(`${apply.label}: ${items.length} item${items.length === 1 ? '' : 's'}`, 'success');
      // the editor applied them (its own undo): the proposal and the usage ledger record the acceptance
      void call('ai.applyProposal', { id: proposal.id, items: items.map((i) => i.id), recordOnly: true }).catch(() => undefined);
      return true;
    }
    const r = await call<{ applied: Array<{ title: string }>; skipped: Array<{ item: string; reason: string }> }>('ai.applyProposal', { id: proposal.id, items: items.map((i) => i.id) });
    const undo = offerUndo(() => call('ai.undoProposal', { id: proposal.id }).then(() => toast('Undone', 'success'), toastError));
    toast(`Applied ${r.applied.length} change${r.applied.length === 1 ? '' : 's'}${r.skipped.length ? ` (${r.skipped.length} skipped: ${r.skipped[0]!.reason})` : ''}`, r.skipped.length ? 'info' : 'success', { label: 'Undo', onClick: undo });
    return true;
  } catch (e) {
    toastError(e);
    return false;
  }
}

/** One answer: Markdown, each code block with its own Copy button, the model that wrote it, and Review / Apply when the task proposes something. */
const Answer = memo(function Answer({
  turn,
  live,
  apply,
  onRegenerate,
  autoReview,
  response,
  onRunNow,
}: {
  turn: Turn;
  live?: boolean;
  apply?: AssistantRequest['apply'];
  onRegenerate?(hint: string): void;
  autoReview?: boolean;
  response?: AssistantRequest['response'];
  onRunNow?: AssistantRequest['rerun'];
}) {
  const [reviewing, setReviewing] = useState(() => !!autoReview && !!turn.proposal?.items.some((i) => i.kind !== 'text'));
  // a proposal of changes (checks, files, scripts, requests) is reviewed; text alone (a query, arguments, a message) keeps Apply
  const p = turn.proposal?.items.some((i) => i.kind !== 'text') ? turn.proposal : undefined;
  const use = async () => {
    if (!apply) return;
    const toast = useApp.getState().toast;
    try {
      const r = await apply.run(extractCodeBlock(turn.content));
      if (typeof r === 'string') toast(`Couldn't use the answer: ${r}`, 'error');
      else if (r) toast(r.done, 'success', r.action);
      else toast(`${apply.label}: done`, 'success');
    } catch (e) {
      toast(`Couldn't use the answer: ${asError(e).message}`, 'error');
    }
  };
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (live || !box.current) return;
    for (const pre of box.current.querySelectorAll('pre')) {
      if (pre.querySelector('[data-copy-code]')) continue;
      const b = document.createElement('button');
      b.dataset.copyCode = '';
      b.textContent = 'Copy';
      b.setAttribute('aria-label', 'Copy this code');
      b.className = 'absolute top-1 right-1 text-xs rounded px-1.5 py-0.5 bg-panel border border-line text-muted hover:text-fg';
      b.onclick = () => {
        void navigator.clipboard.writeText(pre.querySelector('code')?.textContent ?? pre.textContent ?? '');
        b.textContent = 'Copied';
        setTimeout(() => (b.textContent = 'Copy'), 1200);
      };
      pre.classList.add('relative');
      pre.appendChild(b);
    }
  }, [turn.content, live]);
  return (
    <div className="flex flex-col gap-1.5" data-turn="assistant">
      <div ref={box}>
        <Markdown source={turn.content} className={cx('leading-relaxed', live && 'opacity-90')} />
      </div>
      {!live && turn.truncated && <p className="text-xs text-warn">The answer was cut at the output limit: ask a narrower question, or ask it to continue.</p>}
      {!live && p && (
        <div className="rounded-lg border border-line bg-panel px-2.5 py-2 flex flex-col gap-1.5" data-proposal-chip={p.id}>
          <div className="flex items-center gap-2 text-xs">
            <ListChecks size={13} className="text-accent" />
            <span className="font-medium">
              {p.items.length} proposed change{p.items.length === 1 ? '' : 's'}
            </span>
            <Button size="sm" variant="primary" className="ml-auto" onClick={() => setReviewing(true)} data-proposal-review>
              Review
            </Button>
          </div>
          <div className="flex flex-wrap gap-1">
            {p.items
              .flatMap((i) => i.verification)
              .slice(0, 6)
              .map((b, k) => (
                <VerificationBadgeView key={k} b={b} />
              ))}
          </div>
        </div>
      )}
      {reviewing && p && (
        <ProposalReview
          proposal={p}
          response={response}
          onRunNow={onRunNow}
          acceptLabel={apply ? apply.label : 'Accept selected'}
          onAccept={async (items) => {
            if (await acceptItems(p, items, apply)) setReviewing(false);
          }}
          onRegenerate={onRegenerate ? (hint) => (setReviewing(false), onRegenerate(hint)) : undefined}
          onDiscard={() => void call('ai.discardProposal', { id: p.id }).then(() => (setReviewing(false), useApp.getState().toast('Proposal discarded', 'info')), toastError)}
          onClose={() => setReviewing(false)}
        />
      )}
      {!live && turn.model && (
        <div className="flex items-center gap-2 text-xs text-muted">
          {apply && !p && (
            <Button size="sm" variant="primary" icon={<Check size={12} />} onClick={() => void use()} data-answer-apply>
              {apply.label}
            </Button>
          )}
          <span data-answer-model>
            <Badge tone="judge">
              <BookOpen size={10} /> {turn.provider} · {turn.model}
            </Badge>
          </span>
          <button className="inline-flex items-center gap-1 hover:text-fg" onClick={() => void copyText(turn.content, 'the answer')}>
            <Copy size={11} /> Copy
          </button>
        </div>
      )}
    </div>
  );
})
