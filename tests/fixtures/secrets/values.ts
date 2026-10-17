/**
 * Secret fixtures for SEC-1 (security/secrets.ts) and the export tests. Every value is built from fragments at run time,
 * so no file in the repository holds a string a secret scanner (GitHub push protection) would take for a live key. None
 * of them is a real credential.
 */
const x = (n: number, c = 'x') => c.repeat(n);
const alnum = (n: number) => 'Ab3'.repeat(Math.ceil(n / 3)).slice(0, n);
const hex = (n: number) => 'a1b2c3d4e5f6'.repeat(Math.ceil(n / 12)).slice(0, n);

/** One positive and one negative per value pattern, with the confidence the positive must get. */
export const VALUE_FIXTURES: Array<{ id: string; confidence: 'high' | 'medium' | 'low'; positive: string; negative: string }> = [
  {
    id: 'private-key',
    confidence: 'high',
    positive: ['-----BEGIN', 'RSA PRIVATE KEY-----\nMIIB', x(40, 'Q'), '\n-----END RSA PRIVATE KEY-----'].join(' '),
    negative: '-----BEGIN PUBLIC KEY----- MIIB' + x(40, 'Q'),
  },
  { id: 'jwt', confidence: 'medium', positive: ['ey' + 'JhbGciOiJIUzI1NiJ9', 'ey' + 'JzdWIiOiIxMjMifQ', 'c2lnbmF0dXJlLXBhcnQ'].join('.'), negative: 'eyJ.not.a.token and some prose' },
  { id: 'auth-scheme', confidence: 'medium', positive: 'Bearer ' + alnum(10) + '9=' + alnum(8), negative: 'Token validation failed for this request' },
  { id: 'openai', confidence: 'high', positive: 'sk-' + 'proj-' + alnum(32), negative: 'sk-short' },
  { id: 'github', confidence: 'high', positive: 'gh' + 'p_' + alnum(36), negative: 'ghp_tooShort' },
  { id: 'aws-access-key', confidence: 'high', positive: 'AK' + 'IA' + 'ABCDEFGHIJKLMNOP', negative: 'AKIA-not-a-key' },
  { id: 'google-api-key', confidence: 'high', positive: 'AI' + 'za' + alnum(35), negative: 'AIzaShort' },
  { id: 'slack', confidence: 'high', positive: 'xo' + 'xb-' + '1234567890-' + alnum(16), negative: 'xoxz-1234567890abcdef' },
  { id: 'stripe', confidence: 'high', positive: 'sk' + '_live_' + alnum(24), negative: 'sk_demo_' + alnum(24) },
  { id: 'gitlab', confidence: 'high', positive: 'gl' + 'pat-' + alnum(20), negative: 'glpat-short' },
  { id: 'npm', confidence: 'high', positive: 'np' + 'm_' + alnum(36), negative: 'npm_install_steps' },
  { id: 'huggingface', confidence: 'high', positive: 'h' + 'f_' + alnum(34), negative: 'hf_small' },
  { id: 'sendgrid', confidence: 'high', positive: 'S' + 'G.' + alnum(22) + '.' + alnum(43), negative: 'SG.Short.Value' },
  { id: 'twilio', confidence: 'medium', positive: 'S' + 'K' + hex(32), negative: 'SKU-' + hex(32) },
  { id: 'pypi', confidence: 'high', positive: 'py' + 'pi-' + alnum(60), negative: 'pypi-package-name' },
  { id: 'connection-string', confidence: 'high', positive: 'postgres://app:' + 'Hunter' + '2pass' + '@db.example.com:5432/clinic', negative: 'postgres://app@db.example.com:5432/clinic' },
  { id: 'query-credential', confidence: 'medium', positive: 'https://api.example.com/v1/x?access_token=' + alnum(16), negative: 'https://api.example.com/v1/x?page=2&limit=50' },
];

/** The fixture workspace's secrets, built once: the export must contain none of them. */
export const FIXTURE_SECRETS = {
  mcpAuthorization: 'Bearer ' + alnum(14) + '7=' + alnum(10),
  mcpEnvToken: 'gh' + 'p_' + alnum(36),
  mcpEnvPlain: 'tenant-' + alnum(12),
  collectionBearer: 'col' + alnum(20) + '42',
  requestApiKeyHeader: 'sk-' + 'live-' + alnum(28),
  dbPassword: 'Pg' + 'Pass' + alnum(10) + '9',
  envPassword: 'env' + 'Pw' + alnum(12),
  providerKey: 'AK' + 'IA' + 'QRSTUVWXYZABCDEF',
};
