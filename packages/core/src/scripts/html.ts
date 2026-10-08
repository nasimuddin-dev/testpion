import { parse, type HTMLElement, type Node } from 'node-html-parser';
import { BoundedMap } from '../util/collections.js';

/**
 * Host side of the sandbox's cheerio: parse HTML (a few documents are cached) and run CSS selectors.
 * Elements cross into the sandbox as plain data, identified by their path of child indexes from the root.
 */
export interface HtmlNode {
  path: number[];
  tag: string;
  attrs: Record<string, string>;
  text: string;
  html: string;
  outer: string;
}

const cache = new BoundedMap<string, HTMLElement>(4);
function rootOf(html: string): HTMLElement {
  let r = cache.get(html);
  if (!r) {
    r = parse(html, { comment: false, blockTextElements: { script: true, style: true, pre: true, noscript: true } });
    cache.set(html, r);
  }
  return r;
}

function pathOf(el: Node, root: HTMLElement): number[] {
  const path: number[] = [];
  let cur: Node | null = el;
  while (cur && cur !== root && cur.parentNode) {
    path.unshift(cur.parentNode.childNodes.indexOf(cur));
    cur = cur.parentNode;
  }
  return path;
}

function nodeAt(root: HTMLElement, path: number[]): HTMLElement | undefined {
  let cur: Node | undefined = root;
  for (const i of path) cur = cur?.childNodes[i];
  return cur as HTMLElement | undefined;
}

const MAX_NODES = 5000;

/** `op`: "find" (descendants matching the selector), "children" (element children, optionally matching), "parent". */
export function queryHtml(html: string, path: number[], op: string, selector: string): HtmlNode[] {
  const root = rootOf(html);
  const base = nodeAt(root, path);
  if (!base) return [];
  let found: HTMLElement[];
  if (op === 'parent') found = base.parentNode && base.parentNode !== root ? [base.parentNode] : [];
  else if (op === 'children') {
    const wanted = selector ? new Set(base.querySelectorAll(selector)) : undefined;
    found = base.children.filter((c) => !wanted || wanted.has(c));
  }
  else found = selector ? base.querySelectorAll(selector) : [];
  return found.slice(0, MAX_NODES).map((el) => ({
    path: pathOf(el, root),
    tag: (el.rawTagName ?? '').toLowerCase(),
    attrs: Object.fromEntries(Object.entries(el.attributes ?? {}).map(([k, v]) => [k.toLowerCase(), v])),
    text: el.text,
    html: el.innerHTML,
    outer: el.outerHTML,
  }));
}
