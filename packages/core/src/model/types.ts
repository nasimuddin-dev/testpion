/**
 * Core domain model for TestPion.
 *
 * Everything persisted to disk or exchanged between the engine, the desktop UI and
 * the CLI is described here. Types are intentionally plain JSON-serialisable data.
 */

export const SCHEMA_VERSION = '1.0';

export type { KeyValue } from '@testpion/shared';
import type { KeyValue } from '@testpion/shared';

/* ------------------------------------------------------------------ auth */

export type AuthConfig =
  | { type: 'none' }
  | { type: 'inherit' }
  | { type: 'apiKey'; key: string; value: string; in: 'header' | 'query' }
  | { type: 'basic'; username: string; password: string }
  | { type: 'bearer'; token: string; prefix?: string }
  | {
      type: 'jwt';
      secret: string;
      algorithm?: 'HS256' | 'HS384' | 'HS512';
      /** JSON payload (templated). `iat`/`exp` are added when `expiresInSec` is set. */
      payload: string;
      expiresInSec?: number;
      prefix?: string;
    }
  | {
      type: 'oauth2';
      grantType: 'client_credentials' | 'password' | 'authorization_code';
      tokenUrl: string;
      authUrl?: string;
      clientId: string;
      clientSecret?: string;
      scope?: string;
      audience?: string;
      username?: string;
      password?: string;
      usePkce?: boolean;
      redirectPort?: number;
      /** Callback URL registered with the provider, e.g. http://localhost:8080/oauth/callback (a loopback address). Default: http://127.0.0.1:<any port>/callback */
      redirectUri?: string;
      /** How the client id and secret are sent to the token URL: in the form body (default) or as an HTTP Basic header. */
      clientAuth?: 'body' | 'header';
    }
  | { type: 'headers'; headers: KeyValue[] }
  /** HTTP Digest (RFC 7616): the first request gets the server's challenge, the second answers it. */
  | { type: 'digest'; username: string; password: string }
  /** AWS Signature Version 4 (API Gateway, S3, Lambda URLs, any AWS API). */
  | { type: 'awsv4'; accessKey: string; secretKey: string; sessionToken?: string; region: string; service: string }
  /** OAuth 1.0a (RFC 5849), signed per request. */
  | { type: 'oauth1'; consumerKey: string; consumerSecret: string; token?: string; tokenSecret?: string; signatureMethod?: 'HMAC-SHA1' | 'HMAC-SHA256' | 'PLAINTEXT'; realm?: string; addTo?: 'header' | 'query' };

/* ------------------------------------------------------------------ http */

export type BodyConfig =
  | { type: 'none' }
  | { type: 'json' | 'xml' | 'text' | 'html'; content: string }
  | { type: 'form-urlencoded'; fields: KeyValue[] }
  | { type: 'multipart'; fields: Array<KeyValue & { kind?: 'text' | 'file'; contentType?: string }> }
  | { type: 'binary'; filePath: string; contentType?: string };

export interface HttpSettings {
  timeoutMs?: number;
  followRedirects?: boolean;
  maxRedirects?: number;
  /** Disable TLS verification (development only). */
  insecure?: boolean;
  proxy?: string;
  clientCert?: { certPath: string; keyPath: string; caPath?: string; passphrase?: string };
  /** Maximum number of body bytes kept in memory for preview. The full body is streamed to disk. */
  maxPreviewBytes?: number;
  /**
   * Retry a failed attempt this many times (0–5): network errors, timeouts, 429 and 5xx for safe methods;
   * POST and PATCH only when the connection failed (the server may have acted otherwise).
   */
  retries?: number;
  /** First wait between attempts in ms (doubles each time, max 10 s; Retry-After wins). Default 500. */
  retryDelayMs?: number;
  /** Use HTTP/1.1 only. By default HTTP/2 is offered over https (ALPN) and used when the server supports it. */
  http1Only?: boolean;
  /** On a 301/302 redirect keep the original method and body (by default POST becomes GET; 303 is always GET). */
  followOriginalMethod?: boolean;
  /** Keep the Authorization header when a redirect goes to another host (by default it's removed). */
  followAuthorizationHeader?: boolean;
  /** Remove the Referer header from redirected requests. */
  removeRefererOnRedirect?: boolean;
  /** Percent-encode the URL's query and path variable values (default true). Off sends them as typed, apart from characters that can't be sent at all (spaces, non-ASCII). */
  encodeUrl?: boolean;
  /** Don't send cookies from the workspace cookie jar and don't store this request's cookies in it. */
  disableCookieJar?: boolean;
  /** Oldest / newest TLS version to negotiate (Postman's "TLS protocols disabled during handshake"). */
  tlsMinVersion?: TlsVersion;
  tlsMaxVersion?: TlsVersion;
  /** OpenSSL cipher list for the handshake, in order of preference, e.g. `ECDHE-RSA-AES128-GCM-SHA256:ECDHE-RSA-AES256-GCM-SHA384`. */
  ciphers?: string;
}

