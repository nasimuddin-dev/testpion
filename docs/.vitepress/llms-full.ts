/**
 * The documentation as plain Markdown for AI agents (llmstxt.org): every page as `<page>.md` next to its HTML, and all of
 * them in one file, `llms-full.txt`. Written when the site is built (config.mts `buildEnd`), never committed, so it cannot
 * go stale. Pure: it turns the source of a page into what an agent should read.
 */
export interface PlainPage {
  /** The source path, e.g. `mcp/tools.md`. */
  path: string;
  title: string;
  description: string;
  /** The page as Markdown without front matter, containers or anchors. */
  body: string;
}

const frontMatter = (src: string): { data: Record<string, string>; rest: string } => {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(src);
  if (!m) return { data: {}, rest: src };
  const data: Record<string, string> = {};
  for (const line of m[1]!.split(/\r?\n/)) {
    const kv = /^([A-Za-z][\w-]*):\s*(.*)$/.exec(line);
    if (kv) data[kv[1]!] = kv[2]!.trim().replace(/^(["'])(.*)\1$/, '$2');
  }
  return { data, rest: src.slice(m[0].length) };
};

/** One page of the site as plain Markdown. `site` is the public address the site-absolute links (`/mcp/tools`) point into. */
export function plainPage(path: string, src: string, site: string): PlainPage {
  const { data, rest } = frontMatter(src.replace(/\r\n/g, '\n'));
  const base = site.replace(/\/+$/, '');
  let inFence = false;
  const lines: string[] = [];
  for (const raw of rest.split('\n')) {
    if (/^\s*(```|~~~)/.test(raw)) inFence = !inFence;
    if (inFence) {
      lines.push(raw);
      continue;
    }
    // a container fence (::: tip In short, ::: v-pre, :::): its title stays as a bold lead, the fence goes
    const open = /^:::\s*(\w[\w-]*)?\s*(.*)$/.exec(raw);
    if (open) {
      if (open[2]?.trim() && open[1] !== 'v-pre') lines.push(`**${open[2].trim()}**`);
      continue;
    }
    lines.push(
      raw
        .replace(/\s*\{#[\w-]+\}\s*$/, '')
        .replace(/<!--[\s\S]*?-->/g, '')
        // a link into the site: the address an agent can fetch
        .replace(/\]\((\/[^)\s#]*)(#[^)\s]*)?\)/g, (_m, p: string, hash = '') => `](${base}${p.replace(/\.md$/, '')}${hash})`),
    );
  }
  const body = lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
  const title = data.title || /^#\s+(.+)$/m.exec(body)?.[1] || path.replace(/\.md$/, '');
  return { path, title, description: data.description ?? '', body };
}

/** A page as its own Markdown file (`<page>.md` next to the HTML): its title, then its text. */
export const pageMarkdown = (p: PlainPage): string => `${/^#\s/.test(p.body) ? '' : `# ${p.title}\n\n`}${p.body}\n`;

/** All pages in one file: a header, then each page under its address. */
export function llmsFull(pages: PlainPage[], o: { site: string; name: string; summary: string; version: string }): string {
  const base = o.site.replace(/\/+$/, '');
  const head = [`# ${o.name} documentation (version ${o.version})`, '', `> ${o.summary}`, '', `Every page of ${base}/ as Markdown, in one file. The short index is ${base}/llms.txt; one page is ${base}/<page>.md.`, ''];
  const parts = pages.map((p) => {
    const url = `${base}/${p.path.replace(/(^|\/)index\.md$/, '$1').replace(/\.md$/, '')}`;
    // a page that starts with its own title needs no second one
    const titled = /^#\s/.test(p.body);
    return [`<!-- page: ${url} -->`, ...(titled ? [] : [`# ${p.title}`, '']), ...(p.description ? [`_${p.description}_`, ''] : []), p.body, ''].join('\n');
  });
  return [...head, ...parts].join('\n').replace(/\n{3,}/g, '\n\n').trimEnd() + '\n';
}
