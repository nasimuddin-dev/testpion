import { versionOf, speedOf, type Exchange } from './model';

/** The grid's columns (FG-12: built-ins, plus a header of the request or response as a column). */
export type BuiltInColumnId =
  | 'seq'
  | 'offset'
  | 'duration'
  | 'method'
  | 'version'
  | 'url'
  | 'status'
  | 'type'
  | 'size'
  | 'speed'
  | 'application'
  | 'domain'
  | 'ip'
  | 'user'
  | 'pid'
  | 'graphql'
  | 'ai'
  | 'comment'
  | 'caching'
  | 'encoding'
  | 'port'
  | 'protocol'
  | 'tls';
export type ColumnId = BuiltInColumnId | `h:${string}`;

export interface Column {
  id: ColumnId;
  label: string;
  width: number;
  /** Grows to fill the row (the URL). */
  grow?: boolean;
  align?: 'right';
  sort(e: Exchange): string | number;
}

/** A header the person turned into a column. */
export interface HeaderColumnDef {
  name: string;
  side: 'request' | 'response';
}

export const headerKey = (c: HeaderColumnDef) => `${c.side}:${c.name.toLowerCase()}`;
export const headerColumnId = (c: HeaderColumnDef): ColumnId => `h:${headerKey(c)}`;
export const MAX_HEADER_COLUMNS = 8;

const protocolOf = (e: Exchange) => (e.kind === 'tunnel' ? 'tunnel' : e.kind === 'websocket' ? (e.url.startsWith('wss:') ? 'wss' : 'ws') : e.url.startsWith('https:') ? 'https' : e.url.startsWith('http:') ? 'http' : '');
const tlsOf = (e: Exchange) => (e.tls ? 'decrypted' : e.kind === 'tunnel' ? 'tunnel' : e.url.startsWith('https:') ? 'yes' : '');

export const COLUMNS: Column[] = [
  { id: 'seq', label: '#', width: 48, align: 'right', sort: (e) => e.seq ?? 0 },
  { id: 'offset', label: 'Offset (s)', width: 72, align: 'right', sort: (e) => e.offsetSec ?? 0 },
  { id: 'duration', label: 'Duration (s)', width: 80, align: 'right', sort: (e) => e.durationMs ?? -1 },
  { id: 'method', label: 'Method', width: 64, sort: (e) => e.method },
  { id: 'version', label: 'Version', width: 72, sort: (e) => versionOf(e) },
  { id: 'url', label: 'URL', width: 280, grow: true, sort: (e) => e.url },
  { id: 'status', label: 'Status', width: 72, align: 'right', sort: (e) => e.status ?? (e.error ? 999 : -1) },
  { id: 'type', label: 'Type', width: 140, sort: (e) => e.contentType ?? '' },
  { id: 'size', label: 'Size (KB)', width: 72, align: 'right', sort: (e) => e.responseBodyBytes },
  { id: 'speed', label: 'Speed (KB/s)', width: 88, align: 'right', sort: (e) => Number(speedOf(e)) || 0 },
  { id: 'application', label: 'Application', width: 110, sort: (e) => e.application ?? '' },
  { id: 'domain', label: 'Domain', width: 150, sort: (e) => e.host },
  { id: 'ip', label: 'IP address', width: 140, sort: (e) => e.serverAddress ?? '' },
  { id: 'user', label: 'User', width: 120, sort: (e) => e.user ?? '' },
  { id: 'pid', label: 'PID', width: 60, align: 'right', sort: (e) => e.pid ?? 0 },
  { id: 'graphql', label: 'GraphQL operation', width: 170, sort: (e) => e.graphql ?? '' },
  { id: 'ai', label: 'AI call', width: 190, sort: (e) => e.ai ?? '' },
  { id: 'comment', label: 'Comments', width: 200, sort: (e) => e.note ?? '' },
  { id: 'caching', label: 'Caching', width: 160, sort: (e) => e.caching ?? '' },
  { id: 'encoding', label: 'Content-Encoding', width: 120, sort: (e) => e.contentEncoding ?? '' },
  { id: 'port', label: 'Client port', width: 80, align: 'right', sort: (e) => e.clientPort },
  { id: 'protocol', label: 'Protocol', width: 80, sort: (e) => protocolOf(e) },
  { id: 'tls', label: 'TLS', width: 90, sort: (e) => tlsOf(e) },
];

/** What the new built-in columns show as plain text (the cells that need markup are drawn in DebuggerGrid). */
export const plainCell = (id: BuiltInColumnId, e: Exchange): string | undefined =>
  id === 'caching' ? e.caching : id === 'encoding' ? e.contentEncoding : id === 'port' ? String(e.clientPort || '') : id === 'protocol' ? protocolOf(e) : id === 'tls' ? tlsOf(e) : undefined;

/** The column a header becomes. */
export const headerColumn = (c: HeaderColumnDef): Column => ({ id: headerColumnId(c), label: `${c.name} (${c.side})`, width: 140, sort: (e) => e.headerValues?.[headerKey(c)] ?? '' });

// Comments is shown the first time a note is added (the row menu does it)
export const DEFAULT_HIDDEN: ColumnId[] = ['pid', 'comment', 'graphql', 'ai'];
/** Columns added after people had chosen theirs: shown only when asked for (kept in their own list, so a saved choice of hidden columns does not switch them on). */
export const OPTIONAL_COLUMNS: ColumnId[] = ['caching', 'encoding', 'port', 'protocol', 'tls'];
export const EXTRA_KEY = 'testpion.debugger.extraColumns';
/** Is the column on screen, given the hidden list (older columns) and the extras list (optional ones)? */
export const columnShown = (id: ColumnId, hidden: readonly ColumnId[], extra: readonly ColumnId[]) => (OPTIONAL_COLUMNS.includes(id) ? extra.includes(id) : !hidden.includes(id));
export const HIDDEN_KEY = 'testpion.debugger.hiddenColumns';
export const parseHidden = (raw: string): ColumnId[] | undefined => {
  const v = JSON.parse(raw) as unknown;
  return Array.isArray(v) ? (v as ColumnId[]) : undefined;
};