export type TlsVersion = 'TLSv1' | 'TLSv1.1' | 'TLSv1.2' | 'TLSv1.3';

export interface HttpRequestSpec {
  method: string;
  url: string;
  params?: KeyValue[];
  /** Values for `:name` segments in the URL path (Postman path variables). */
  pathVariables?: KeyValue[];
  /** Free-form documentation shown in collection docs. */
  description?: string;
  headers?: KeyValue[];
  cookies?: KeyValue[];
  auth?: AuthConfig;
  body?: BodyConfig;
  settings?: HttpSettings;
}

export interface TimelinePhase {
  name: string;
  startMs: number;
  durationMs: number;
}

export interface HttpResponseData {
  status: number;
  statusText: string;
  /** How many attempts it took (when the request has retries). */
  attempts?: number;
  /** The HTTP version the response came over: "1.1" or "2". */
  httpVersion?: string;
  headers: Array<[string, string]>;
  cookies: Array<{ name: string; value: string; attributes: Record<string, string> }>;
  /** Body preview (UTF-8 decoded, possibly truncated). */
  bodyPreview: string;
  truncated: boolean;
  /** Total body size in bytes. */
  size: number;
  contentType: string;
  /** Path on disk of the full payload when persisted. */
  payloadPath?: string;
  durationMs: number;
  timeline: TimelinePhase[];
  /** The connection the request went over: reused from the pool or new (then the timeline has DNS / TCP / TLS), its peer and TLS version. */
  connection?: {
    reused: boolean;
    remoteAddress?: string;
    remotePort?: number;
    tlsProtocol?: string;
    cipher?: string;
    /** HTTPS: the server's certificate (subject, issuer, validity and days left). */
    certificate?: { subject?: string; issuer?: string; validFrom?: string; validTo?: string; daysLeft?: number; altNames?: string[]; fingerprint256?: string };
  };
  /** Final URL (after redirects) with secrets redacted. */
  url: string;
  redirected: boolean;
  /** Parsed JSON body when the preview is complete and parses. */
  json?: unknown;
  /** Server-Sent Events of a text/event-stream response, in arrival order. */
  events?: Array<{ event: string; data: string; id?: string; retry?: number; atMs: number }>;
  /** Events not kept because the stream exceeded the limit. */
  eventsDropped?: number;
  /** The stream was stopped by the user (the response holds what arrived until then). */
  streamStopped?: boolean;
}

/* ------------------------------------------------------------------ graphql */

export interface GraphQLRequestSpec {
  endpoint: string;
  query: string;
  variables?: string | Record<string, unknown>;
  operationName?: string;
  headers?: KeyValue[];
  auth?: AuthConfig;
  settings?: HttpSettings;
}

/* ------------------------------------------------------------------ mcp */

export type McpTransportConfig =
  | { transport: 'stdio'; command: string; args?: string[]; env?: Record<string, string>; cwd?: string }
  | { transport: 'streamable-http'; url: string; headers?: KeyValue[] }
  | { transport: 'sse'; url: string; headers?: KeyValue[] }
  /** An MCP mock running in-process from a definition file (`mocks/*.mcp-mock.yaml`, relative to the workspace). */
  | { transport: 'mock'; mockFile: string };

export type McpServerConfig = { id: string; name: string; /** Folder in the MCP view's server list. */ folder?: string } & McpTransportConfig;

/* ------------------------------------------------------------------ ai */

export type ProviderKind = 'openai-compatible' | 'azure-openai' | 'anthropic' | 'gemini' | 'bedrock' | 'ollama' | 'mock';

