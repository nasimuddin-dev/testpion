import { release as osRelease, arch, platform } from 'node:os';
import { ApsError } from '../errors.js';
import { ENGINE_VERSION } from '../version.js';
import { looksLikeZip, readZip, writeZipAsync, type ZipEntry } from '../transfer/zip.js';
import { exchangesFromHar, exchangesToHar, strictHarRedactor, type HarRedactor } from './har.js';
import { describeGateway, type GatewayConfig } from './gateway.js';
import type { DebuggerRule } from './rules.js';
import type { DebuggerExchange } from './proxy.js';

/**
 * The share and support bundle (FG-24): one `.tpbundle` file with what a colleague or support needs to see what you saw. A zip of
 * `manifest.json`, `session.har` (masked more strictly than a saved session: credentials, tokens and secrets by shape),
 * `rules.json` (the active rules, header values and bodies masked), `environment.json` (facts about this computer and the
 * Debugger's settings: no secret, no path, no user name) and an optional `notes.md`. Notes on exchanges travel inside the HAR.
 * It opens in another TestPion (Session ▸ Open a bundle) and is the file `git share` writes with `--bundle`.
 */
export const SHARE_BUNDLE_FORMAT = 'testpion-bundle';
export const SHARE_BUNDLE_VERSION = 1;
export const SHARE_BUNDLE_EXTENSION = '.tpbundle';

export interface ShareBundleManifest {
  format: typeof SHARE_BUNDLE_FORMAT;
  version: number;
  createdAt: string;
  app: { name: 'TestPion'; version: string };
  name: string;
  exchanges: number;
  rules: number;
  masked: true;
  hasNotes: boolean;
}

export interface ShareBundleEnvironment {
  app: string;
  platform: string;
  osRelease: string;
  arch: string;
  node: string;
  /** The Debugger's state when the bundle was made. */
  debugger: { running?: boolean; decrypt?: boolean; systemProxy?: boolean; lan?: boolean; networkSpeed?: string; gateway?: string; port?: number };
  /** Proxy variables of the environment: host and port only (credentials never). */
  proxyEnvironment: Record<string, string>;
}

export interface ShareBundleInput {
  name: string;
  exchanges: DebuggerExchange[];
  rules?: DebuggerRule[];
  notes?: string;
  /** The Debugger's state. */
  state?: ShareBundleEnvironment['debugger'] & { gatewayConfig?: GatewayConfig; passwordSet?: boolean };
  redactor: HarRedactor;
  now?: Date;
  env?: NodeJS.ProcessEnv;
}

/** `user:pass@host:3128` becomes `host:3128`; anything that is not a URL becomes `set`. */
function hostOnly(v: string): string {
  try {
    const u = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(v) ? v : `http://${v}`);
    return u.host || 'set';
  } catch {
    return 'set';
  }
}

