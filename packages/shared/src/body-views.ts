/**
 * Content-aware body views (FG-8): which views fit a body (by its content type and, when the type is missing or wrong, by
 * its first bytes), an XML tree, image facts read from the bytes, and the parts of a form or multipart body. The Debugger's
 * tabs, `testpion debug show --view` and the `debugger_exchange` tool's `view` option all read these, so they say the same.
 * Pure and bounded: an XML document is cut at MAX_XML_NODES elements, MAX_XML_DEPTH levels; nothing is fetched or executed;
 * entities other than the five built in and numeric references are never expanded (no DOCTYPE, no external entity).
 */
import { type Bytes, bytesFromBase64 } from './binary-decode.js';

export type BodyViewId = 'image' | 'xml' | 'html' | 'form' | 'graphql' | 'msgpack' | 'protobuf' | 'signalr' | 'socketio' | 'syntax';

export interface BodyViewInput {
  contentType?: string;
  url?: string;
  /** The text of the body, when it was kept as text. */
  text?: string;
  /** The bytes, when it was kept as bytes (images and binary protocols). */
  bytes?: Bytes;
  /** The request is a GraphQL operation (see graphql-view.ts). */
  graphql?: boolean;
}

const typeOf = (ct?: string) => (ct ?? '').split(';')[0]!.trim().toLowerCase();