export interface RateLimitConfig {
  requestsPerSecond?: number;
  requestsPerMinute?: number;
  tokensPerMinute?: number;
  concurrency?: number;
}

export interface ProviderConfig {
  id: string;
  name: string;
  kind: ProviderKind;
  baseUrl: string;
  /** Template or secret reference, e.g. `{{$secret.provider.openai.apiKey}}` or `{{$env.OPENAI_API_KEY}}`. Never a literal key on disk. */
  apiKey?: string;
  defaultModel?: string;
  embeddingModel?: string;
  /** Azure OpenAI api-version, Anthropic version header, etc. */
  apiVersion?: string;
  /** AWS region (Amazon Bedrock); defaults to the one in the base URL. */
  region?: string;
  headers?: KeyValue[];
  rateLimit?: RateLimitConfig;
  timeoutMs?: number;
}

export interface ModelRef {
  /** Provider id, provider name, or provider kind. */
  provider: string;
  name?: string;
  temperature?: number;
  topP?: number;
  maxTokens?: number;
  seed?: number;
}

export interface PriceEntry {
  /** Provider kind or id; `*` matches any. */
  provider: string;
  /** Exact model name or a glob with `*`. */
  model: string;
  inputPerMillion: number;
  outputPerMillion: number;
  currency?: string;
  /** Version / effective date so reports record which price table was used. */
  version: string;
}

/* ------------------------------------------------------------------ checks */

/**
 * A check is an assertion (deterministic) or an evaluator (heuristic, semantic or AI judge).
 * Every check result records its `source` so AI-generated judgements are never confused
 * with deterministic results.
 */
export interface CheckConfig {
  type: string;
  name?: string;
  path?: string;
  expected?: unknown;
  [option: string]: unknown;
}

export type CheckSource = 'deterministic' | 'heuristic' | 'semantic' | 'ai-judge';

export interface CheckResult {
  type: string;
  name: string;
  passed: boolean;
  source: CheckSource;
  score?: number;
  message: string;
  expected?: unknown;
  actual?: unknown;
  explanation?: string;
  metadata?: Record<string, unknown>;
}

/* ------------------------------------------------------------------ tests */

export type TestType = 'http' | 'graphql' | 'grpc' | 'websocket' | 'mcp' | 'llm' | 'rag' | 'agent' | 'delay' | 'condition' | 'script' | 'flow' | 'log';

/** `forEach:` of a step: an inline list of rows, or `{ dataset: path }` (CSV, JSON, JSONL, Markdown; relative to the test file). */
export type ForEachSpec = unknown[] | { dataset: string; limit?: number };

export interface TestBase {
  id?: string;
  name: string;
  type: TestType;
  description?: string;
  tags?: string[];
  skip?: boolean;
  timeoutMs?: number;
  retries?: number;
  dependsOn?: string[];
  variables?: Record<string, unknown>;
  preRequestScript?: string;
  testScript?: string;
  /** For requests run from a collection: collection, folder and request names (tp.execution.location). */
  location?: string[];
  /** Extract values from the result body into runtime variables: `{ token: "$.access_token" }`. */
  extract?: Record<string, string>;
  assertions?: CheckConfig[];
  evaluators?: CheckConfig[];
  /** Source file this test was loaded from (set by the loader). */
  file?: string;
  /** Run the step only when this expression is true (`status == 200 && {{count}} > 0`); else it is skipped with the reason. */
  if?: string;
  /** A branch of a condition step it depends on: runs when the condition came out true (or false); else it is skipped. */
  when?: boolean;
  /** Run the step this many times ({{$index}} is 0, 1, …). */
  repeat?: number;
  /** Run the step once per row: the row's fields, {{$index}} and {{$item}} are its variables. */
  forEach?: ForEachSpec;
}

export interface HttpTest extends TestBase {
  type: 'http';
  request: HttpRequestSpec;
}

export interface GraphQLTest extends TestBase {
  type: 'graphql';
  endpoint: string;
  query: string;
  graphqlVariables?: Record<string, unknown> | string;
  operationName?: string;
  headers?: KeyValue[];
  auth?: AuthConfig;
  /** A subscription: stop after this many events (default 1). */
  events?: number;
  /** A subscription: listen at most this long, in milliseconds (default 10000). */
  waitMs?: number;
}