export function environmentFacts(o: Pick<ShareBundleInput, 'state' | 'env'>): ShareBundleEnvironment {
  const env = o.env ?? process.env;
  const proxyEnvironment: Record<string, string> = {};
  for (const k of ['HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'no_proxy']) if (env[k]) proxyEnvironment[k] = /^no_proxy$/i.test(k) ? env[k]!.slice(0, 500) : hostOnly(env[k]!);
  const { gatewayConfig, passwordSet, ...state } = o.state ?? {};
  return {
    app: `TestPion ${ENGINE_VERSION}`,
    platform: platform(),
    osRelease: osRelease(),
    arch: arch(),
    node: process.versions.node,
    debugger: { ...state, ...(gatewayConfig ? { gateway: describeGateway({ ...gatewayConfig, url: gatewayConfig.url && hostOnly(gatewayConfig.url), username: undefined, caFiles: gatewayConfig.caFiles, clientCerts: gatewayConfig.clientCerts }, { password: !!passwordSet }) } : {}) },
    proxyEnvironment,
  };
}

/** A rule with its header edits and bodies masked (a rule that sets Authorization carries a secret). */
export function maskRule(r: DebuggerRule, red: HarRedactor): DebuggerRule {
  const edits = (list: DebuggerRule['requestHeaders']) => list?.map((h) => (h.value === undefined ? h : { ...h, value: red.redactHeaders({ [h.name]: h.value })[h.name] ?? '' }));
  const out: DebuggerRule = { ...r };
  if (r.requestHeaders) out.requestHeaders = edits(r.requestHeaders);
  if (r.responseHeaders) out.responseHeaders = edits(r.responseHeaders);
  if (r.requestBody) out.requestBody = red.redactString(r.requestBody);
  if (r.responseBody) out.responseBody = red.redactString(r.responseBody);
  if (r.reply) out.reply = { ...r.reply, ...(r.reply.headers ? { headers: red.redactHeaders(r.reply.headers) } : {}), ...(r.reply.body ? { body: red.redactString(r.reply.body) } : {}) };
  return out;
}

/** The bundle as bytes. The session is masked with the strict redactor whatever the caller passes in. */
export async function createShareBundle(i: ShareBundleInput): Promise<{ bytes: Buffer; manifest: ShareBundleManifest }> {
  const red = strictHarRedactor(i.redactor);
  const rules = (i.rules ?? []).map((r) => maskRule(r, red));
  const notes = i.notes?.trim() ? red.redactString(i.notes.trim().slice(0, 20_000)) : undefined;
  const manifest: ShareBundleManifest = {
    format: SHARE_BUNDLE_FORMAT,
    version: SHARE_BUNDLE_VERSION,
    createdAt: (i.now ?? new Date()).toISOString(),
    app: { name: 'TestPion', version: ENGINE_VERSION },
    name: i.name.slice(0, 120),
    exchanges: i.exchanges.length,
    rules: rules.length,
    masked: true,
    hasNotes: !!notes,
  };
  const json = (v: unknown) => Buffer.from(`${JSON.stringify(v, null, 2)}\n`, 'utf8');
  const entries: ZipEntry[] = [
    { name: 'manifest.json', data: json(manifest) },
    { name: 'session.har', data: Buffer.from(JSON.stringify(exchangesToHar(i.exchanges, red, ENGINE_VERSION)), 'utf8') },
    { name: 'rules.json', data: json(rules) },
    { name: 'environment.json', data: json(environmentFacts(i)) },
    ...(notes ? [{ name: 'notes.md', data: Buffer.from(`${notes}\n`, 'utf8') }] : []),
  ];
  return { bytes: await writeZipAsync(entries), manifest };
}

export interface OpenedShareBundle {
  manifest: ShareBundleManifest;
  exchanges: DebuggerExchange[];
  rules: DebuggerRule[];
  environment?: ShareBundleEnvironment;
  notes?: string;
}

export const looksLikeShareBundle = (bytes: Buffer): boolean => looksLikeZip(bytes) && bytes.includes(Buffer.from('manifest.json'));

/** Open a bundle: a hardened zip read (a bundle is somebody else's file), each part checked for the type it must have. */
export function openShareBundle(bytes: Buffer): OpenedShareBundle {
  const entries = readZip(bytes, undefined, 'TestPion bundle (.tpbundle)');
  const part = (name: string) => entries.find((e) => e.name === name)?.data.toString('utf8');
  const parse = (name: string): unknown => {
    const text = part(name);
    if (text === undefined) return undefined;
    try {
      return JSON.parse(text);
    } catch {
      throw new ApsError('ValidationError', `Not a valid bundle: ${name} is not JSON`);
    }
  };
  const m = parse('manifest.json') as Partial<ShareBundleManifest> | undefined;
  if (!m || m.format !== SHARE_BUNDLE_FORMAT) throw new ApsError('ValidationError', 'Not a TestPion bundle (no manifest.json with format "testpion-bundle")');
  if (typeof m.version !== 'number' || m.version > SHARE_BUNDLE_VERSION) throw new ApsError('ValidationError', `This bundle is version ${m.version}; this TestPion reads up to ${SHARE_BUNDLE_VERSION}. Update TestPion to open it.`);
  const har = parse('session.har');
  if (!har) throw new ApsError('ValidationError', 'Not a valid bundle: session.har is missing');
  const rules = parse('rules.json');
  const env = parse('environment.json');
  return {
    manifest: { ...(m as ShareBundleManifest), name: String(m.name ?? 'bundle') },
    exchanges: exchangesFromHar(har),
    rules: Array.isArray(rules) ? (rules as DebuggerRule[]).filter((r) => r && typeof r === 'object' && typeof r.kind === 'string' && typeof r.id === 'string').slice(0, 500) : [],
    environment: env && typeof env === 'object' ? (env as ShareBundleEnvironment) : undefined,
    notes: part('notes.md'),
  };
}
