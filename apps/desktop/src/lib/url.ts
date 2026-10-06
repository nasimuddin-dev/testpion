import type { HttpRequestSpec } from '../types';

/**
 * Postman-style URL editing: the URL bar shows the query string, and the Params table mirrors it.
 * The engine stores the base URL and the params separately, so requests are converted at the edges.
 */
export { splitUrl, parseQuery, serializeParams, paramsFromUrl, urlFromParams, pathVariableNames, syncPathVariables } from '@testpion/shared';
import { splitUrl, parseQuery, urlFromParams, syncPathVariables } from '@testpion/shared';

/** UI form (query in URL) → engine form (base URL + params). */
export function toEngineRequest(r: HttpRequestSpec): HttpRequestSpec {
  return { ...r, url: splitUrl(r.url).base, params: r.params };
}

/** Engine form → UI form (query shown in the URL bar). */
export function fromEngineRequest(r: HttpRequestSpec): HttpRequestSpec {
  const { base, query } = splitUrl(r.url);
  const params = [...(query ? parseQuery(query) : []), ...(r.params ?? [])];
  return { ...r, params, url: urlFromParams(base, params), pathVariables: syncPathVariables(base, r.pathVariables) };
}