export interface GrpcTest extends TestBase {
  type: 'grpc';
  /** `host:port`, `grpcs://host:port` for TLS. */
  target: string;
  /** `package.Service/Method` */
  method: string;
  /** Request message; a list of messages for client-streaming methods. */
  message?: unknown;
  metadata?: KeyValue[];
  /**
   * .proto files (workspace paths); imports resolve by path, e.g. `import "vet/v1/common.proto"` finds
   * `protos/vet/v1/common.proto`. Empty: the server is asked through gRPC server reflection.
   */
  protos: string[];
  /** .proto files given inline (a gRPC call saved in the app keeps its files); used instead of `protos`. */
  protoFiles?: Array<{ name: string; text: string }>;
  /** A FileDescriptorSet (base64) from an earlier server reflection; used when there are no .proto files. */
  descriptorSet?: string;
  tls?: boolean;
}

/**
 * Connect to a WebSocket (or Socket.IO) server, send messages / emit events in order, listen for `waitMs`,
 * close. Assertions run on `{ connected, received: [...], messages: [...] }`: `received` holds each
 * received payload (parsed as JSON when it is JSON; Socket.IO: `{ event, data }`).
 */
export interface WebSocketTest extends TestBase {
  type: 'websocket';
  /** ws:// or wss:// (WebSocket), http(s)://host/namespace (Socket.IO), mqtt(s):// (MQTT), kafka(s)://broker:9092 (Kafka). */
  url: string;
  mode?: 'websocket' | 'socketio' | 'mqtt' | 'kafka';
  /** WebSocket: text frames (objects are sent as JSON). Socket.IO: `{ event, args?, ack? }`. MQTT: `{ topic, payload?, qos?, retain? }`. Kafka: `{ topic, payload?, key?, headers?, partition? }`. */
  send?: Array<string | Record<string, unknown>>;
  /** MQTT: topic filters to subscribe to first. Kafka: topics to read (`fromBeginning` to read what is already there). */
  subscribe?: Array<string | { topic: string; qos?: 0 | 1 | 2; fromBeginning?: boolean }>;
  /** Kafka: the consumer group (default: one of its own) and the SASL mechanism for username / password. */
  groupId?: string;
  mechanism?: 'plain' | 'scram-sha-256' | 'scram-sha-512';
  /** MQTT: client ID, username and password (use {{variables}} for secrets). */
  clientId?: string;
  username?: string;
  password?: string;
  /** How long to listen after the last message (ms, default 1500). */
  waitMs?: number;
  headers?: KeyValue[];
  protocols?: string[];
  auth?: Record<string, unknown>;
  path?: string;
}

export interface McpTest extends TestBase {
  type: 'mcp';
  server: string | McpServerConfig;
  tool?: string;
  arguments?: Record<string, unknown>;
  resource?: string;
  prompt?: { name: string; arguments?: Record<string, string> };
  /** How to answer the server's elicitation requests (it asks the user for input): accept with content, decline or cancel. */
  elicitation?: { action?: 'accept' | 'decline' | 'cancel'; content?: Record<string, unknown> };
  /** How to answer the server's sampling requests (it asks for an LLM completion): a fixed reply. */
  sampling?: { text: string; model?: string };
  /** Roots (folders) the client offers the server: paths or file:// URIs. */
  roots?: string[];
}

export interface ResponseFormat {
  type: 'text' | 'json' | 'json_schema';
  name?: string;
  schema?: Record<string, unknown>;
}

export interface LlmTest extends TestBase {
  type: 'llm';
  model: ModelRef;
  system?: string;
  prompt: string | { template: string; system?: string };
  input?: Record<string, unknown>;
  expected?: unknown;
  responseFormat?: ResponseFormat;
  limits?: { latency_ms?: number; tokens?: number; output_tokens?: number; cost?: number };
}

export interface RetrievedDoc {
  id: string;
  text: string;
  score?: number;
  source?: string;
}

export interface RagTest extends TestBase {
  type: 'rag';
  question: string;
  contexts: RetrievedDoc[];
  expected?: string;
  /** Pre-computed answer from the system under test. When omitted, `model` generates one. */
  answer?: string;
  model?: ModelRef;
  prompt?: string;
}

export interface MockTool {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
  /** Static result returned when the agent calls the tool (templated with `{{args.x}}`). */
  result?: unknown;
}

