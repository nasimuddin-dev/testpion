import { plural } from './format';
/**
 * Release notes for the update dialog, as short plain text. electron-updater delivers the GitHub
 * release body as HTML (from the releases feed); the GitHub API delivers Markdown. Both become a
 * few "• headline" lines: the first sentence of each bullet, which is its bold title in our notes.
 */
const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', hellip: '…', mdash: '—', ndash: '–', rarr: '→' };

function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === '#') {
      const code = e[1]!.toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

/** HTML or Markdown release notes → plain text lines, bullets as "• ". */
export function notesToText(notes: string): string {
  const isHtml = /<\/?(p|ul|ol|li|h\d|strong|em|code|a|br)\b/i.test(notes);
  let t = notes.replace(/<!--[\s\S]*?-->/g, '');
  if (isHtml) {
    t = t
      .replace(/<li[^>]*>/gi, '\n• ')
      .replace(/<br\s*\/?>|<\/(p|li|h\d|ul|ol|div)>/gi, '\n')
      .replace(/<h\d[^>]*>[\s\S]*?<\/h\d>/gi, '')
      .replace(/<[^>]+>/g, '');
    t = decodeEntities(t);
  } else {
    t = t
      .replace(/^#+\s.*$/gm, '')
      .replace(/^\s*[-*+]\s+/gm, '• ')
      .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/(\*\*|__|`)/g, '');
  }
  return t
    .split('\n')
    .map((l) => l.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .join('\n');
}

/** The headline of each bullet (its first sentence), at most `max` of them, for the update dialog. */
export function summariseNotes(notes: string, max = 6): string {
  const lines = notesToText(notes).split('\n');
  const bullets = lines.filter((l) => l.startsWith('• '));
  if (!bullets.length) {
    const text = lines.join(' ');
    return text.length > 400 ? text.slice(0, 400).replace(/\s+\S*$/, '') + '…' : text;
  }
  const heads = bullets.slice(0, max).map((b) => {
    const body = b.slice(2);
    const m = /^(.+?[.!?])(\s|$)/.exec(body);
    const head = (m ? m[1]! : body).replace(/[.:]$/, '');
    return `• ${head.length > 120 ? head.slice(0, 120).replace(/\s+\S*$/, '') + '…' : head}`;
  });
  const more = bullets.length - heads.length;
  return heads.join('\n') + (more > 0 ? `\n…and ${plural(more, 'more change')}` : '');
}
