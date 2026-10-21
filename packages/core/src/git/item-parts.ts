import { isRecord } from '@testpion/shared';
import { classifySecret, secretKeyFields } from '../security/secrets.js';

/**
 * An item shown part by part, for the side-by-side view of the Git view (and the conflict screen): an MCP server, an AI
 * provider or the workspace settings. Values that are secrets (a token typed in a header, a key) are hidden: the view
 * shows that the value changed, never the value.
 */

type Rec = Record<string, unknown>;
const HIDDEN = '•••• (hidden)';

const fields = secretKeyFields();
/** A value as text, hidden when its key says it is a secret and a value is typed in (a `{{reference}}` is shown). */
const shown = (key: string, value: unknown): string => {
  const text = typeof value === 'string' ? value : value === undefined || value === null ? '' : JSON.stringify(value);
  return classifySecret(key, text, fields) ? HIDDEN : text;
};

/** A key/value list (headers) or an object (env) as `key: value` lines. */
function pairs(v: unknown): string {
  if (Array.isArray(v))
    return v
      .filter(isRecord)
      .map((p) => `${p.enabled === false ? '// ' : ''}${String(p.key ?? '')}: ${shown(String(p.key ?? ''), p.value)}`)
      .join('\n');
  if (isRecord(v))
    return Object.entries(v)
      .map(([k, x]) => `${k}: ${shown(k, x)}`)
      .join('\n');
  return '';
}

const text = (v: unknown) => (v === undefined || v === null ? '' : typeof v === 'string' ? v : JSON.stringify(v));
const clean = (o: Record<string, string>) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== ''));

export function mcpServerParts(s: Rec): Record<string, string> {
  return clean({
    Name: text(s.name),
    Folder: text(s.folder),
    Transport: text(s.transport),
    Command: [text(s.command), ...(Array.isArray(s.args) ? s.args.map(text) : [])].filter(Boolean).join(' '),
    'Working folder': text(s.cwd),
    URL: text(s.url),
    'Mock file': text(s.mockFile),
    Environment: pairs(s.env),
    Headers: pairs(s.headers),
  });
}

export function providerParts(p: Rec): Record<string, string> {
  return clean({
    Name: text(p.name),
    Type: text(p.kind),
    'Base URL': text(p.baseUrl),
    'API key': text(p.apiKey) ? (/\{\{.+\}\}/.test(text(p.apiKey)) ? text(p.apiKey) : HIDDEN) : '',
    Model: text(p.defaultModel),
    'Embedding model': text(p.embeddingModel),
    'API version': text(p.apiVersion),
    Region: text(p.region),
    Headers: pairs(p.headers),
    'Rate limit': text(p.rateLimit),
    Timeout: text(p.timeoutMs),
  });
}

export function workspaceParts(w: Rec): Record<string, string> {
  return clean({ Name: text(w.name), Description: text(w.description), Variables: pairs(w.variables) });
}
