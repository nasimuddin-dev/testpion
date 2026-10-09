import type { Tokens } from 'marked';
import { nodeRequire } from '../util/lazy-require.js';
import type { Collection } from '../model/types.js';
import { collectionMarkdown, type CollectionDocsOptions } from './collection-docs.js';

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/<[^>]+>/g, '')
    .replace(/&[a-z#0-9]+;/g, '')
    .replace(/[^\w]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'section';

/**
 * A collection's documentation as one self-contained HTML page (Postman's "Publish documentation"):
 * a sidebar of folders and requests with search, the Markdown docs rendered, copy buttons on code.
 * Raw HTML in descriptions is shown as text, never run, so the page is safe to share and host. No
 * external resources; light and dark follow the viewer's system.
 */
export function collectionHtml(collection: Collection, opts: CollectionDocsOptions = {}): string {
  const md = collectionMarkdown(collection, opts);
  // `html` is already-escaped text (marked escapes it); tags are stripped
  const toc: Array<{ depth: number; id: string; html: string }> = [];
  const used = new Map<string, number>();
  // marked loads with the first document, not at startup (see util/lazy-require.ts)
  const { Marked } = (typeof require === 'function' ? require('marked') : nodeRequire('marked')) as typeof import('marked');
  const marked = new Marked({
    gfm: true,
    async: false,
    renderer: {
      // descriptions are user content: show raw HTML as text
      // (except the generator's own `<a id="…"></a>` anchors, which in-page links point to)
      html: ({ text }: Tokens.HTML | Tokens.Tag) => (/^\s*(<a id="[\w-]+">|<\/a>|<a id="[\w-]+"><\/a>)\s*$/.test(text) ? text : esc(text)),
      heading(this: { parser: { parseInline(t: Tokens.Heading['tokens']): string } }, { tokens, depth }: Tokens.Heading) {
        const inner = this.parser.parseInline(tokens);
        const base = slug(inner);
        const n = used.get(base) ?? 0;
        used.set(base, n + 1);
        const id = n ? `${base}-${n}` : base;
        // the Markdown's own contents list is the sidebar here
        if (depth >= 2 && depth <= 3 && id !== 'contents') toc.push({ depth, id, html: inner.replace(/<[^>]+>/g, '') });
        return `<h${depth} id="${id}"><a class="anchor" href="#${id}" aria-hidden="true">#</a>${inner}</h${depth}>\n`;
      },
      link({ href, title, text }: Tokens.Link) {
        const safe = /^(https?:|mailto:|#)/i.test(href) ? href : '#';
        const ext = /^https?:/i.test(safe) ? ' target="_blank" rel="noopener noreferrer"' : '';
        return `<a href="${esc(safe)}"${title ? ` title="${esc(title)}"` : ''}${ext}>${text}</a>`;
      },
      image({ href, text }: Tokens.Image) {
        return /^https:/i.test(href) ? `<img src="${esc(href)}" alt="${esc(text)}" loading="lazy">` : esc(text);
      },
    },
  });
  const body = marked.parse(md) as string;
  const nav = toc.map((t) => `<a class="toc d${t.depth}" href="#${t.id}">${t.html}</a>`).join('\n');
  const generated = new Date().toISOString().slice(0, 10);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="generator" content="TestPion">
<title>${esc(collection.name)} · API documentation</title>
<style>
:root{--bg:#ffffff;--panel:#f6f8fb;--fg:#0e1726;--muted:#5b6780;--line:#e3e8f0;--accent:#2f7bff;--code:#f2f5fa;color-scheme:light}
@media (prefers-color-scheme:dark){:root{--bg:#0b1020;--panel:#10172a;--fg:#e6ebf5;--muted:#95a2bc;--line:#222c44;--accent:#5b9bff;--code:#131c33;color-scheme:dark}}
*{box-sizing:border-box}html{scroll-padding-top:16px}
body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.6 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
.layout{display:grid;grid-template-columns:290px minmax(0,1fr);min-height:100vh}
aside{position:sticky;top:0;height:100vh;overflow:auto;background:var(--panel);border-right:1px solid var(--line);padding:18px 12px}
aside .title{font-weight:700;font-size:16px;margin:0 6px 12px}
aside input{width:100%;padding:7px 10px;border:1px solid var(--line);border-radius:8px;background:var(--bg);color:var(--fg);margin-bottom:10px;font:inherit;font-size:13px}
.toc{display:block;padding:4px 8px;border-radius:6px;color:var(--fg);text-decoration:none;font-size:13.5px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.toc.d3{padding-left:22px;color:var(--muted)}.toc:hover{background:var(--line)}.toc.active{color:var(--accent);font-weight:600}
main{padding:36px 48px 80px;max-width:980px}
h1{font-size:30px;margin:0 0 12px}h2{margin-top:44px;padding-top:14px;border-top:1px solid var(--line)}h3{margin-top:30px}
h1,h2,h3,h4{position:relative}.anchor{position:absolute;left:-20px;color:var(--muted);text-decoration:none;opacity:0}h1:hover .anchor,h2:hover .anchor,h3:hover .anchor,h4:hover .anchor{opacity:1}
a{color:var(--accent)}code{font:13px/1.5 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;background:var(--code);padding:1px 5px;border-radius:5px}
pre{position:relative;background:var(--code);border:1px solid var(--line);border-radius:10px;padding:14px 16px;overflow:auto}pre code{padding:0;background:none}
pre button{position:absolute;top:8px;right:8px;font:12px system-ui;padding:3px 8px;border-radius:6px;border:1px solid var(--line);background:var(--bg);color:var(--muted);cursor:pointer;opacity:0}pre:hover button{opacity:1}
table{border-collapse:collapse;width:100%;font-size:14px;margin:12px 0}th,td{border:1px solid var(--line);padding:6px 10px;text-align:left;vertical-align:top}th{background:var(--panel)}
blockquote{margin:12px 0;padding:6px 14px;border-left:3px solid var(--accent);background:var(--panel);border-radius:0 8px 8px 0;color:var(--muted)}
img{max-width:100%}footer{margin-top:60px;color:var(--muted);font-size:12.5px}
.hidden{display:none}
@media (max-width:820px){.layout{grid-template-columns:1fr}aside{position:static;height:auto;max-height:45vh}main{padding:24px 16px 60px}.anchor{display:none}}
@media print{aside{display:none}.layout{display:block}pre button{display:none}}
</style>
</head>
<body>
<div class="layout">
<aside>
<div class="title">${esc(collection.name)}</div>
<input type="search" id="q" placeholder="Search requests…" aria-label="Search requests">
<nav id="toc">
${nav}
</nav>
</aside>
<main>
${body}
<footer>Generated by TestPion on ${generated}. Sensitive values are masked.</footer>
</main>
</div>
<script>
(function () {
  document.querySelectorAll('pre').forEach(function (pre) {
    var b = document.createElement('button'); b.type = 'button'; b.textContent = 'Copy';
    b.onclick = function () { navigator.clipboard.writeText(pre.innerText.replace(/Copy(ied)?$/, '')).then(function () { b.textContent = 'Copied'; setTimeout(function () { b.textContent = 'Copy'; }, 1200); }); };
    pre.appendChild(b);
  });
  var q = document.getElementById('q'), links = [].slice.call(document.querySelectorAll('#toc a'));
  q.addEventListener('input', function () { var v = q.value.toLowerCase(); links.forEach(function (a) { a.classList.toggle('hidden', !!v && a.textContent.toLowerCase().indexOf(v) < 0); }); });
  var byId = {}; links.forEach(function (a) { byId[a.getAttribute('href').slice(1)] = a; });
  if ('IntersectionObserver' in window) {
    var io = new IntersectionObserver(function (es) { es.forEach(function (e) { if (e.isIntersecting && byId[e.target.id]) { links.forEach(function (a) { a.classList.remove('active'); }); byId[e.target.id].classList.add('active'); } }); }, { rootMargin: '0px 0px -75% 0px' });
    document.querySelectorAll('main h2[id], main h3[id]').forEach(function (h) { io.observe(h); });
  }
})();
</script>
</body>
</html>
`;
}
