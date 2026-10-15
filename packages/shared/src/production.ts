/**
 * The production guard's shared vocabulary (WF-06): what a refused call would have done, how a refusal is recognised
 * on any side of the RPC (the window, the CLI, an MCP client), the question asked, and which requests change data.
 * The rule itself lives in core (net/production-guard.ts) and the backend (production-guard.ts).
 */

/** `details.code` of the error a refused production call carries. */
export const PRODUCTION_CONFIRMATION = 'PRODUCTION_CONFIRMATION';

/** What a refused call would have done ("Run 14 requests (5 change data) against Production?"). */
export interface ProductionAsk {
  /** The production environment's name. */
  environment: string;
  /** What would happen, as a short phrase: "Send POST Create a patient", "Run Veterinary API". */
  action: string;
  /** True when it changes data for certain (a POST, a mutation); false for a run whose requests are all reads. */
  changesData: boolean;
  /** A run: how many requests it has, and how many of them change data (when known). */
  requests?: number;
  changing?: number;
  /** A run (asked once for all its requests), not a single send. */
  run?: boolean;
}

const READ_METHODS = /^(GET|HEAD|OPTIONS|TRACE)$/i;

/** An HTTP method that may change data (anything but GET, HEAD, OPTIONS and TRACE; an unresolved {{method}} counts as changing). */
export function isDataChangingMethod(method: string | undefined): boolean {
  return !READ_METHODS.test(String(method ?? 'GET').trim() || 'GET');
}

/** The refusal's ask, when an error (thrown, or normalised and sent over RPC) is one. */
export function productionAskOf(e: unknown): ProductionAsk | undefined {
  const d = (e as { details?: Record<string, unknown> } | undefined)?.details;
  return d && d.code === PRODUCTION_CONFIRMATION && typeof d.environment === 'string' && typeof d.action === 'string' ? (d as unknown as ProductionAsk) : undefined;
}

/** The ask as one line: "Run Veterinary API (14 requests, 5 change data)". */
export function productionAskText(a: ProductionAsk): string {
  const counts = a.run && a.requests !== undefined ? ` (${a.requests} request${a.requests === 1 ? '' : 's'}${a.changing ? `, ${a.changing} change data` : ''})` : '';
  return `${a.action}${counts}`;
}
