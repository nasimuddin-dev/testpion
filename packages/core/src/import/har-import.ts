import type { BodyConfig, Collection, CollectionNode, SavedHttpRequest } from '../model/types.js';
import { SCHEMA_VERSION } from '../model/types.js';
import { shortId, slugify } from '../util/ids.js';
import { newDocument, type ImportDocument } from './model.js';

function newCollection(name: string, items: CollectionNode[], extra: Partial<Collection> = {}): Collection {
  return { schemaVersion: SCHEMA_VERSION, id: slugify(name) + '-' + shortId().slice(-4), name, version: 0, variables: [], items, updatedAt: new Date().toISOString(), ...extra };
}

/** A HAR file (browser developer tools, proxies) as an import document: a request per entry, with its status as a check. */
export function parseHar(text: string): ImportDocument {
  return newDocument('har', text, { tool: 'HAR', collections: [importHar(text).collection] });
}

export function importHar(text: string): { collection: Collection } {
  const d = JSON.parse(text);
  const items: CollectionNode[] = (d.log?.entries ?? []).map((e: any): SavedHttpRequest => {
    const r = e.request;
    const u = new URL(r.url);
    const mime = r.postData?.mimeType ?? '';
    let body: BodyConfig | undefined;
    if (r.postData?.params?.length && /urlencoded/.test(mime)) body = { type: 'form-urlencoded', fields: r.postData.params.map((p: any) => ({ key: p.name, value: p.value ?? '' })) };
    else if (r.postData?.text !== undefined) body = { type: /json/.test(mime) ? 'json' : /xml/.test(mime) ? 'xml' : 'text', content: r.postData.text };
    return {
      kind: 'http',
      id: shortId('req-'),
      name: `${r.method} ${u.pathname}`,
      request: {
        method: r.method,
        url: `${u.origin}${u.pathname}`,
        params: [...u.searchParams].map(([key, value]) => ({ key, value })),
        headers: (r.headers ?? []).filter((h: any) => !/^(:|content-length|host|connection|accept-encoding|cookie)/i.test(h.name)).map((h: any) => ({ key: h.name, value: h.value })),
        cookies: (r.cookies ?? []).map((c: any) => ({ key: c.name, value: c.value })),
        body,
      },
      assertions: e.response?.status ? [{ type: 'status', expected: e.response.status }] : undefined,
    };
  });
  return { collection: newCollection(`HAR import ${new Date().toISOString().slice(0, 10)}`, items) };
}