export interface AgentTest extends TestBase {
  type: 'agent';
  model: ModelRef;
  system?: string;
  input: string;
  tools?: MockTool[];
  /** MCP server names/ids whose tools are exposed to the agent. */
  mcpServers?: string[];
  maxSteps?: number;
}

/** A pause in a flow: waits `ms` milliseconds (never longer than the test's timeout; a cancelled run stops it at once). */
export interface DelayTest extends TestBase {
  type: 'delay';
  ms: number;
}

/** A condition block: evaluates `if:` and passes; the steps that depend on it with `when: true|false` run on its branch. */
export interface ConditionTest extends TestBase {
  type: 'condition';
  if: string;
}

/** A script block: runs `script:` (the tp.* API) with no request; the variables it sets flow to the steps after it. */
export interface ScriptTest extends TestBase {
  type: 'script';
  script: string;
}

/** A sub-flow: runs another test file as one step with `inputs:` as its variables; its `output:` (or extracted values) come back. */
export interface FlowTest extends TestBase {
  type: 'flow';
  /** The test file to run, relative to this file (or to tests/). */
  flowFile: string;
  inputs?: Record<string, unknown>;
}

/** A log block: shows `message:` (a template) in the run's results. */
export interface LogTest extends TestBase {
  type: 'log';
  message: string;
}

export type TestCase = HttpTest | GraphQLTest | GrpcTest | WebSocketTest | McpTest | LlmTest | RagTest | AgentTest | DelayTest | ConditionTest | ScriptTest | FlowTest | LogTest;

export interface SuiteConfig {
  name: string;
  description?: string;
  /** Paths or globs (relative to suite file) of test files/directories. */
  tests: string[];
  setup?: string[];
  teardown?: string[];
  concurrency?: number;
  retries?: number;
  timeoutMs?: number;
  environment?: string;
  tags?: string[];
  file?: string;
  /** The suite offered to AI agents as an MCP tool (expose: { tool, description, inputs }). */
  expose?: { tool: string; description?: string; inputs?: Array<{ name: string; description?: string; default?: string; required?: boolean }> };
}

/* ------------------------------------------------------------------ results */

export type TestStatus = 'passed' | 'failed' | 'skipped' | 'error';

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

export interface TestResult {
  id: string;
  name: string;
  type: TestType;
  status: TestStatus;
  file?: string;
  startedAt: string;
  durationMs: number;
  attempts: number;
  checks: CheckResult[];
  error?: NormalizedError;
  latencyMs?: number;
  tokens?: TokenUsage;
  costUsd?: number;
  model?: string;
  traceId?: string;
  /** Small, redacted summary of the output (for reports). */
  output?: string;
  input?: string;
  metadata?: Record<string, unknown>;
  /** A person's verdict on the result (kept beside the run, in reviews.json; added when results are read). */
  review?: ResultReview;
}

/** A person's verdict on a result: good or bad, and why. The checks measure; a reviewer decides. */
export interface ResultReview {
  rating?: 'good' | 'bad';
  note?: string;
  /** ISO time of the last change. */
  at: string;
  /** Who reviewed (the app's user name, an agent's name), when known. */
  by?: string;
}

export interface LatencyStats {
  count: number;
  min: number;
  max: number;
  mean: number;
  p50: number;
  p90: number;
  p95: number;
  p99: number;
}

export interface RunSummary {
  runId: string;
  name: string;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  total: number;
  passed: number;
  failed: number;
  skipped: number;
  errors: number;
  latency: LatencyStats;
  tokens: TokenUsage;
  costUsd: number;
  cancelled: boolean;
  environment?: string;
  /** Averages of scored checks by type, e.g. `{ "llm-judge": 0.87 }`. */
  scores: Record<string, { mean: number; count: number }>;
  reproducibility: Record<string, unknown>;
}

/* ------------------------------------------------------------------ errors */

export type ErrorKind =
  | 'NetworkError'
  | 'TimeoutError'
  | 'AuthenticationError'
  | 'AuthorizationError'
  | 'ValidationError'
  | 'RateLimitError'
  | 'ServerError'
  | 'ProtocolError'
  | 'SchemaError'
  | 'EvaluationError'
  | 'ConfigurationError'
  | 'CancelledError'
  | 'ScriptError'
  /** A bug in TestPion itself (a TypeError, an unexpected exception): not the user's request or server. */
  | 'InternalError';

