/**
 * The typed side of the RPC contract. `rpc-params.generated.ts` (generated from the backend's parameter tables) types the
 * parameters of every method; `RpcResults` types what the most used methods answer, so `call('col.get', { id })` is a
 * `Collection` without a cast. Methods without a result type here answer `any` through `call`'s fallback until they get one:
 * adding a line to `RpcResults` is all it takes (the compiler then checks every call site of that method).
 */
import type { AppSettings, CollectionTree, StoredCookie, McpServerConfig, WorkspaceManager, WorkspaceStore, listSpecs } from '@testpion/core';
import type { RpcParamTypes } from './rpc-params.generated';

/** What `app.info` answers. */
export interface AppInfo {
  version: string;
  /** The version of the RPC contract this engine speaks: a window checks it when it connects (RPC_VERSION in @testpion/shared). */
  rpcVersion: number;
  nativeDialogs: boolean;
  platform: string;
  appDir: string;
  secretBackend: string;
  metaBackend?: string;
  checkTypes: string[];
  appVersion?: string;
  packaged?: boolean;
  canUpdateInPlace?: boolean;
  node: string;
  electron?: string;
  capabilities: { shell: boolean; localFiles: boolean };
}

type Meta = WorkspaceStore['meta'];

export interface RpcResults {
  'app.info': AppInfo;
  'settings.get': AppSettings;
  'rpc.cancel': boolean;
  'ws.list': ReturnType<WorkspaceManager['list']>;
  'col.list': ReturnType<WorkspaceStore['listCollections']>;
  'col.get': ReturnType<WorkspaceStore['getCollection']>;
  'col.tree': Array<CollectionTree | undefined>;
  'env.list': ReturnType<WorkspaceStore['listEnvironments']>;
  'lib.get': ReturnType<WorkspaceStore['getLibrary']>;
  'history.list': ReturnType<Meta['listHistory']>;
  'runs.list': ReturnType<Meta['listRuns']>;
  'tests.tree': ReturnType<WorkspaceStore['testTree']>;
  'tests.read': ReturnType<WorkspaceStore['readTestFile']>;
  'tests.write': ReturnType<WorkspaceStore['writeTestFile']>;
  'openapi.specs': ReturnType<typeof listSpecs>;
  'cookies.list': { cookies: StoredCookie[]; persistent: boolean };
  'mcp.servers': Array<McpServerConfig & { connected: boolean }>;
  'http.cancel': void;
  'ai.cancel': void;
  'grpc.cancel': void;
  'load.stop': void;
  'console.recent': unknown[];
  'logs.recent': unknown[];
  'stats.activity': ReturnType<Meta['activity']>;
  'stats.requests': ReturnType<Meta['requestStats']>;
}

/** The methods whose answer is typed. */
export type TypedRpcMethod = keyof RpcResults;

/** The parameters of a method: its table entry, or (a method that predates the table: tests/fixtures/rpc-params-without-entry.txt) any object. */
export type RpcParamsOf<M extends string> = M extends keyof RpcParamTypes ? RpcParamTypes[M] : Record<string, any> | undefined;

/** Every method of the table with its parameters and answer. */
export type RpcMethods = { [M in keyof RpcParamTypes]: { params: RpcParamTypes[M]; result: M extends keyof RpcResults ? RpcResults[M] : unknown } };
