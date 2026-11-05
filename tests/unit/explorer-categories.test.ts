import { describe, expect, it } from 'vitest';
import { categoryCounts, requestCategory } from '../../apps/desktop/src/lib/collection-filter.js';
import type { CollectionNode } from '../../apps/desktop/src/types.js';

const rest: CollectionNode = { kind: 'http', id: 'r', name: 'List pets', request: { method: 'GET', url: '{{baseUrl}}/pets' } };
const soapByBody: CollectionNode = { kind: 'http', id: 's1', name: 'Convert', request: { method: 'POST', url: '{{soap}}', body: { type: 'xml', content: '<soap:Envelope xmlns:soap="x"><soap:Body/></soap:Envelope>' } } };
const soapByHeader: CollectionNode = { kind: 'http', id: 's2', name: 'Action', request: { method: 'POST', url: '{{soap}}', headers: [{ key: 'SOAPAction', value: 'urn:x', enabled: true }] } };
const xmlNotSoap: CollectionNode = { kind: 'http', id: 'x', name: 'XML', request: { method: 'POST', url: '/x', body: { type: 'xml', content: '<order/>' } } };
const gql: CollectionNode = { kind: 'graphql', id: 'g', name: 'Countries', request: { endpoint: '/graphql', query: '{ countries { code } }' } };

describe('the kind of a saved request', () => {
  it('tells REST, SOAP and GraphQL requests apart', () => {
    expect(requestCategory(rest)).toBe('rest');
    expect(requestCategory(soapByBody)).toBe('soap');
    expect(requestCategory(soapByHeader)).toBe('soap');
    expect(requestCategory(xmlNotSoap)).toBe('rest');
    expect(requestCategory(gql)).toBe('graphql');
  });

  it('counts each kind through folders', () => {
    const tree: CollectionNode[] = [rest, { kind: 'folder', id: 'f', name: 'SOAP', items: [soapByBody, soapByHeader, { kind: 'folder', id: 'e', name: 'Empty', items: [] }] }];
    expect(categoryCounts(tree)).toEqual({ rest: 1, soap: 2, graphql: 0 });
  });
});
