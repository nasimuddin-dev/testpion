/** "Hide tunnels": the filter leaves out the CONNECT tunnels and keeps every other exchange. */
import { describe, expect, it, vi } from 'vitest';

vi.mock('sonner', () => ({ toast: Object.assign(vi.fn(), { error: vi.fn(), success: vi.fn() }) }));
vi.mock('../../apps/desktop/src/api', () => ({ call: vi.fn(), on: vi.fn() }));
vi.mock('../../apps/desktop/src/store', () => ({ useApp: { getState: () => ({ toast: vi.fn() }) } }));

const empty = { application: '', type: '', text: '', deep: false, host: '', method: '', status: '' as const, bookmarked: false, hideTunnels: false };
const row = (id: string, kind: 'http' | 'tunnel') => ({ id, kind, method: kind === 'tunnel' ? 'CONNECT' : 'GET', url: `https://x/${id}`, host: 'x' }) as never;

describe('hide tunnels filter', () => {
  it('drops the tunnels only when asked', async () => {
    const { filterRows } = await import('../../apps/desktop/src/components/debugger/useExchangeList');
    const all = [row('a', 'http'), row('b', 'tunnel'), row('c', 'http')];
    expect(filterRows(all, empty).map((e) => e.id)).toEqual(['a', 'b', 'c']);
    expect(filterRows(all, { ...empty, hideTunnels: true }).map((e) => e.id)).toEqual(['a', 'c']);
  });
});
