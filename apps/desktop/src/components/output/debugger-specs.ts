import { extensionForMime, harFromExchange, jsonPretty, outputFileName, safeDownloadName, urlNamePart } from '@testpion/shared';
import { rawOf, type Exchange } from '../debugger/model';
import { saveOutput, type OutputFormatSpec, type OutputSpec } from './output-core';

/**
 * What can be downloaded from one Debugger exchange (the exchange panes' down arrow, and the grid's "Request body…" /
 * "Response body…"): its raw request and response, a one-entry HAR, and each body as the file it is. The exchange is
 * masked as it is captured (the session keeps no secrets), and the backend masks what it writes once more.
 */
export function exchangeOutputSpec(e: Exchange): OutputSpec {
  const status = e.error ? 'error' : e.status;
  const name = outputFileName({ method: e.method, name: [urlNamePart(e.url) ?? e.host, 'exchange'].join('-'), status, ext: '' });
  const bodyFile = (side: 'request' | 'response', type: string) => safeDownloadName(`${[urlNamePart(e.url) ?? e.host, side].join('-')}.${extensionForMime(type)}`, type);
  const body = (side: 'request' | 'response'): OutputFormatSpec[] => {
    const text = side === 'request' ? e.requestBody : e.responseBody;
    if (text === undefined) return [];
    const type = (side === 'request' ? e.requestHeaders['content-type'] : e.contentType) ?? '';
    return [{ key: `${side}-body`, format: 'raw', label: `${side === 'request' ? 'Request' : 'Response'} body (as kept)`, fileName: bodyFile(side, type), build: () => text }];
  };
  return {
    id: 'debugger.exchange',
    what: 'exchange',
    name,
    formats: [
      {
        key: 'text',
        format: 'text',
        label: 'Request and response (raw text)',
        default: true,
        build: () => {
          const raw = rawOf(e);
          return `${raw.request}\r\n\r\n${raw.response}\r\n`;
        },
      },
      {
        key: 'har',
        format: 'har',
        label: 'HAR (this exchange)',
        build: () =>
          jsonPretty(
            harFromExchange({
              method: e.method,
              url: e.url,
              requestHeaders: Object.entries(e.requestHeaders),
              requestBody: e.requestBody === undefined ? undefined : { text: e.requestBody, mimeType: e.requestHeaders['content-type'] },
              status: e.status ?? 0,
              statusText: e.statusText,
              httpVersion: e.httpVersion,
              headers: Object.entries(e.responseHeaders ?? {}),
              contentType: e.contentType,
              body: e.responseBody,
              size: e.responseBodyBytes,
              startedAt: e.startedAt,
              durationMs: e.durationMs,
              creator: 'TestPion Debugger',
            }),
          ),
      },
      ...body('request'),
      ...body('response'),
    ],
  };
}

/** Save one body of an exchange through the Save as dialog (the grid's row menu): the same writer as the panes' down arrow. */
export function saveExchangeBody(e: Exchange, side: 'request' | 'response'): Promise<void> {
  const spec = exchangeOutputSpec(e);
  const f = spec.formats.find((x) => x.key === `${side}-body`);
  if (!f) throw new Error(`The ${side} body was not kept (binary or larger than the capture keeps)`);
  return saveOutput({ ...spec, what: `${side} body` }, f);
}
