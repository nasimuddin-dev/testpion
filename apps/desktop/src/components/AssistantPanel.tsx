import { BookOpen, Bot, Check, Copy, Paperclip, RotateCcw, Square, X } from 'lucide-react';
import { memo, useEffect, useRef, useState } from 'react';
import { extractCodeBlock } from '@testpion/shared';
import { asError, call, on } from '../api';
import { currentViewContext, type ViewContext } from '../lib/assistant-context';
import { useApp, type AssistantRequest } from '../store';
import { Markdown } from './Markdown';
import { AiGeneratedNotice, ErrorPanel } from './Results';
import { Badge, Button, cx, IconButton, Input, Spinner } from './ui';
import { copyText } from '../lib/clipboard';

interface Turn {
  role: 'user' | 'assistant';
  content: string;
  /** The first turn of a task (Explain this response, …): sent, but shown as the task's title. */
  task?: boolean;
  provider?: string;
  model?: string;
}

/**
 * The AI assistant drawer: a conversation about the task it was opened for (or a free question with the context of the
 * current view). Follow-ups remember the conversation; answers stream and can be stopped. Output is always labelled
 * as an AI-generated suggestion.
 */
export function AssistantPanel() {
  const req = useApp((s) => s.assistant)!;
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
  const ask = async (q?: string, fresh = false) => {
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
      const r = await call<{ text: string; provider: string; model: string }>('assistant.ask', { task: req.task, context, question: text, environment: env, history, requestId: id });
      if (mine !== conversation.current) return;
      setTurns((t) => [...t, { role: 'assistant', content: r.text, provider: r.provider, model: r.model }]);
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

  const stop = () => busy && void call('ai.cancel', { id: busy });
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
  const notSetUp = error && /AI assistant is off|No Claude API key|No AI provider/.test(error.message);

  return (
    <aside
      className="w-[420px] shrink-0 border-l border-line bg-bg flex flex-col"
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
        <IconButton label="New conversation" className="ml-auto" onClick={restart} disabled={!turns.length && !error}>
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
            <Answer key={i} turn={t} apply={req.apply} />
          ),
        )}
        {busy && (streaming ? <Answer turn={{ role: 'assistant', content: streaming }} live /> : (
          <div className="flex items-center gap-2 text-muted">
            <Spinner /> Thinking…
          </div>
        ))}
        {notSetUp ? (
          <div className="rounded-xl border border-line bg-panel p-4 flex flex-col gap-2">
            <div className="font-medium">Set up the AI assistant</div>
            <p className="text-sm text-muted">Save your Claude (Anthropic) API key in Settings, or choose a provider of this workspace such as a local model. The key is kept in the OS secret store.</p>
            <div>
              <Button variant="primary" size="sm" onClick={() => (useApp.getState().set({ assistant: undefined }), useApp.getState().openIntent('settings', { tab: 'assistant' }))}>
                Open Settings ▸ AI assistant
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

/** One answer: Markdown, each code block with its own Copy button, the model that wrote it, and Apply when the task has one. */
const Answer = memo(function Answer({ turn, live, apply }: { turn: Turn; live?: boolean; apply?: AssistantRequest['apply'] }) {
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
      {!live && turn.model && (
        <div className="flex items-center gap-2 text-xs text-muted">
          {apply && (
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
