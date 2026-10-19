import { base64ToBytes, extensionForMime, jsonLines, jsonPretty, outputFileName, safeDownloadName } from '@testpion/shared';
import type { OutputFormatSpec, OutputSpec } from './output-core';

/** What can be downloaded from the MCP view besides tool results: a resource read, a prompt's messages, the protocol trace. */

/** One content item of a resource read. */
export interface ResourceContent {
  uri: string;
  mimeType?: string;
  text?: string;
  blob?: string;
}

/** A resource read: each content item as the file it is (text as text, a blob as its bytes), under the server's mime type. */
export function resourceOutputSpec(server: string, contents: ResourceContent[]): OutputSpec {
  const name = (c: ResourceContent) => {
    const last = c.uri.replace(/[?#].*$/, '').split(/[/:]/).filter(Boolean).pop() || 'resource';
    const given = /\.\w{1,16}$/.test(last) ? last : `${last}.${extensionForMime(c.mimeType ?? (c.blob ? 'application/octet-stream' : 'text/plain'))}`;
    return safeDownloadName(given, c.mimeType ?? '');
  };
  const formats: OutputFormatSpec[] = contents
    .filter((c) => c.text !== undefined || c.blob !== undefined)
    .map((c, i) => ({
      key: `content-${i}`,
      format: 'raw' as const,
      label: `${contents.length > 1 ? `${name(c)} ` : ''}${c.blob !== undefined ? 'bytes' : 'text'}${c.mimeType ? ` (${c.mimeType})` : ''}`.trim(),
      fileName: name(c),
      build: () => (c.blob !== undefined ? base64ToBytes(c.blob) : c.text!),
    }));
  return { id: 'mcp.resource', what: 'resource', name: outputFileName({ name: `${server}-resource`, ext: '' }), formats, empty: formats.length ? undefined : 'This resource has no content' };
}

/** A prompt's messages: the JSON the server returned, or the conversation as Markdown. */
export function promptOutputSpec(server: string, prompt: string, out: { messages: unknown[]; description?: string }): OutputSpec {
  const messages = out.messages as Array<{ role: string; content?: { text?: string; resource?: { uri: string; text?: string } } }>;
  return {
    id: 'mcp.prompt',
    what: 'prompt',
    name: outputFileName({ name: `${server}-${prompt}`, ext: '' }),
    formats: [
      { key: 'json', format: 'json', label: 'Messages (JSON)', default: true, build: () => jsonPretty(out) },
      {
        key: 'md',
        format: 'md',
        label: 'Conversation (Markdown)',
        build: () =>
          `# ${prompt}\n\n${out.description ? `${out.description}\n\n` : ''}${messages.map((m) => `## ${m.role}\n\n${m.content?.text ?? m.content?.resource?.text ?? JSON.stringify(m.content, null, 2)}\n`).join('\n')}`,
      },
    ],
  };
}

/** One message of the protocol trace as the trace panel keeps it. */
export interface TraceEvent {
  timestamp: number;
  direction: string;
  method: string;
  kind: string;
  rpcId?: unknown;
  durationMs?: number;
  request?: unknown;
  response?: unknown;
  error?: unknown;
  metadata?: unknown;
}

/** The protocol trace shown (the filter applies): a JSON-RPC log line per message, secrets masked by the backend. */
export function traceOutputSpec(server: string, events: TraceEvent[]): OutputSpec {
  return {
    id: 'mcp.trace',
    what: 'protocol trace',
    name: outputFileName({ name: `${server}-mcp-trace`, ext: '' }),
    formats: [
      {
        format: 'jsonl',
        label: 'JSON-RPC log (JSON Lines)',
        build: () =>
          jsonLines(
            events.map((e) => ({
              timestamp: new Date(e.timestamp).toISOString(),
              direction: e.direction,
              method: e.method,
              kind: e.kind,
              rpcId: e.rpcId,
              durationMs: e.durationMs,
              request: e.request,
              response: e.response,
              error: e.error,
              metadata: e.metadata,
            })),
          ),
      },
    ],
    empty: events.length ? undefined : 'No messages yet',
  };
}
