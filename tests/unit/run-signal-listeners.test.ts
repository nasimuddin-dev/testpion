import { describe, expect, it } from 'vitest';
import { McpManager, normalizeTest, ProviderRegistry, Redactor, runCollection, runTests, VariableScope, type Collection, type ExecServices } from '../../packages/core/src/index.js';

function services(): ExecServices {
  const vars = new VariableScope();
  const redactor = new Redactor();
  return { vars, providers: new ProviderRegistry([], vars, redactor), mcp: new McpManager(() => undefined), mcpServers: [], redactor, pricing: [], defaultTimeoutMs: 5000 };
}

/** A long-lived AbortController whose 'abort' listeners are counted. */
function countedController(): { ctrl: AbortController; live: Set<unknown> } {
  const ctrl = new AbortController();
  const live = new Set<unknown>();
  const add = ctrl.signal.addEventListener.bind(ctrl.signal);
  const remove = ctrl.signal.removeEventListener.bind(ctrl.signal);
  ctrl.signal.addEventListener = ((type: string, fn: EventListenerOrEventListenerObject, o?: AddEventListenerOptions | boolean) => {
    if (type === 'abort') live.add(fn);
    add(type, fn, o);
  }) as typeof ctrl.signal.addEventListener;
  ctrl.signal.removeEventListener = ((type: string, fn: EventListenerOrEventListenerObject, o?: EventListenerOptions | boolean) => {
    if (type === 'abort') live.delete(fn);
    remove(type, fn, o);
  }) as typeof ctrl.signal.removeEventListener;
  return { ctrl, live };
}

// The app keeps one AbortController for many runs: a finished run must take its 'abort' listener with it, or every
// run (its options, services and variables) stays reachable through the controller.
describe('run cancellation listeners', () => {
  it('20 runs on one long-lived AbortController leave no listener behind', async () => {
    const { ctrl, live } = countedController();
    for (let i = 0; i < 20; i++) {
      const summary = await runTests({
        name: `run ${i}`,
        tests: [normalizeTest({ id: 'a', name: 'a', type: 'delay', ms: 1 }), normalizeTest({ id: 'w', name: 'w', type: 'delay', ms: 1, dependsOn: ['a'] })],
        services: services(),
        signal: ctrl.signal,
      });
      expect(summary).toMatchObject({ passed: 2 });
    }
    expect(live.size).toBe(0);
  });

  it('20 collection runs leave no listener behind either', async () => {
    const { ctrl, live } = countedController();
    const collection = { id: 'c', name: 'One request', items: [{ kind: 'http', id: 'r', name: 'Refused', request: { method: 'GET', url: 'http://127.0.0.1:9/' } }] } as unknown as Collection;
    for (let i = 0; i < 20; i++) await runCollection({ name: `run ${i}`, collection, services: services(), signal: ctrl.signal });
    expect(live.size).toBe(0);
  });
});
