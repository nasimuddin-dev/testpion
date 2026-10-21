import { ragTrend, type RagTrendQuery } from '@testpion/core';
import type { Backend, Handlers } from '../backend.js';

/** RPC handlers of the metric trend across runs (`rag.trend`): the engine builds it, the window only draws it. */
export function ragTrendHandlers(be: Backend): Handlers {
  return {
    'rag.trend': (q: RagTrendQuery) => ragTrend(be.ws, q),
  };
}
