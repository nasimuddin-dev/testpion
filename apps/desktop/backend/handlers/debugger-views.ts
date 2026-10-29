/** The Debugger's content views (FG-8, 10, 19, 20) for the window: the shared readers run on the raw exchange, and what they return passes the redactor. */
import { aiLabelOf, exchangeView, EXCHANGE_VIEWS, type ExchangeViewName, type ExchangeViewResult } from '@testpion/shared';
import { ApsError, type DebuggerExchange } from '@testpion/core';
import type { Backend } from '../backend.js';

/** An exchange as the readers take it: the real bodies (a decoder must see the bytes), not the masked copy the window shows. */
export function runExchangeView(be: Backend, e: DebuggerExchange, view: string, side: string | undefined): ExchangeViewResult {
  if (!(EXCHANGE_VIEWS as readonly string[]).includes(view)) throw new ApsError('ValidationError', `Unknown view "${view}": ${EXCHANGE_VIEWS.join(', ')}`);
  // what was decoded from the body is masked like any body: a token inside a MessagePack map must not reach the screen
  return exchangeView(e, view as ExchangeViewName, side === 'request' ? 'request' : 'response', be.logger.redactor);
}

/** AI calls (LLM and MCP) get `ai: "OpenAI gpt-4o"` for the list. A cheap check on the address and the start of the body first. */
export function aiRowOf(e: DebuggerExchange): { ai?: string } {
  if (e.kind !== 'http' || !e.requestBody) return {};
  const label = aiLabelOf({ method: e.method, url: e.url, host: e.host, requestHeaders: e.requestHeaders, requestBody: e.requestBody });
  return label ? { ai: label } : {};
}
