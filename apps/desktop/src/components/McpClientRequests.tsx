import { lazy, Suspense, useEffect, useState } from 'react';
import { on } from '../api';

// the dialog (with its schema form) loads when a server first asks something, not at startup
const McpClientRequestDialog = lazy(async () => ({ default: (await import('./McpClientRequestDialog')).McpClientRequestDialog }));

export interface ClientRequest {
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
  useEffect(() => {
    const a = on<ClientRequest>('mcp.clientRequest', (r) => setQueue((q) => [...q, r]));
    const b = on<{ id: string }>('mcp.clientRequestDone', ({ id }) => setQueue((q) => q.filter((x) => x.id !== id)));
    return () => {
      a();
      b();
    };
  }, []);
  const current = queue[0];
  if (!current) return null;
  return (
    <Suspense fallback={null}>
      <McpClientRequestDialog key={current.id} current={current} onDone={(id) => setQueue((q) => q.filter((x) => x.id !== id))} />
    </Suspense>
  );
}
