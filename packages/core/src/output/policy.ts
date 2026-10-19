/**
 * What every way of saving an output (the window's down arrow, `testpion output`, MCP `save_output`) shares: checking a
 * call against OUTPUT_SURFACES, and the secrets policy of a surface applied to text. The policy is the registry's, never
 * the caller's.
 */
import { OUTPUT_FORMATS, isOutputFormatId, outputSurface, type OutputFormatId, type OutputSource, type OutputSurfaceInfo } from '@testpion/shared';
import { ApsError } from '../errors.js';
import { maskSensitiveText, type Redactor } from '../util/redact.js';

/** Mask header values with a sensitive name in `Name: value` lines and curl `-H 'Name: value'` arguments. */
function maskHeaderLines(text: string, redactor: Redactor): string {
  return text
    .replace(/^([ \t]*)([A-Za-z][\w-]*)([ \t]*:[ \t]*)(\S.*)$/gm, (m, a: string, k: string, sep: string) => (redactor.isSensitiveKey(k) ? `${a}${k}${sep}***` : m))
    .replace(/(-H\s+['"])([A-Za-z][\w-]*)(:\s*)([^'"]*)(['"])/g, (m, a: string, k: string, sep: string, _v: string, q: string) => (redactor.isSensitiveKey(k) ? `${a}${k}${sep}***${q}` : m));
}

/** A text output with its secrets masked (known secret values, sensitive field names, credentials by their shape). */
export function redactOutputText(text: string, format: OutputFormatId, redactor: Redactor): string {
  let out = text;
  const json = (s: string, pretty: boolean) => {
    try {
      const v = redactor.redact(JSON.parse(s));
      return pretty ? JSON.stringify(v, null, 2) + (s.endsWith('\n') ? '\n' : '') : JSON.stringify(v);
    } catch {
      return s;
    }
  };
  if (format === 'json' || format === 'har') out = json(out, true);
  else if (format === 'json-min') out = json(out, false);
  else if (format === 'jsonl')
    out = out
      .split('\n')
      .map((l) => (l.trim() ? json(l, false) : l))
      .join('\n');
  else out = maskHeaderLines(out, redactor);
  return maskSensitiveText(redactor.redactString(out), { pii: false });
}

/** "Contains what looks like a token (bearer)": what the redactor would have masked in a raw output, or undefined. */
export function secretNotice(sample: string, redactor: Redactor): string | undefined {
  const kinds = new Set<string>();
  maskSensitiveText(sample, { pii: false }, (k) => kinds.add(k));
  if (redactor.redactString(sample) !== sample) kinds.add('a secret variable value');
  const field = /"(access_?token|refresh_?token|id_?token|client_?secret|password|api_?key)"\s*:/i.exec(sample);
  if (field) kinds.add(field[1]!);
  if (!kinds.size) return undefined;
  return `Contains what looks like a credential (${[...kinds].slice(0, 3).join(', ')}). Saved as is.`;
}

/**
 * The surface, format and source of a call, checked against OUTPUT_SURFACES (the policy is the registry's, never the
 * caller's: a source is accepted only for a surface that names it, so no surface's policy is borrowed for another's data).
 */
export function checkOutput(p: { surface: string; format: string; content?: unknown; source?: unknown }, who = 'output.save'): { info: OutputSurfaceInfo; format: OutputFormatId; fmt: (typeof OUTPUT_FORMATS)[OutputFormatId] } {
  const info = outputSurface(p.surface);
  if (!info) throw new ApsError('ValidationError', `${who}: unknown surface ${p.surface}`);
  if (!isOutputFormatId(p.format) || !info.formats.includes(p.format))
    throw new ApsError('ValidationError', `${who}: ${info.label} cannot be saved as ${p.format}`, { suggestions: [`Use one of: ${info.formats.join(', ')}`] });
  if (!p.content === !p.source) throw new ApsError('ValidationError', `${who}: give content or a source`);
  if (p.source) {
    const kind = (p.source as { kind?: unknown })?.kind;
    if (typeof kind !== 'string' || !info.sources?.includes(kind as OutputSource['kind']))
      throw new ApsError('ValidationError', `${who}: unknown source ${String(kind)} for ${info.label}`, {
        suggestions: info.sources?.length ? [`${info.label} is built from: ${info.sources.join(', ')}`] : [`${info.label} is saved from its content`],
      });
  }
  return { info, format: p.format, fmt: OUTPUT_FORMATS[p.format] };
}

/** Whether secrets are masked in this surface's output: its policy, with "include secrets" only where the surface can hold any. */
export function isRedacting(info: OutputSurfaceInfo, includeSecrets: boolean | undefined): boolean {
  // a surface whose secrets are masked at capture (console, log) has none to include: it is always redacted
  return info.redaction === 'redacted-default' && (!includeSecrets || !!info.capturedRedacted);
}