export interface NormalizedError {
  kind: ErrorKind;
  message: string;
  /** What happened. */
  what: string;
  /** Why it (probably) happened. */
  why: string;
  suggestions: string[];
  details?: Record<string, unknown>;
}

/* ------------------------------------------------------------------ trace */

export type SpanKind = 'http' | 'graphql' | 'grpc' | 'llm' | 'tool' | 'mcp' | 'evaluation' | 'script' | 'test' | 'internal';

export interface Span {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  kind: SpanKind;
  startTime: number;
  endTime?: number;
  durationMs?: number;
  status: 'ok' | 'error' | 'unset';
  attributes: Record<string, unknown>;
  input?: unknown;
  output?: unknown;
  error?: string;
  events?: Array<{ time: number; name: string; attributes?: Record<string, unknown> }>;
}

export interface Trace {
  traceId: string;
  name: string;
  startTime: number;
  endTime?: number;
  status: 'ok' | 'error' | 'unset';
  spans: Span[];
}

/* ------------------------------------------------------------------ workspace */

export interface Workspace {
  schemaVersion: string;
  id: string;
  name: string;
  description?: string;
  variables: KeyValue[];
  createdAt: string;
  updatedAt: string;
}

export interface EnvironmentVariable {
  key: string;
  /** For secret variables this is empty on disk; the value lives in the secret store. */
  value: string;
  secret?: boolean;
  enabled?: boolean;
}

export interface Environment {
  id: string;
  name: string;
  variables: EnvironmentVariable[];
  /** Marks the environment as production; load testing is blocked unless explicitly allowed. */
  isProduction?: boolean;
  color?: string;
  /** Position in environment lists and pickers (lowest first); environments without one follow, by file name. */
  order?: number;
  /** Set on a listed environment whose file cannot be read (invalid JSON): why. It has no variables then; never saved. */
  problem?: string;
}

/** A saved response of a request (Postman "example"): documents the API and feeds the mock server. */
export interface SavedExample {
  id: string;
  name: string;
  status: number;
  statusText?: string;
  headers: KeyValue[];
  body: string;
  /** The request that produced this response, when it differs from the saved request. */
  request?: { method: string; url: string; headers?: KeyValue[]; body?: string };
  createdAt?: string;
}

export interface SavedHttpRequest {
  kind: 'http';
  id: string;
  name: string;
  /** Marked as a favourite: the explorer lists it at the top (Favorites). */
  favorite?: boolean;
  request: HttpRequestSpec;
  /** Markdown documentation for the request. */
  description?: string;
  preRequestScript?: string;
  testScript?: string;
  assertions?: CheckConfig[];
  examples?: SavedExample[];
}

export interface SavedGraphQLRequest {
  kind: 'graphql';
  id: string;
  name: string;
  /** Marked as a favourite: the explorer lists it at the top (Favorites). */
  favorite?: boolean;
  request: GraphQLRequestSpec;
  assertions?: CheckConfig[];
  /** Run before the request (after the collection's and folders'); tp.request.url is the endpoint, headers can be changed. */
  preRequestScript?: string;
  /** Run after the response (tp.response is the GraphQL HTTP response). */
  testScript?: string;
}

export interface CollectionFolder {
  kind: 'folder';
  id: string;
  name: string;
  items: CollectionNode[];
  auth?: AuthConfig;
  /** Folder variables: visible to the requests inside (inner folders win), below request and data variables. */
  variables?: KeyValue[];
  /** Run before the pre-request script of every request inside (after the collection's and outer folders'). */
  preRequestScript?: string;
  /** Run after every request inside (after the collection's and outer folders' test scripts). */
  testScript?: string;
}

export type CollectionNode = CollectionFolder | SavedHttpRequest | SavedGraphQLRequest;

export interface Collection {
  schemaVersion: string;
  id: string;
  name: string;
  description?: string;
  version: number;
  variables: KeyValue[];
  auth?: AuthConfig;
  preRequestScript?: string;
  testScript?: string;
  items: CollectionNode[];
  updatedAt: string;
}

