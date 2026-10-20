import type { BruBlock } from './bru.js';

type Any = Record<string, any>;

/**
 * The parts of Bruno's .bru language beyond the flat blocks: the nested dictionaries of a response example
 * (`example { name: … request: { … } response: { status: { code: 200 } body: { type: json content: ''' … ''' } } }`) and
 * the gRPC / WebSocket requests (`grpc { url, method … }`, `body:grpc { name: message 1 content: ''' … ''' }`, `ws { url … }`).
 * They become the shapes of Bruno's JSON export, which the Bruno importer reads.
 */

/** Parse the inside of a nested block: `key: value`, `key: { … }` and `key: '''…'''` (multi-line text). */
export function parseBruDict(text: string): Any {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  let i = 0;
  const unindent = (ls: string[]) => {
    const pad = Math.min(...ls.filter((l) => l.trim()).map((l) => /^\s*/.exec(l)![0].length), 1e9);
    return ls.map((l) => l.slice(Math.min(pad, /^\s*/.exec(l)![0].length))).join('\n');
  };
  const readBlock = (): Any => {
    const out: Any = {};
    while (i < lines.length) {
      const raw = lines[i]!;
      const line = raw.trim();
      i++;
      if (!line) continue;
      if (line === '}') return out;
      const m = /^(~?)([^:{]+?)\s*:\s*(.*)$/.exec(line);
      if (!m) continue;
      const key = m[2]!.trim();
      const rest = m[3]!;
      if (rest === '{') out[key] = readBlock();
      else if (rest === "'''") {
        const body: string[] = [];
        while (i < lines.length && lines[i]!.trim() !== "'''") body.push(lines[i++]!);
        i++;
        out[key] = unindent(body);
      } else out[key] = rest.replace(/^['"]|['"]$/g, '');
    }
    return out;
  };
  return readBlock();
}

const headersOf = (h: Any | undefined) => Object.entries(h ?? {}).map(([name, value]) => ({ name, value: String(value), enabled: true }));

/** `example { … }` as {name, description, request, response} in the shape of Bruno's JSON export. */
export function bruExample(block: BruBlock): Any | undefined {
  const d = parseBruDict(block.text);
  if (!d.response && !d.request && !d.name) return undefined;
  const res = d.response ?? {};
  const req = d.request ?? {};
  const status = res.status && typeof res.status === 'object' ? res.status : { code: res.status };
  return {
    name: d.name ?? 'Example',
    description: d.description,
    request: { url: req.url, method: req.method, headers: headersOf(req.headers), body: req.body && typeof req.body === 'object' ? { type: req.body.type ?? req.mode, content: req.body.content } : undefined },
    // (an example with no response is read and reported by the importer, not dropped here)
    response: !d.response ? undefined : { status: Number(status.code) || undefined, statusText: status.text, headers: headersOf(res.headers), body: res.body && typeof res.body === 'object' ? { type: res.body.type, content: res.body.content } : res.body ? { type: 'text', content: String(res.body) } : undefined },
  };
}

/** `body:grpc` / `body:ws` hold the messages as repeated `name:` / `type:` / `content: '''…'''` groups. */
function messages(text: string): Array<{ name: string; type?: string; content: string }> {
  const out: Array<{ name: string; type?: string; content: string }> = [];
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  let cur: { name: string; type?: string; content: string } | undefined;
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i]!.trim();
    const m = /^(name|type|content)\s*:\s*(.*)$/.exec(t);
    if (!m) continue;
    if (m[1] === 'name') {
      cur = { name: m[2]!, content: '' };
      out.push(cur);
    } else if (!cur) continue;
    else if (m[1] === 'type') cur.type = m[2]!;
    else if (m[2] === "'''") {
      const body: string[] = [];
      while (i + 1 < lines.length && lines[i + 1]!.trim() !== "'''") body.push(lines[++i]!);
      i++;
      cur.content = body.map((l) => l.replace(/^ {2,6}/, '')).join('\n');
    } else cur.content = m[2]!;
  }
  return out;
}

const dictOf = (b: BruBlock | undefined): Any => Object.fromEntries((b?.entries ?? []).filter((e) => e.enabled).map((e) => [e.key, e.value]));
const nv = (b: BruBlock | undefined) => (b?.entries ?? []).map((e) => ({ name: e.key, value: e.value, enabled: e.enabled }));

/** A gRPC or WebSocket request file as an item of Bruno's JSON export (`grpc-request` / `ws-request`), or undefined. */
export function bruRealtimeItem(blocks: BruBlock[], meta: Any, fallbackName: string): Any | undefined {
  const find = (n: string) => blocks.find((b) => b.name === n);
  const grpc = find('grpc');
  const ws = find('ws');
  if (grpc) {
    const g = dictOf(grpc);
    return { type: 'grpc-request', name: meta.name || fallbackName, seq: Number(meta.seq) || 0, request: { url: g.url ?? '', method: g.method ?? '', methodType: g.methodType, protoPath: g.protoPath, headers: nv(find('metadata') ?? find('headers')), body: { mode: 'grpc', grpc: messages(find('body:grpc')?.text ?? '') }, docs: find('docs')?.text } };
  }
  if (ws) {
    const w = dictOf(ws);
    return { type: 'ws-request', name: meta.name || fallbackName, seq: Number(meta.seq) || 0, request: { url: w.url ?? '', headers: nv(find('headers')), body: { mode: 'ws', ws: messages(find('body:ws')?.text ?? '') }, docs: find('docs')?.text } };
  }
  return undefined;
}
