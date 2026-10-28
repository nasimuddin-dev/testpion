import { compileUserRegex } from '../util/safe-regex.js';
import { isInsidePath } from './shaping.js';
import type { DebuggerRule, TextReplace } from './rules.js';

/**
 * Whether the fields of the shaping rules (remap, fault, frame, map local, rewrite, replace, status) can work, in words for
 * the person who wrote them: the window, the CLI and the agent tool all ask this before a rule is saved. undefined: fine.
 */
export function checkRuleShape(r: DebuggerRule): string | undefined {
  const regex = (text: string, what: string): string | undefined => {
    if (text.length > 500) return `${what} is too long (500 characters at most)`;
    try {
      compileUserRegex(text, '', what);
    } catch (e) {
      return (e as Error).message;
    }
    return undefined;
  };
  const replaces = (list: TextReplace[] | undefined, what: string): string | undefined => {
    if (!list) return undefined;
    if (!Array.isArray(list) || list.length > 50) return `${what}: a list of at most 50 replacements`;
    for (const t of list) {
      if (!t || typeof t.find !== 'string' || !t.find) return `${what}: each replacement needs the text to find`;
      if (typeof t.replace !== 'string') return `${what}: each replacement needs the text to put there (it may be empty)`;
      if (t.regex) {
        const bad = regex(t.find, 'The pattern');
        if (bad) return bad;
      }
    }
    return undefined;
  };
  const status = (n: unknown, what: string) => (typeof n === 'number' && Number.isInteger(n) && n >= 100 && n <= 599 ? undefined : `${what} is a status between 100 and 599`);
  switch (r.kind) {
    case 'redirect': {
      if (!r.redirect?.host?.trim() && !r.redirect?.rewrite) return 'A redirect rule needs a host (host:port) or a path rewrite';
      const rw = r.redirect.rewrite;
      if (rw) {
        if (!rw.from) return 'A path rewrite needs the text or pattern to find';
        if (typeof rw.to !== 'string') return 'A path rewrite needs what the path becomes';
        if (rw.regex) return regex(rw.from, 'The path pattern');
      }
      return undefined;
    }
    case 'remap':
      if (!r.match.host?.trim()) return 'A remap rule needs the host to remap (Domain)';
      if (!r.remap?.to?.trim()) return 'A remap rule needs where the host goes (host, IP or host:port)';
      if (/[\s/]/.test(r.remap.to.trim())) return 'Where the host goes is a host, an IP address or host:port, without a scheme or a path';
      return undefined;
    case 'fault': {
      const f = r.fault;
      if (!f || !['drop', 'timeout', 'truncate', 'error'].includes(f.action)) return 'A fault rule needs an action: drop, timeout, truncate or error';
      if (f.percent !== undefined && !(f.percent >= 1 && f.percent <= 100)) return 'The share of requests that fail is 1 to 100 percent';
      if (f.action === 'truncate' && !(Number.isInteger(f.bytes) && f.bytes! >= 0)) return 'Cutting a response needs the number of bytes to keep (0 or more)';
      if (f.action === 'error' && f.status !== undefined) return status(f.status, 'The error answer');
      if (f.action === 'timeout' && f.timeoutMs !== undefined && !(f.timeoutMs >= 1 && f.timeoutMs <= 300_000)) return 'The wait is 1 ms to 5 minutes';
      return undefined;
    }
    case 'frame': {
      const f = r.frame;
      if (!f || !['drop', 'replace', 'break', 'delay'].includes(f.action)) return 'A frame rule needs an action: drop, replace, break or delay';
      if (f.direction && !['sent', 'received', 'both'].includes(f.direction)) return 'A frame rule goes one way (sent, received) or both';
      if (f.action === 'replace' && f.find === undefined && f.replace === undefined) return 'Replacing a frame needs the new text (and the text to find, or the whole frame is replaced)';
      if (f.action === 'delay' && !(f.delayMs! > 0 && f.delayMs! <= 60_000)) return 'Holding a frame back takes 1 ms to 60 s';
      if (f.regex && f.find) return regex(f.find, 'The pattern');
      const w = /^\/(.+)\/[a-z]*$/.exec(f.when?.trim() ?? '');
      return w ? regex(w[1]!, 'The frame filter') : undefined;
    }
    case 'reply': {
      const p = r.reply;
      if (!p) return undefined;
      if (p.file === '' || p.folder === '') return 'Name the file or folder to answer from'
      if (p.file && p.folder) return 'A reply reads one file or one folder, not both';
      for (const [v, what] of [[p.file, 'The file'], [p.folder, 'The folder']] as const) if (v && !isInsidePath(v)) return `${what} must be a path inside the workspace (no .., no drive or root)`;
      if (p.stripPrefix && !p.stripPrefix.startsWith('/')) return 'The part of the path to leave out starts with /';
      return undefined;
    }
    case 'modify':
      if (r.setStatus !== undefined) {
        const bad = status(r.setStatus, 'The status to answer with');
        if (bad) return bad;
      }
      return replaces(r.requestReplace, 'The request body') ?? replaces(r.responseReplace, 'The response body');
    default:
      return undefined;
  }
}
