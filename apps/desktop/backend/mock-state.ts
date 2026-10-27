/** The running mock servers of a session: following their collection, and the status the window shows (the Backend methods delegate here). */
import { collectMockRoutes, type MockRoute } from '@testpion/core';
import type { Backend } from './backend.js';

/** A running mock server follows its collection: new or edited examples are served straight away. */
export function refreshMock(be: Backend, collectionId: string): void {
  const m = be.mocks.get(collectionId);
  if (!m) return;
  try {
    m.update(be.ws.getCollection(collectionId));
  } catch {
    /* collection deleted: keep the last routes until the server is stopped */
  }
}

/** Status of a collection's mock server; when stopped, the routes it would serve. */
export function mockInfo(be: Backend, collectionId: string) {
  const m = be.mocks.get(collectionId);
  const view = (routes: MockRoute[]) => routes.map((r) => ({ method: r.method, path: r.path, status: r.example.status, example: r.example.name, request: r.requestName, requestId: r.requestId }));
  if (m) return { running: true, url: m.url, port: m.port, routes: view(m.routes) };
  let routes: MockRoute[] = [];
  try {
    routes = collectMockRoutes(be.ws.getCollection(collectionId));
  } catch {
    /* unknown collection */
  }
  return { running: false, routes: view(routes) };
}