export interface HistoryEntry {
  id: string;
  timestamp: string;
  kind: 'http' | 'graphql' | 'grpc' | 'mcp' | 'llm' | 'websocket';
  name: string;
  method?: string;
  url?: string;
  status?: number | string;
  durationMs?: number;
  size?: number;
  request?: unknown;
  responseMeta?: unknown;
  payloadPath?: string;
  traceId?: string;
  /** The saved request this entry was sent from (for per-request response history). */
  collectionId?: string;
  requestId?: string;
  /** `request` is a preview: a value (a body, a prompt) longer than 64 KB was cut when it was stored. */
  requestPreview?: boolean;
}

export interface AppSettings {
  schemaVersion: string;
  theme: 'system' | 'light' | 'dark';
  fontSize: number;
  /** Where responses go in the request editors: side by side, below, or auto (side by side when there is room). */
  responseLayout?: 'auto' | 'below' | 'side';
  reducedMotion: boolean;
  logLevel: 'ERROR' | 'WARN' | 'INFO' | 'DEBUG' | 'TRACE';
  /** Field names always redacted in logs, traces, reports and exports. */
  redactFields: string[];
  /**
   * OS environment variables that `{{$env.NAME}}` may read in the app (none unless added here): a shared or imported
   * collection could otherwise read any of them and send it anywhere when run. The CLI reads all of them.
   */
  envVariables?: string[];
  pricing: PriceEntry[];
  maxPreviewBytes: number;
  defaultTimeoutMs: number;
  telemetry: false;
  loadTesting: { allowRemoteHosts: boolean; maxVirtualUsers: number };
  lastWorkspace?: string;
  /** The app version whose new examples were last added to the examples workspace (once per version). */
  examplesOfferedVersion?: string;
  assistantProvider?: string;
  assistantModel?: string;
  workspacePaths: string[];
  /** Lowest-precedence variables shared by all workspaces. */
  globalVariables: KeyValue[];
  /** Check GitHub for a newer version when the desktop app starts. */
  checkForUpdates: boolean;
  /** Show a desktop notification when a run (tests, collection, evaluation) finishes while the app isn't in front. Default on. */
  notifyRunFinished?: boolean;
  /** Outbound proxy: environment variables (default), a custom proxy, or none. The password is in the secret store. */
  proxy?: { mode: 'env' | 'custom' | 'off'; url?: string; bypass?: string; username?: string };
  /** Certificate authorities HTTPS trusts besides the built-in list: the OS store and/or extra PEM certificates. */
  tls?: { systemCa?: boolean; extraCa?: string };
  /** Git: how often the app fetches in the background (minutes; 0 = off, default 5) while a workspace in git with a remote is open. */
  git?: { autoFetchMinutes?: number };
  /** Settings layout revision, used for one-time migrations of defaults. */
  settingsRevision?: number;
}

export const DEFAULT_REDACT_FIELDS = [
  'password',
  'token',
  'access_token',
  'refresh_token',
  'apiKey',
  'api_key',
  'x-api-key',
  'api-key',
  'authorization',
  'proxy-authorization',
  'cookie',
  'set-cookie',
  'secret',
  'client_secret',
  'ssn',
  'creditCard',
];

export function defaultSettings(): AppSettings {
  return {
    schemaVersion: SCHEMA_VERSION,
    theme: 'system',
    fontSize: 14,
    reducedMotion: false,
    logLevel: 'INFO',
    redactFields: [...DEFAULT_REDACT_FIELDS],
    pricing: [],
    maxPreviewBytes: 2 * 1024 * 1024,
    defaultTimeoutMs: 30_000,
    telemetry: false,
    loadTesting: { allowRemoteHosts: false, maxVirtualUsers: 200 },
    workspacePaths: [],
    globalVariables: [],
    settingsRevision: 2,
    checkForUpdates: true,
  };
}

/** Saved items of one kind with folders (library/<kind>.json in a workspace). */
export interface LibraryItem<T = unknown> {
  id: string;
  name: string;
  /** Folder name; empty or missing is the top level. */
  folder?: string;
  /** The collection it's shown in (gRPC calls and WebSocket connections are saved outside collection files). */
  collectionId?: string;
  data: T;
  updatedAt?: string;
}

export interface Library<T = unknown> {
  schemaVersion: string;
  /** Every folder, including empty ones. */
  folders: string[];
  items: Array<LibraryItem<T>>;
}