/** The image type of the first bytes, whatever the header says. */
export function sniffImage(b: Bytes): 'png' | 'jpeg' | 'gif' | 'webp' | 'bmp' | 'ico' | undefined {
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'png';
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpeg';
  if (b.length >= 6 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38) return 'gif';
  if (b.length >= 12 && b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return 'webp';
  if (b.length >= 2 && b[0] === 0x42 && b[1] === 0x4d) return 'bmp';
  if (b.length >= 4 && b[0] === 0 && b[1] === 0 && b[2] === 1 && b[3] === 0) return 'ico';
  return undefined;
}

/** The kinds of body whose bytes the Debugger keeps (as base64) because a view needs them: images and the binary protocols. */
export function keepsBytes(contentType?: string): boolean {
  const t = typeOf(contentType);
  return /^image\/(?!svg)/.test(t) || /msgpack|messagepack|protobuf|x-protobuffer|octet-stream/.test(t);
}

/** Which views fit this body, the likeliest first. Empty for plain text and JSON (the Content and JSON tabs cover them). */
export function bodyViewsOf(i: BodyViewInput): BodyViewId[] {
  const t = typeOf(i.contentType);
  const head = (i.text ?? '').trimStart().slice(0, 200);
  const out: BodyViewId[] = [];
  if (i.bytes && sniffImage(i.bytes)) out.push('image');
  else if (/^image\//.test(t)) out.push('image');
  if (t === 'image/svg+xml' || /^<svg[\s>]/i.test(head) || (i.text && /^<\?xml[\s\S]{0,200}<svg[\s>]/i.test(head))) {
    if (!out.includes('image')) out.push('image');
  }
  if (i.graphql || t === 'application/graphql') out.push('graphql');
  if (/html/.test(t) || (!t && /^<!doctype html|^<html[\s>]/i.test(head))) out.push('html');
  if (/xml/.test(t) && t !== 'text/html' && !out.includes('image')) out.push('xml');
  else if ((!t || t === 'text/plain') && /^<\?xml\s/i.test(head)) out.push('xml');
  else if (t === 'image/svg+xml') out.push('xml');
  if (t === 'application/x-www-form-urlencoded' || /^multipart\//.test(t)) out.push('form');
  if (/msgpack|messagepack/.test(t)) out.push('msgpack');
  if (/protobuf|x-protobuffer|\+proto$/.test(t)) out.push('protobuf');
  if (i.text && i.text.includes('\u001e') && /^\s*\{/.test(head)) out.push('signalr');
  if (/\/socket\.io\//.test(i.url ?? '') && i.text && /^(\d+:)?\d/.test(i.text)) out.push('socketio');
  if (/css|javascript|ecmascript|sql|x-sh|shellscript/.test(t) || /\.(css|m?js|sql|sh)(\?|$)/i.test(i.url ?? '')) out.push('syntax');
  return out;
}

/** The highlighting language of a text body for the Syntax view. */
export function syntaxLanguageOf(contentType: string | undefined, url?: string): 'css' | 'code' | 'xml' | 'yaml' | 'json' | undefined {
  const t = typeOf(contentType);
  if (/css/.test(t) || /\.css(\?|$)/i.test(url ?? '')) return 'css';
  if (/javascript|ecmascript|sql|shellscript|x-sh|graphql/.test(t) || /\.(m?js|sql|sh)(\?|$)/i.test(url ?? '')) return 'code';
  if (/yaml/.test(t)) return 'yaml';
  if (/xml/.test(t)) return 'xml';
  if (/json/.test(t)) return 'json';
  return undefined;
}

/* ---------------------------------------------------------------- images */

export interface ImageFacts {
  /** png, jpeg, gif, webp, bmp, ico or svg. */
  format: string;
  width?: number;
  height?: number;
  /** The size of the body on the wire, in bytes. */
  bytes: number;
  /** An animation (gif frames, an animated webp) or other note worth saying. */
  note?: string;
}

const u16be = (b: Bytes, i: number) => (b[i]! << 8) | b[i + 1]!;
const u32be = (b: Bytes, i: number) => ((b[i]! << 24) | (b[i + 1]! << 16) | (b[i + 2]! << 8) | b[i + 3]!) >>> 0;
const u16le = (b: Bytes, i: number) => b[i]! | (b[i + 1]! << 8);
const u24le = (b: Bytes, i: number) => b[i]! | (b[i + 1]! << 8) | (b[i + 2]! << 16);

/** Format, dimensions and size read from the bytes of an image (no decoding of pixels). */
export function imageFacts(b: Bytes, totalBytes = b.length): ImageFacts | undefined {
  const format = sniffImage(b);
  if (!format) return undefined;
  const out: ImageFacts = { format, bytes: totalBytes };
  if (format === 'png' && b.length >= 24) {
    out.width = u32be(b, 16);
    out.height = u32be(b, 20);
  } else if (format === 'gif' && b.length >= 10) {
    out.width = u16le(b, 6);
    out.height = u16le(b, 8);
  } else if (format === 'bmp' && b.length >= 26) {
    out.width = b[18]! | (b[19]! << 8) | (b[20]! << 16) | (b[21]! << 24);
    out.height = Math.abs(b[22]! | (b[23]! << 8) | (b[24]! << 16) | (b[25]! << 24));
  } else if (format === 'ico' && b.length >= 8) {
    out.width = b[6] || 256;
    out.height = b[7] || 256;
    out.note = `${u16le(b, 4)} size(s) in the icon`;
  } else if (format === 'jpeg') {
    // walk the segments to the first start-of-frame marker
    let i = 2;
    for (let n = 0; n < 64 && i + 9 < b.length; n++) {
      if (b[i] !== 0xff) break;
      const marker = b[i + 1]!;
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        out.height = u16be(b, i + 5);
        out.width = u16be(b, i + 7);
        break;
      }
      i += 2 + u16be(b, i + 2);
    }
  } else if (format === 'webp' && b.length >= 30) {
    const kind = String.fromCharCode(b[12]!, b[13]!, b[14]!, b[15]!);
    if (kind === 'VP8 ') {
      out.width = u16le(b, 26) & 0x3fff;
      out.height = u16le(b, 28) & 0x3fff;
    } else if (kind === 'VP8L') {
      const v = (b[21]! | (b[22]! << 8) | (b[23]! << 16) | (b[24]! << 24)) >>> 0;
      out.width = (v & 0x3fff) + 1;
      out.height = ((v >>> 14) & 0x3fff) + 1;
    } else if (kind === 'VP8X') {
      out.width = u24le(b, 24) + 1;
      out.height = u24le(b, 27) + 1;
      if (b[20]! & 2) out.note = 'animated';
    }
  }
  return out;
}

/** Width and height an SVG document states (viewBox or width/height attributes). */
export function svgFacts(text: string, totalBytes = text.length): ImageFacts {
  const root = /<svg\b[^>]*>/i.exec(text)?.[0] ?? '';
  const attr = (n: string) => new RegExp(`\\b${n}\\s*=\\s*["']([^"']+)["']`, 'i').exec(root)?.[1];
  const px = (v?: string) => (v && /^\s*\d+(\.\d+)?(px)?\s*$/.test(v) ? Math.round(parseFloat(v)) : undefined);
  const vb = attr('viewBox')?.split(/[\s,]+/).map(Number);
  return {
    format: 'svg',
    bytes: totalBytes,
    width: px(attr('width')) ?? (vb && vb.length === 4 && Number.isFinite(vb[2]) ? Math.round(vb[2]!) : undefined),
    height: px(attr('height')) ?? (vb && vb.length === 4 && Number.isFinite(vb[3]) ? Math.round(vb[3]!) : undefined),
    note: /<script\b|\son\w+\s*=|<foreignObject\b/i.test(text) ? 'contains script or embedded content: shown as an image only, nothing runs' : undefined,
  };
}

/* ---------------------------------------------------------------- XML */

export interface XmlNode {
  /** Element name; `#text`, `#comment`, `#cdata`, `#pi` for the rest. */
  name: string;
  attrs?: Array<[string, string]>;
  text?: string;
  children?: XmlNode[];
}

export interface XmlResult {
  root?: XmlNode;
  /** Where it stopped being XML, or why it was cut short. */
  error?: string;
  /** The tree was cut at a limit. */
  truncated?: boolean;
  elements: number;
}

const MAX_XML_NODES = 5000;
const MAX_XML_DEPTH = 64;
const MAX_XML_CHARS = 1024 * 1024;
const ENTITIES: Record<string, string> = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };

const unescapeXml = (s: string) =>
  s.replace(/&(#x[0-9a-fA-F]{1,6}|#\d{1,7}|[a-z]+);/g, (m, e: string) => {
    if (e[0] === '#') {
      const code = e[1] === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : m;
    }
    return ENTITIES[e] ?? m; // an entity declared in a DOCTYPE is left as written, never expanded
  });

/** A small, strict-enough XML reader for display: elements, attributes, text, comments, CDATA; a DOCTYPE is skipped unread. */
export function parseXml(text: string): XmlResult {
  if (text.length > MAX_XML_CHARS) return { error: `Over ${MAX_XML_CHARS / 1024} KB: shown as text`, elements: 0 };
  let i = 0;
  let elements = 0;
  let truncated = false;
  const stack: XmlNode[] = [];
  let root: XmlNode | undefined;
  const add = (n: XmlNode) => {
    const parent = stack[stack.length - 1];
    if (parent) (parent.children ??= []).push(n);
    else if (n.name[0] !== '#') root ??= n;
  };
  const fail = (msg: string): XmlResult => ({ root, error: `${msg} (at character ${i})`, truncated, elements });
  while (i < text.length) {
    const lt = text.indexOf('<', i);
    const chunk = text.slice(i, lt < 0 ? text.length : lt);
    if (chunk.trim() && stack.length) add({ name: '#text', text: unescapeXml(chunk.trim()) });
    if (lt < 0) break;
    i = lt;
    if (text.startsWith('<!--', i)) {
      const end = text.indexOf('-->', i + 4);
      if (end < 0) return fail('A comment is not closed');
      if (stack.length) add({ name: '#comment', text: text.slice(i + 4, end).trim() });
      i = end + 3;
    } else if (text.startsWith('<![CDATA[', i)) {
      const end = text.indexOf(']]>', i);
      if (end < 0) return fail('A CDATA section is not closed');
      add({ name: '#cdata', text: text.slice(i + 9, end) });
      i = end + 3;
    } else if (text.startsWith('<?', i)) {
      const end = text.indexOf('?>', i);
      if (end < 0) return fail('A processing instruction is not closed');
      i = end + 2;
    } else if (text.startsWith('<!', i)) {
      // <!DOCTYPE …>, with an internal subset in brackets: skipped, never read
      let depth = 0;
      let j = i + 2;
      for (; j < text.length; j++) {
        const c = text[j];
        if (c === '[') depth++;
        else if (c === ']') depth--;
        else if (c === '>' && depth <= 0) break;
      }
      if (j >= text.length) return fail('A declaration is not closed');
      i = j + 1;
    } else if (text.startsWith('</', i)) {
      const end = text.indexOf('>', i);
      if (end < 0) return fail('A closing tag is not finished');
      const name = text.slice(i + 2, end).trim();
      const open = stack.pop();
      if (!open || open.name !== name) return fail(`</${name}> closes ${open ? `<${open.name}>` : 'nothing'}`);
      i = end + 1;
    } else {
      const m = /^<([^\s/>]+)((?:\s+[^\s=/>]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>/.exec(text.slice(i, i + 4096));
      if (!m) return fail('A tag is not well formed');
      if (++elements > MAX_XML_NODES) {
        truncated = true;
        return { root, error: `Over ${MAX_XML_NODES} elements: the rest is not shown`, truncated, elements: elements - 1 };
      }
      const node: XmlNode = { name: m[1]! };
      const attrs = [...m[2]!.matchAll(/([^\s=]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)].map((a) => [a[1]!, unescapeXml(a[2] ?? a[3] ?? '')] as [string, string]);
      if (attrs.length) node.attrs = attrs;
      add(node);
      if (!m[3]) {
        if (stack.length >= MAX_XML_DEPTH) return { root, error: `Nested deeper than ${MAX_XML_DEPTH} levels`, truncated: true, elements };
        stack.push(node);
      }
      i += m[0].length;
    }
  }
  if (stack.length) return fail(`<${stack[stack.length - 1]!.name}> is never closed`);
  if (!root) return { error: 'No element found', elements };
  return { root, elements };
}

/** The tree as indented text (the CLI / MCP form), one element per line with its attributes and text. */
export function xmlOutline(n: XmlNode, depth = 0): string {
  const pad = '  '.repeat(depth);
  if (n.name === '#text') return `${pad}"${n.text}"`;
  if (n.name === '#comment') return `${pad}<!-- ${n.text} -->`;
  if (n.name === '#cdata') return `${pad}<![CDATA[${n.text}]]>`;
  const attrs = (n.attrs ?? []).map(([k, v]) => ` ${k}="${v}"`).join('');
  const kids = n.children ?? [];
  if (kids.length === 1 && kids[0]!.name === '#text') return `${pad}<${n.name}${attrs}> ${kids[0]!.text}`;
  return [`${pad}<${n.name}${attrs}>`, ...kids.map((c) => xmlOutline(c, depth + 1))].join('\n');
}

/* ---------------------------------------------------------------- forms and multipart */

export interface FormPart {
  name: string;
  /** The file name, when the part is a file. */
  filename?: string;
  contentType?: string;
  /** Bytes in the part. */
  size: number;
  /** The value for a text part (cut at 2,000 characters); a file shows its size and type instead. */
  value?: string;
}

export interface FormResult {
  kind: 'urlencoded' | 'multipart';
  parts: FormPart[];
  truncated?: boolean;
}

const MAX_PARTS = 500;
const dec = (s: string) => {
  try {
    return decodeURIComponent(s.replace(/\+/g, ' '));
  } catch {
    return s;
  }
};
const cut = (s: string) => (s.length > 2000 ? `${s.slice(0, 2000)}…` : s);

/** The fields of an urlencoded body or the parts of a multipart body (text kept as text: a binary file's content is not shown). */
export function parseForm(contentType: string | undefined, body: string): FormResult | undefined {
  const t = typeOf(contentType);
  if (t === 'application/x-www-form-urlencoded') {
    const all = body.split('&').filter(Boolean);
    return {
      kind: 'urlencoded',
      truncated: all.length > MAX_PARTS || undefined,
      parts: all.slice(0, MAX_PARTS).map((p) => {
        const k = p.indexOf('=');
        const value = dec(k < 0 ? '' : p.slice(k + 1));
        return { name: dec(k < 0 ? p : p.slice(0, k)), size: value.length, value: cut(value) };
      }),
    };
  }
  const boundary = /multipart\//.test(t) ? /boundary=(?:"([^"]+)"|([^;\s]+))/i.exec(contentType ?? '') : undefined;
  if (!boundary) return undefined;
  const b = `--${boundary[1] ?? boundary[2]}`;
  const sections = body.split(b).slice(1);
  const parts: FormPart[] = [];
  for (const s of sections) {
    if (s.startsWith('--')) break;
    if (parts.length >= MAX_PARTS) return { kind: 'multipart', parts, truncated: true };
    const clean = s.replace(/^\r?\n/, '');
    const split = /\r?\n\r?\n/.exec(clean);
    const head = split ? clean.slice(0, split.index) : clean;
    const content = split ? clean.slice(split.index + split[0].length).replace(/\r?\n$/, '') : '';
    const disp = /^content-disposition:\s*(.*)$/im.exec(head)?.[1] ?? '';
    const name = /\bname="([^"]*)"/i.exec(disp)?.[1] ?? '';
    const filename = /\bfilename="([^"]*)"/i.exec(disp)?.[1];
    const ptype = /^content-type:\s*(.*)$/im.exec(head)?.[1]?.trim();
    const isText = !filename || /^text\/|json|xml/.test(ptype ?? '');
    parts.push({ name, filename, contentType: ptype, size: content.length, value: isText ? cut(content) : undefined });
  }
  return { kind: 'multipart', parts };
}

/** Bytes of a body that was kept as base64 (an image, a binary protocol). */
export function bytesOfBase64(b64?: string): Bytes | undefined {
  if (!b64) return undefined;
  try {
    return bytesFromBase64(b64);
  } catch {
    return undefined;
  }
}
