import { ApsError } from '../../errors.js';
import { cleanGateway, describeGateway, GATEWAY_PASSWORD_SECRET, resolveGateway, type Gateway, type GatewayConfig } from '../../debugger/gateway.js';
import type { SecretReader } from '../../vars/variables.js';

export { diffForAgent, exchangesFromFile } from '../../debugger/session-files.js';

/**
 * Shared by the `debugger_*` tools: the connection arguments of `debugger_capture` start (gateway, extra authorities, client
 * certificates), opening any session file (HAR, SAZ, bundle) and comparing two. The tools take secret NAMES (the store's
 * entry for the proxy password or a key passphrase), never the value: an agent's transcript must not hold a password.
 */
export const connectionProperties = {
  upstream: { type: 'string', description: 'With start: forward everything through this upstream proxy, http://host:port' },
  upstream_system: { type: 'boolean', description: 'With start: forward through the proxy the environment names (HTTP_PROXY, HTTPS_PROXY, NO_PROXY)' },
  no_upstream_for: { type: 'string', description: 'With upstream: hosts that go direct, comma separated like NO_PROXY (.corp.example, 10.0.0.1, <local>); loopback always does' },
  upstream_user: { type: 'string', description: 'With upstream: the gateway user name' },
  upstream_password_secret: { type: 'string', description: `With upstream_user: the secret that holds the password (default ${GATEWAY_PASSWORD_SECRET}); never pass the value` },
  ca_files: { type: 'array', items: { type: 'string' }, description: 'With start: PEM files of extra certificate authorities to trust (a corporate root)' },
  client_certs: {
    type: 'array',
    items: { type: 'object', properties: { host: { type: 'string' }, cert_file: { type: 'string' }, key_file: { type: 'string' }, passphrase_secret: { type: 'string' } }, required: ['host', 'cert_file', 'key_file'] },
    description: 'With start: client certificates for mutual TLS: host is a glob on host[:port]; the key stays in its file, its passphrase is the named secret',
  },
} as const;

/** The gateway the arguments of start ask for, or undefined for direct connections. Throws a ValidationError / ConfigurationError that says what is wrong. */
export function gatewayFromArgs(a: Record<string, unknown>, secrets: SecretReader | undefined, env: NodeJS.ProcessEnv = process.env): { gateway?: Gateway; summary?: string } {
  const certs = Array.isArray(a.client_certs) ? (a.client_certs as Array<Record<string, unknown>>) : [];
  const caFiles = Array.isArray(a.ca_files) ? (a.ca_files as unknown[]).map(String) : [];
  const mode = typeof a.upstream === 'string' && a.upstream ? 'manual' : a.upstream_system === true ? 'system' : 'none';
  if (mode === 'none' && !certs.length && !caFiles.length) return {};
  const passphrases = new Map<string, string>();
  const config: GatewayConfig = cleanGateway({
    mode,
    url: a.upstream,
    bypass: a.no_upstream_for,
    username: a.upstream_user,
    caFiles,
    clientCerts: certs.map((c, i) => ({ id: `mcp${i + 1}`, host: c.host, certFile: c.cert_file, keyFile: c.key_file })),
  });
  certs.forEach((c, i) => {
    const name = typeof c.passphrase_secret === 'string' ? c.passphrase_secret : undefined;
    const v = name ? secrets?.get(name) : undefined;
    if (name && v === undefined) throw new ApsError('ConfigurationError', `The secret "${name}" (the passphrase of the key for ${String(c.host)}) is not set`);
    if (v) passphrases.set(`debugger.clientcert.mcp${i + 1}.passphrase`, v);
  });
  const passwordName = typeof a.upstream_password_secret === 'string' ? a.upstream_password_secret : GATEWAY_PASSWORD_SECRET;
  const password = config.username ? secrets?.get(passwordName) : undefined;
  if (config.username && password === undefined) throw new ApsError('ConfigurationError', `The secret "${passwordName}" (the gateway password for ${config.username}) is not set`, { suggestions: ['Set it as a secret of an environment in the app, or as TESTPION_SECRET_* in the environment.'] });
  const gateway = resolveGateway(config, {
    secret: (n) => (n === GATEWAY_PASSWORD_SECRET ? password : passphrases.get(n)),
    systemProxyFor: (url) => {
      const https = url.startsWith('https:');
      return https ? (env.HTTPS_PROXY ?? env.https_proxy ?? env.HTTP_PROXY ?? env.http_proxy) : (env.HTTP_PROXY ?? env.http_proxy);
    },
  });
  return { gateway, summary: describeGateway(config, { password: password !== undefined }) };
}
