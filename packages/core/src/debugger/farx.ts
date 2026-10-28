import { basename } from 'node:path';
import { ApsError } from '../errors.js';
import { shortId } from '../util/ids.js';
import { looksLikeZip, readZip } from '../transfer/zip.js';
import { compileUserRegex } from '../util/safe-regex.js';
import type { DebuggerRule } from './rules.js';

/**
 * Fiddler's AutoResponder rule archive (`.farx`), imported best effort (FG-22). The format is not published: this reads what
 * sample files contain, an XML document with a `<ResponseRule Match="…" Action="…" Enabled="…"/>` for each rule, and says for every
 * rule what became of it. Nothing is exported in this format. A rule that cannot be mapped is listed, never guessed.
 *
 * Match: `EXACT:url`, `regex:pattern`, `NOT:text`, or text that the URL contains. Action: a status file (`200_SimpleHTML.dat`),
 * a URL (Map Remote), `*redir:url`, `*bpu`, `*bpafter`, `*drop`, `*reset`, `*delay:ms`, `*CORSPreflightAllow`; a file on disk becomes
 * a Map Local rule that is switched off (the file has to be copied into the workspace first).
 */
export interface FarxItem {
  match: string;
  action: string;
  /** imported: a rule as it was; off: a rule that needs something first (it is switched off); skipped: not mapped. */
  result: 'imported' | 'off' | 'skipped';
  /** In words: what to do, or why it was skipped. */
  note?: string;
  rule?: string;
}

export interface FarxImport {
  rules: DebuggerRule[];
  items: FarxItem[];
  /** Fiddler's switch for the whole AutoResponder, when the file has one. */
  autoResponderEnabled?: boolean;
}

const decodeXml = (s: string): string => s.replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n))).replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16))).replace(/&amp;/g, '&');
const attrs = (tag: string): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const m of tag.matchAll(/([A-Za-z_][\w.-]*)\s*=\s*("([^"]*)"|'([^']*)')/g)) out[m[1]!.toLowerCase()] = decodeXml(m[3] ?? m[4] ?? '');
  return out;
};
const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
const SHORT = 60;
const short = (s: string) => (s.length > SHORT ? `${s.slice(0, SHORT - 1)}…` : s);

/** The rule's URL match, or the reason it cannot be one. */
function urlMatch(match: string): { url?: string; method?: string; not?: boolean; why?: string } {
  const m = /^(EXACT|REGEX|NOT|METHOD|URLWithBody|HEADER|FLAG|BODY|Header)\s*:(.*)$/is.exec(match.trim());
  const kind = m?.[1]?.toLowerCase();
  const text = m ? m[2]!.trim() : match.trim();
  if (!kind || kind === 'not') {
    if (!text) return { why: 'the match is empty' };
    // a plain text is "the URL contains it" (case does not matter); NOT: is the same, turned around, which a rule cannot say
    if (kind === 'not') return { why: 'NOT: (everything that does not contain the text) has no equivalent' };
    return { url: `*${text}*` };
  }
  if (kind === 'exact') {
    if (/[*?]/.test(text)) return { url: `/^${escapeRegex(text)}$/i` };
    return { url: text };
  }
  if (kind === 'regex') {
    const body = text.replace(/^\(\?([a-z]+)\)/i, '');
    try {
      compileUserRegex(body, 'i', 'The pattern');
    } catch (e) {
      return { why: (e as Error).message };
    }
    return { url: `/${body}/i` };
  }
  return { why: `${m![1]}: matches on more than the URL, which the rules here do not` };
}

