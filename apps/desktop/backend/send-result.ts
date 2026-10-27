/**
 * What the window gets back from a send. The body travels once: `bodyPreview` is the complete text, so a parsed copy (`json`, as large
 * as the text again, and structured-cloned over the channel) is left out and flagged `jsonInPreview`; the window parses the preview
 * when it needs the tree. The server-sent events were already streamed on `http.sse` as they arrived; the window keeps them and the
 * final result carries only their number (`eventsStreamed`; the HTTP editor, which receives them, asks for it). The engine, scripts, history and the CLI still see the full response:
 * this runs on the way out of the RPC handler only.
 */
export function slimSendResult<T>(result: T, o: { events?: boolean } = { events: true }): T {
  const r = result as { response?: Record<string, unknown> } | undefined;
  const res = r?.response;
  if (!res || typeof res !== 'object') return result;
  const slim: Record<string, unknown> = { ...res };
  if (slim.json !== undefined && !slim.truncated && typeof slim.bodyPreview === 'string' && slim.bodyPreview.length > 0) {
    delete slim.json;
    slim.jsonInPreview = true;
  }
  if (o.events && Array.isArray(slim.events)) {
    slim.eventsStreamed = slim.events.length;
    delete slim.events;
  }
  return { ...(r as object), response: slim } as T;
}
