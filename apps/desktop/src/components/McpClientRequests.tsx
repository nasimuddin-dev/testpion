import { CodeBlock } from './CodeBlock';
import { MessageSquareText, Sparkles } from 'lucide-react';
import { useEffect, useState } from 'react';
import { call, on } from '../api';
import { toastError, useApp } from '../store';
import { JsonSchemaForm } from './JsonSchemaForm';
import { Badge, Button, Modal, Textarea } from './ui';

interface ClientRequest {
  id: string;
  serverId: string;
  serverName: string;
  kind: 'elicitation' | 'sampling';
  params: {
    message?: string;
    requestedSchema?: { properties?: Record<string, unknown>; required?: string[] };
    systemPrompt?: string;
    maxTokens?: number;
    messages?: Array<{ role: 'user' | 'assistant'; content: { type: string; text?: string } }>;
  };
}

/**
 * Requests an MCP server sends while you inspect it: elicitation (it asks you for input, with a form
 * built from its schema) and sampling (it asks for an LLM completion, which you write or draft with the
 * AI assistant and review before it is sent). One at a time, oldest first.
 */
export function McpClientRequests() {
  const [queue, setQueue] = useState<ClientRequest[]>([]);
  const [values, setValues] = useState<Record<string, unknown>>({});
  const [reply, setReply] = useState('');
  const [model, setModel] = useState<string>();
  const [drafting, setDrafting] = useState(false);
  const env = useApp((s) => s.environment);
  useEffect(() => {
    const a = on<ClientRequest>('mcp.clientRequest', (r) => setQueue((q) => [...q, r]));
    const b = on<{ id: string }>('mcp.clientRequestDone', ({ id }) => setQueue((q) => q.filter((x) => x.id !== id)));
    return () => {
      a();
      b();
    };
  }, []);
  const current = queue[0];
  useEffect(() => {
    setValues({});
    setReply('');
    setModel(undefined);
  }, [current?.id]);
  if (!current) return null;
  const respond = async (result: unknown) => {
    try {
      await call('mcp.clientRespond', { id: current.id, result });
    } catch (e) {
      toastError(e);
    }
    setQueue((q) => q.filter((x) => x.id !== current.id));
  };
  const missing = (current.params.requestedSchema?.required ?? []).filter((k) => values[k] === undefined || values[k] === '');
  if (current.kind === 'elicitation')
    return (
      <Modal
        title={`${current.serverName} asks for input`}
        onClose={() => void respond({ action: 'cancel' })}
        width={560}
        footer={
          <>
            <Button variant="ghost" onClick={() => void respond({ action: 'cancel' })}>
              Cancel
            </Button>
            <Button onClick={() => void respond({ action: 'decline' })}>Decline</Button>
            <Button variant="primary" disabled={missing.length > 0} title={missing.length ? `Required: ${missing.join(', ')}` : undefined} onClick={() => void respond({ action: 'accept', content: values })}>
              Accept
            </Button>
          </>
        }
      >
        <div className="flex items-center gap-2 mb-2">
          <Badge tone="accent">elicitation</Badge>
          <span className="text-xs text-muted">The server is waiting for your answer. Only give what you'd give this server.</span>
        </div>
        <p className="text-sm mb-2 whitespace-pre-wrap">{current.params.message}</p>
        <div className="border border-line rounded-md">
          <JsonSchemaForm schema={(current.params.requestedSchema ?? {}) as never} value={values} onChange={setValues} />
        </div>
      </Modal>
    );
  const draft = async () => {
    setDrafting(true);
    try {
      const r = await call<{ text: string; model: string }>('mcp.sampleDraft', { params: current.params, environment: env });
      setReply(r.text);
      setModel(r.model);
    } catch (e) {
      toastError(e);
    } finally {
      setDrafting(false);
    }
  };
  return (
    <Modal
      title={`${current.serverName} asks for an LLM completion`}
      onClose={() => void respond({ action: 'cancel' })}
      width={720}
      footer={
        <>
          <Button variant="ghost" onClick={() => void respond({ action: 'decline' })}>
            Decline
          </Button>
          <Button icon={<Sparkles size={13} />} loading={drafting} onClick={() => void draft()} title="Draft the reply with the AI assistant's model (Settings ▸ AI assistant); you can edit it before sending">
            Draft with AI
          </Button>
          <Button variant="primary" disabled={!reply.trim()} onClick={() => void respond({ text: reply, model: model ?? 'user' })}>
            Send reply
          </Button>
        </>
      }
    >
      <div className="flex items-center gap-2 mb-2">
        <Badge tone="accent">sampling</Badge>
        <span className="text-xs text-muted">Review what the server asks before anything is sent to a model.{current.params.maxTokens ? ` At most ${current.params.maxTokens} tokens.` : ''}</span>
      </div>
      {current.params.systemPrompt && (
        <div className="mb-2">
          <div className="text-xs text-muted mb-0.5">System prompt</div>
          <CodeBlock className="text-xs mono whitespace-pre-wrap bg-field rounded p-2 max-h-28 overflow-auto" text={current.params.systemPrompt} />
        </div>
      )}
      <div className="flex flex-col gap-1.5 max-h-52 overflow-auto mb-3">
        {(current.params.messages ?? []).map((m, i) => (
          <div key={i} className="text-sm flex gap-2">
            <MessageSquareText size={13} className="text-muted mt-0.5 shrink-0" />
            <span className="text-muted w-16 shrink-0">{m.role}</span>
            <span className="whitespace-pre-wrap min-w-0">{m.content.type === 'text' ? m.content.text : `[${m.content.type}]`}</span>
          </div>
        ))}
      </div>
      <div className="text-xs text-muted mb-0.5">Reply{model ? ` (drafted by ${model})` : ''}</div>
      <Textarea autoGrow={false} className="field w-full h-32 mono text-xs" aria-label="Reply" value={reply} onChange={(e) => setReply(e.target.value)} placeholder="Write the model's reply, or draft it with AI" />
    </Modal>
  );
}
