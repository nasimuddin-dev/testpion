/** "Hide tunnels": the filter leaves out the CONNECT tunnels and keeps every other exchange. */
import { describe, expect, it, vi } from 'vitest';

vi.mock('sonner', () => ({ toast: Object.assign(vi.fn(), { error: vi.fn(), success: vi.fn() }) }));
vi.mock('../../apps/desktop/src/api', () => ({ call: vi.fn(), on: vi.fn() }));
vi.mock('../../apps/desktop/src/store', () => ({ useApp: { getState: () => ({ toast: vi.fn() }) } }));

const empty = { application: '', type: '', text: '', deep: false, host: '', method: '', status: '' as const, bookmarked: false, hideTunnels: false, quick: [] as never[] };
const row = (id: string, kind: 'http' | 'tunnel') => ({ id, kind, method: kind === 'tunnel' ? 'CONNECT' : 'GET', url: `https://x/${id}`, host: 'x' }) as never;

describe('hide tunnels filter', () => {
  it('drops the tunnels only when asked', async () => {
    const { filterRows } = await import('../../apps/desktop/src/components/debugger/useExchangeList');
    const all = [row('a', 'http'), row('b', 'tunnel'), row('c', 'http')];
    expect(filterRows(all, empty).map((e) => e.id)).toEqual(['a', 'b', 'c']);
    expect(filterRows(all, { ...empty, hideTunnels: true }).map((e) => e.id)).toEqual(['a', 'c']);
  });
});

describe('quick filters from a row menu', () => {
  it('= keeps the matching rows, != hides them, at once', async () => {
    const { filterRows } = await import('../../apps/desktop/src/components/debugger/useExchangeList');
    const mk = (id: string, host: string, method = 'GET') => ({ id, kind: 'http', method, url: `https://${host}/p`, host }) as never;
    const all = [mk('a', 'x.com:443'), mk('b', 'y.com:443'), mk('c', 'x.com:443', 'POST')];
    const only = { id: '1', label: 'Domain = x.com:443', keep: true, match: { host: 'x.com:443' } };
    const out = { id: '2', label: 'Method != POST', keep: false, match: { method: 'POST' } };
    expect(filterRows(all, { ...empty, quick: [only] }).map((e) => e.id)).toEqual(['a', 'c']);
    expect(filterRows(all, { ...empty, quick: [only, out] }).map((e) => e.id)).toEqual(['a']);
    expect(filterRows(all, { ...empty, quick: [{ ...only, keep: false }] }).map((e) => e.id)).toEqual(['b']);
  });
});
