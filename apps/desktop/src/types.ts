// The engine's types, from core (type-only: the window never loads core at run time); what the window adds is here.
export type { AuthConfig, BodyConfig, HttpSettings, HttpRequestSpec, CheckConfig, CheckResult, HttpResponseData, SavedExample, SavedHttpRequest, SavedGraphQLRequest, CollectionFolder, CollectionNode, Environment, Span, Trace, TestResult, LatencyStats, RunSummary, PriceEntry, AppSettings, LibraryItem } from '@testpion/core';
import type { Collection as CoreCollection, Environment, Library as CoreLibrary, McpServerConfig as CoreMcpServerConfig, ProviderConfig as CoreProviderConfig } from '@testpion/core';

/** A collection as listed: a file that failed to parse comes with `problem` instead of its contents. */
export type Collection = CoreCollection & { problem?: string };
/** A server as the MCP view lists it: whether this window has a session open to it. */
export type McpServerConfig = CoreMcpServerConfig & { connected?: boolean };
/** A provider as listed: whether a key is saved for it, and whether it is the app's built-in one (Settings ▸ AI assistant). */
export type ProviderConfig = CoreProviderConfig & { hasKey?: boolean; builtIn?: boolean };
/** A library as the window builds it (an empty one has no schema version yet). */
export type Library<T = unknown> = Omit<CoreLibrary<T>, 'schemaVersion'> & { schemaVersion?: string };
import type { KeyValue as SharedKeyValue } from '@testpion/shared';
/** The engine's row, plus what the editors add (a secret flag, a file field). */
export interface KeyValue extends SharedKeyValue {
  secret?: boolean;
  kind?: 'text' | 'file';
}

export interface SseEvent {
  event: string;
  data: string;
  id?: string;
  retry?: number;
  /** Milliseconds from the start of the request. */
  atMs: number;
}

export interface WorkspaceCurrent {
  id: string;
  name: string;
  description?: string;
  variables: KeyValue[];
  path: string;
  environments: Environment[];
  migrations: string[];
}

