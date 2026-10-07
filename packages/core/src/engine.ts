import { readFileSync } from 'node:fs';
import { externalSecrets, isSecretRef } from './vars/external-secrets.js';
import type { ProviderConfig, AppSettings, AuthConfig, Collection, CollectionNode, Environment, McpServerConfig } from './model/types.js';
import { defaultSettings } from './model/types.js';
import { VariableScope } from './vars/variables.js';
import { Redactor } from './util/redact.js';
import { Logger } from './log/logger.js';
import { ProviderRegistry } from './ai/index.js';
import { McpManager, type McpTraceEvent } from './protocols/mcp/client.js';
import type { ExecServices } from './runner/execute.js';
import type { WorkspaceStore } from './storage/workspace.js';
import { recordCertificate } from './storage/certificates.js';
import { secretKeys, type SecretStore } from './storage/secrets.js';
import { CookieJar } from './cookies/cookie-jar.js';
import { APP_CLAUDE_ID, APP_CLAUDE_SECRET, appClaudeProvider } from './ai/app-provider.js';

export interface ContextOptions {
  store: WorkspaceStore;
  /**
   * Directory that relative file paths in checks (OpenAPI documents) resolve against, and may not
   * leave. Defaults to the workspace root; the CLI passes the working directory when it runs without one.
   */
  fileRoot?: string;
  secrets: SecretStore;
  settings?: AppSettings;
  environment?: string;
  collectionId?: string;
  /**
   * Which OS environment variables `{{$env.NAME}}` may read: 'all' (the CLI and CI, where the pipeline decides what
   * is in the environment) or a list of names (the app: Settings ▸ Privacy, empty unless the user adds some).
   */
  envAccess?: 'all' | string[];
  logger?: Logger;
  redactor?: Redactor;
  openExternal?: (url: string) => void | Promise<void>;
  onMcpEvent?: (serverId: string, e: McpTraceEvent) => void;
  /** Extra runtime variables (CLI `--var k=v`). */
  runtimeVars?: Record<string, unknown>;
  /** Cookie jar to use (desktop: the persistent workspace jar). Defaults to an empty jar for this context. */
  cookieJar?: CookieJar | false;
  /** Providers available besides the workspace's (the app's own Claude provider); a workspace provider with the same id wins. */
  extraProviders?: ProviderConfig[];
}

export interface EngineContext {
  services: ExecServices;
  vars: VariableScope;
  redactor: Redactor;
  environment?: Environment;
  collection?: Collection;
  dispose(): Promise<void>;
}

/** Load secret values for an environment's secret variables into a plain list (never persisted). */
export function environmentVariables(env: Environment | undefined, secrets: SecretStore): Array<{ key: string; value: string; enabled?: boolean; secret?: boolean }> {
  if (!env) return [];
  return env.variables.map((v) => {
    // a secret manager reference (op://…, vault://…): the value read for it (prefetchEnvironmentSecrets), always a secret
    if (isSecretRef(v.value)) return { ...v, value: externalSecrets.get(v.value) ?? '', secret: true };
    return v.secret ? { ...v, value: secrets.get(secretKeys.envVar(env.id, v.key)) ?? '' } : v;
  });
}

/**
 * Build the execution services for a workspace, applying variable precedence:
 * Global → Workspace → Environment → Collection → Request → Runtime.
 * Used identically by the desktop app and the CLI (spec §38: one execution engine).
 */
