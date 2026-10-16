import type { HistoryEntry } from './types.js';
import { ApsError } from '../errors.js';

export type HistoryKind = HistoryEntry['kind'];

/**
 * Every kind of History entry, and whether it is a request sent (counted in request statistics: Home's activity, the
 * slowest requests, `testpion history stats`, the MCP `activity` tool …) or not (a Debugger capture session). A new kind
 * must be classified here, or it does not compile.
 */
const KIND_IS_REQUEST = { http: true, graphql: true, grpc: true, mcp: true, llm: true, websocket: true, capture: false } as const satisfies Record<HistoryKind, boolean>;

/** The one list of History kinds: what `history list --kind`, MCP `history_list` and the `history.list` RPC accept. */
export const HISTORY_KINDS = Object.keys(KIND_IS_REQUEST) as HistoryKind[];

/** The History kinds that are requests sent (all but capture sessions). */
export const REQUEST_HISTORY_KINDS = HISTORY_KINDS.filter((k) => KIND_IS_REQUEST[k]);

export const isHistoryKind = (kind: unknown): kind is HistoryKind => typeof kind === 'string' && Object.prototype.hasOwnProperty.call(KIND_IS_REQUEST, kind);

/** Whether a History entry (or row with its kind) is a request sent, the only kind request statistics count. */
export const isRequestEntry = (entry: { kind?: string }): boolean => isHistoryKind(entry.kind) && KIND_IS_REQUEST[entry.kind];

/**
 * A History kind given by a caller (CLI `--kind`, MCP `history_list`, the `history.list` RPC): undefined when none is
 * given, else one of HISTORY_KINDS, else a ValidationError that lists them (an unknown kind is a mistake, not an empty list).
 */
export function historyKindOf(kind: unknown): HistoryKind | undefined {
  if (kind === undefined || kind === null || kind === '') return undefined;
  if (isHistoryKind(kind)) return kind;
  throw new ApsError('ValidationError', `Unknown History kind "${String(kind)}"`, { suggestions: [`Use one of: ${HISTORY_KINDS.join(', ')}`], details: { kind, valid: HISTORY_KINDS } });
}
