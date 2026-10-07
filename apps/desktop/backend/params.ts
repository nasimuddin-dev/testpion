import type { CheckConfig, GraphQLRequestSpec, HttpRequestSpec, ResponseFormat } from '@testpion/core';

/** The parameters of the backend's bigger calls (sending a request, a GraphQL operation, an AI chat, runs). */
export interface CollectionRunParams {
  collectionId: string;
  /** Folder and/or request ids; empty runs the whole collection. */
  selection?: string[];
  environment?: string;
  iterations?: number;
  /** CSV / JSON file with one row per iteration. */
  dataPath?: string;
  /** SQL for a SQLite data file (read-only). */
  dataQuery?: string;
  delayMs?: number;
  bail?: boolean;
  /** Save variables set by scripts as current values (Postman's "Keep variable values"). Default true. */
  keepVariableValues?: boolean;
  name?: string;
}

export interface HttpSendParams {
  id?: string;
  name?: string;
  request: HttpRequestSpec;
  environment?: string;
  collectionId?: string;
  requestId?: string;
  preRequestScript?: string;
  testScript?: string;
  assertions?: CheckConfig[];
  stream?: boolean;
}

export interface GqlSendParams {
  id?: string;
  request: GraphQLRequestSpec;
  environment?: string;
  collectionId?: string;
  /** The saved request, for folder scripts and pm.info. */
  requestId?: string;
  name?: string;
  operationName?: string;
  assertions?: CheckConfig[];
  preRequestScript?: string;
  testScript?: string;
}

export interface AiChatParams {
  requestId?: string;
  provider: string;
  model: string;
  system?: string;
  prompt: string;
  input?: Record<string, unknown>;
  temperature?: number;
  topP?: number;
  maxTokens?: number;
  seed?: number;
  responseFormat?: ResponseFormat;
  stream?: boolean;
  environment?: string;
  evaluators?: CheckConfig[];
  expected?: unknown;
}

export interface EvalRunParams {
  name?: string;
  template: Record<string, unknown>;
  datasetText?: string;
  datasetFormat?: 'jsonl' | 'json' | 'csv' | 'md';
  datasetPath?: string;
  expectedField?: string;
  limit?: number;
  concurrency?: number;
  retries?: number;
  environment?: string;
}
