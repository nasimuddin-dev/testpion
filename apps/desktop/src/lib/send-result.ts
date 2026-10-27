import type { HttpResponseData } from '../types';

/** The same limits the engine keeps for a response's events (protocols/http/client.ts): the stream itself can be endless. */
const MAX_EVENTS = 10_000;
const MAX_EVENT_CHARS = 32 * 1024 * 1024;

/** The events of the sends in progress, as `http.sse` delivers them: kept to the engine's limits, and handed to the finished result. */
export interface LiveEvents {
  events: unknown[];
  chars: number;
}

/** Add streamed events to a send's list; what is beyond the engine's limits is not kept (the list was unbounded). Returns true when anything was kept. */
export function pushLiveEvents(live: LiveEvents | undefined, items: Array<{ data?: string }>): LiveEvents {
  const out = live ?? { events: [], chars: 0 };
  for (const ev of items) {
    if (out.events.length >= MAX_EVENTS || out.chars >= MAX_EVENT_CHARS) break;
    out.events.push(ev);
    out.chars += ev.data?.length ?? 0;
  }
  return out;
}

/**
 * The response as the views read it. The backend sends the body once (`slimSendResult`): when `jsonInPreview` is set the parsed
 * tree is made here from the complete preview text, and the events that were streamed are the ones kept while the request ran.
 */
export function rehydrateResponse<T extends { response?: HttpResponseData & { jsonInPreview?: boolean; eventsStreamed?: number } }>(result: T, live?: LiveEvents): T {
  const res = result?.response;
  if (!res || (!res.jsonInPreview && res.eventsStreamed === undefined)) return result;
  const out: Record<string, unknown> = { ...res };
  if (res.jsonInPreview) {
    try {
      out.json = JSON.parse(res.bodyPreview);
    } catch {
      /* the text was not JSON after all: the raw views show it */
    }
    delete out.jsonInPreview;
  }
  if (res.eventsStreamed !== undefined) {
    out.events = live?.events ?? [];
    delete out.eventsStreamed;
  }
  return { ...result, response: out as unknown as HttpResponseData };
}