export function createEngineContext(opts: ContextOptions): EngineContext {
  const settings = opts.settings ?? defaultSettings();
  const redactor = opts.redactor ?? new Redactor(settings.redactFields);
  // the caller's choice, else the user's list from Settings when there is one (the MCP server, runs), else every variable (the CLI)
  const vars = new VariableScope(opts.secrets, redactor, { allowEnv: true, envAccess: opts.envAccess ?? settings.envVariables ?? 'all' });
  const { store } = opts;

  vars.setScope('global', settings.globalVariables ?? []);
  vars.setScope('workspace', [
    // built-in: absolute path of the workspace (useful for stdio MCP commands and dataset paths)
    { key: 'workspaceDir', value: store.root.split('\\').join('/') },
    ...store.workspace.variables.map((v) => ((v as { secret?: boolean }).secret ? { ...v, value: opts.secrets.get(secretKeys.workspaceVar(store.id, v.key)) ?? '', secret: true } : v)),
  ]);
  const environment = opts.environment ? store.getEnvironment(opts.environment) : undefined;
  vars.setScope('environment', environmentVariables(environment, opts.secrets));
  let collection: Collection | undefined;
  if (opts.collectionId) {
    try {
      collection = store.getCollection(opts.collectionId);
      vars.setScope('collection', collection.variables);
    } catch {
      /* collection missing — ignore */
    }
  }
  if (opts.runtimeVars) vars.setScope('runtime', opts.runtimeVars);

  const mcpServers = store.getMcpServers().map((s) => store.resolveMcpServer(s));
  const resolveMcp = (ref: string | McpServerConfig): McpServerConfig | undefined => {
    if (typeof ref !== 'string') return vars.resolveDeep(ref);
    const r = ref.toLowerCase();
    const cfg = mcpServers.find((s) => s.id.toLowerCase() === r) ?? mcpServers.find((s) => s.name.toLowerCase() === r);
    return cfg ? vars.resolveDeep(cfg) : undefined;
  };
  const mcp = new McpManager(resolveMcp, redactor, opts.onMcpEvent);
  const own = store.getProviders();
  // the app's Claude provider whenever its key is in a secret store (the OS store in the app,
  // TESTPION_SECRET_APP_ANTHROPIC_APIKEY for the CLI and CI)
  const extra = [...(opts.extraProviders ?? [])];
  if (!extra.some((p) => p.id === APP_CLAUDE_ID) && opts.secrets.get(APP_CLAUDE_SECRET))
    extra.push(appClaudeProvider((settings.assistantProvider === APP_CLAUDE_ID && settings.assistantModel) || undefined));
  const providers = new ProviderRegistry([...own, ...extra.filter((p) => !own.some((o) => o.id === p.id))], vars, redactor);
  const logger = opts.logger ?? new Logger(settings.logLevel, redactor);

  const services: ExecServices = {
    vars,
    providers,
    mcp,
    mcpServers,
    redactor,
    pricing: settings.pricing,
    logger,
    defaultTimeoutMs: settings.defaultTimeoutMs,
    maxPreviewBytes: settings.maxPreviewBytes,
    inheritedAuth: collection?.auth,
    openExternal: opts.openExternal,
    cookieJar: opts.cookieJar === false ? undefined : (opts.cookieJar ?? new CookieJar()),
    environmentName: environment?.name,
    readFile: (path: string) => readFileSync(store.safePath(path, opts.fileRoot ?? store.root), 'utf8'),
    scriptPackage: (name: string) => store.readScriptPackage(name),
    onCertificate: (url, c) => recordCertificate(store, url, c),
  };
  return { services, vars, redactor, environment, collection, dispose: () => mcp.close() };
}

/** Resolve inherited auth for a request inside a collection (nearest folder wins, then the collection). */
export function inheritedAuthFor(collection: Collection, requestId: string): AuthConfig | undefined {
  const walk = (nodes: CollectionNode[], auth: AuthConfig | undefined): AuthConfig | undefined | null => {
    for (const n of nodes) {
      if (n.kind === 'folder') {
        const a = n.auth && n.auth.type !== 'inherit' ? n.auth : auth;
        const r = walk(n.items, a);
        if (r !== null) return r;
      } else if (n.id === requestId) return auth;
    }
    return null;
  };
  const r = walk(collection.items, collection.auth);
  return r === null ? collection.auth : r;
}