function toRule(m: { url: string }, action: string, enabled: boolean, name: string): { rule?: DebuggerRule; off?: string; why?: string } {
  const base = { id: shortId('rule-'), name, enabled, match: { url: m.url } };
  const a = action.trim();
  const low = a.toLowerCase();
  if (!a) return { why: 'the action is empty' };
  if (low === '*bpu') return { rule: { ...base, kind: 'breakpoint', breakpoint: 'request' } };
  if (low === '*bpafter') return { rule: { ...base, kind: 'breakpoint', breakpoint: 'response' } };
  if (low === '*drop' || low === '*reset') return { rule: { ...base, kind: 'fault', fault: { action: 'drop' } } };
  const delay = /^\*delay:\s*(\d{1,6})$/i.exec(a);
  if (delay) return { rule: { ...base, kind: 'modify', delayMs: Number(delay[1]) } };
  const redir = /^\*redir:\s*(\S+)$/i.exec(a);
  if (redir) return { rule: { ...base, kind: 'reply', reply: { status: 302, headers: { location: redir[1]! } } } };
  if (low === '*corspreflightallow')
    return { rule: { ...base, match: { ...base.match, method: 'OPTIONS' }, kind: 'reply', reply: { status: 204, headers: { 'access-control-allow-origin': '*', 'access-control-allow-methods': '*', 'access-control-allow-headers': '*' } } } };
  if (low === '*exit') return { why: '*exit (stop at this rule) has no equivalent: every matching rule applies' };
  if (a.startsWith('*')) return { why: `${a.split(':')[0]} is not mapped` };
  const status = /^(\d{3})_[^\\/]*\.dat$/i.exec(basename(a.replace(/\\/g, '/')));
  if (status && !/[\\/]/.test(a)) return { rule: { ...base, kind: 'reply', reply: { status: Number(status[1]), body: '' } } };
  if (/^https?:\/\//i.test(a)) {
    let u: URL;
    try {
      u = new URL(a);
    } catch {
      return { why: 'the address is not a URL' };
    }
    return { rule: { ...base, kind: 'redirect', redirect: { host: u.host, scheme: u.protocol === 'https:' ? 'https' : 'http', rewrite: { from: '^.*$', to: `${u.pathname}${u.search}`, regex: true } } } };
  }
  // a file: the Map Local rule needs it inside the workspace
  const file = basename(a.replace(/^file:\/\/\/?/i, '').replace(/\\/g, '/'));
  if (!file) return { why: 'the action is not a file, a URL or a known command' };
  return { rule: { ...base, enabled: false, kind: 'reply', reply: { status: 200, file } }, off: `Copy ${file} into the workspace, then switch the rule on` };
}

/** The rules of a `.farx` file (XML text, or a zip holding one). */
export function rulesFromFarx(input: string | Buffer): FarxImport {
  let text: string;
  if (typeof input !== 'string' && looksLikeZip(input)) {
    const entries = readZip(input, undefined, 'FARX file');
    const hit = entries.find((e) => /ResponseRule/.test(e.data.toString('utf8')));
    if (!hit) throw new ApsError('ValidationError', 'No AutoResponder rules in that archive');
    text = hit.data.toString('utf8');
  } else text = typeof input === 'string' ? input : input.toString('utf8');
  if (text.length > 20 * 1024 * 1024) throw new ApsError('ValidationError', 'That rule file is larger than 20 MB');
  const tags = [...text.matchAll(/<ResponseRule\b([^>]*?)\/?>/gi)];
  if (!tags.length) throw new ApsError('ValidationError', 'No AutoResponder rules found (a .farx file holds <ResponseRule Match="…" Action="…"/> entries)', { suggestions: ['In Fiddler: AutoResponder ▸ Save, then import that file.'] });
  const state = /<State\b([^>]*)>/i.exec(text);
  const out: FarxImport = { rules: [], items: [] };
  if (state) out.autoResponderEnabled = attrs(state[1]!).enabled !== 'false';
  for (const t of tags.slice(0, 2000)) {
    const a = attrs(t[1]!);
    const match = a.match ?? '';
    const action = a.action ?? '';
    const enabled = a.enabled !== 'false';
    const u = urlMatch(match);
    if (!u.url) {
      out.items.push({ match, action, result: 'skipped', note: u.why });
      continue;
    }
    const made = toRule({ url: u.url }, action, enabled, `Fiddler: ${short(match)}`);
    if (!made.rule) {
      out.items.push({ match, action, result: 'skipped', note: made.why });
      continue;
    }
    out.rules.push(made.rule);
    out.items.push({ match, action, result: made.off ? 'off' : 'imported', ...(made.off ? { note: made.off } : {}), rule: made.rule.id });
  }
  return out;
}

/** A one-line account of an import, for the window and the tools. */
export function describeFarxImport(r: FarxImport): string {
  const n = (k: FarxItem['result']) => r.items.filter((i) => i.result === k).length;
  const parts = [`${n('imported')} imported`, ...(n('off') ? [`${n('off')} imported switched off`] : []), ...(n('skipped') ? [`${n('skipped')} skipped`] : [])];
  return `${r.items.length} Fiddler rule${r.items.length === 1 ? '' : 's'}: ${parts.join(', ')}`;
}
