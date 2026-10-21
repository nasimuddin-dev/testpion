import type { AppSettings, Collection } from '../../model/types.js';
import type { SecretStore } from '../../storage/secrets.js';
import type { WorkspaceStore } from '../../storage/workspace.js';
import type { DebuggerExchange } from '../../debugger/proxy.js';
import type { Redactor } from '../../util/redact.js';

/** What the tool modules need from the server: the workspace, its secrets and settings, and the lookups the server shares. */
export interface ModuleToolDeps {
  store: WorkspaceStore;
  secrets: SecretStore;
  settings: AppSettings;
  redactor: Redactor;
  collections(): Collection[];
  findCollection(ref: unknown): Collection;
  findRequest: typeof import('./server-kit.js').findRequestIn;
  /** An OpenAPI document given as an http(s) link, a path inside the workspace or the text itself. */
  readSpec(ref: string): Promise<string>;
  /** What debugger_capture captured in this server; flow_from_exchanges reads it too. */
  captured: DebuggerExchange[];
  /** The environment's name when it exists and may be sent to (the server's rule), undefined for none. */
  checkEnvironment(name: unknown): string | undefined;
  /** The server runs read-only: only the browsing tools are listed. */
  readOnly?: boolean;
  /** Shared helpers (server-kit.ts): flatten a collection, clip text, read a request from a snippet, summarize and record runs. */
  flatten: typeof import('./server-kit.js').flatten;
  clip: typeof import('./server-kit.js').clip;
  requestFrom: typeof import('./server-kit.js').requestFrom;
  summarizeResult: ReturnType<typeof import('./server-kit.js').resultSummarizer>;
  recordedRun: ReturnType<typeof import('./server-kit.js').runRecorder>;
}
