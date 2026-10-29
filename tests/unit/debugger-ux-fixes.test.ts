/**
 * The Debugger's correctness and UX fixes of the 2026-10-27 review: rule names, chips, presets, the Capture all traffic /
 * See inside HTTPS flow, one definition per action, the in-app menu paths, the keyboard route to the row menu.
 */
import { describe, expect, it, vi } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

vi.mock('sonner', () => ({ toast: Object.assign(vi.fn(), { error: vi.fn(), success: vi.fn() }) }));
vi.mock('../../apps/desktop/src/api', () => ({ call: vi.fn(), on: vi.fn() }));
vi.mock('../../apps/desktop/src/store', () => ({ useApp: { getState: () => ({ toast: vi.fn() }) } }));

const SRC = join(__dirname, '../../apps/desktop/src');
const files = (dir: string): string[] => readdirSync(dir).flatMap((f) => (statSync(join(dir, f)).isDirectory() ? files(join(dir, f)) : /\.tsx?$/.test(f) ? [join(dir, f)] : []));
const read = (rel: string) => readFileSync(join(SRC, rel), 'utf8');

describe('quick rule names', () => {
  it('a Filter out rule is named from what it matches, with =, never !=', async () => {
    const { quickRuleName, negatedLabel } = await import('../../apps/desktop/src/components/debugger/quick-filter');
    const labels = ['Domain = x.com', 'URL starts with https://x.com/a', 'Method = GET', 'Application = chrome'];
    for (const l of labels) {
      expect(quickRuleName('ignore', l)).toBe(`Filter out ${l}`);
      expect(quickRuleName('ignore', l)).not.toContain('!=');
      expect(quickRuleName('ignore', l)).not.toContain('does not start with');
      expect(quickRuleName('only', l)).toBe(`Capture only ${l}`);
    }
    // the menu line and the chip say what the click does to the view
    expect(negatedLabel('Domain = x.com')).toBe('Domain != x.com');
    expect(negatedLabel('URL starts with https://x.com/')).toBe('URL does not start with https://x.com/');
  });

  it('the row menu stores that name (the != stays on the menu line)', () => {
    const grid = read('components/debugger/DebuggerGrid.tsx');
    expect(grid).toContain('quickRuleName(kind as QuickKind, q.label)');
    expect(grid).not.toMatch(/name: `\$\{verb\} \$\{label\}`/);
  });
});

describe('chips', () => {
  const keep = { id: '1', label: 'Capture only Domain = a.com', keep: true, match: { host: 'a.com' } };
  const hide = { id: '2', label: 'Filter out Domain = b.com', keep: false, match: { host: 'b.com' } };

  it('read right for both kinds and say the rule stays', async () => {
    const { chipText, chipAria, chipTitle } = await import('../../apps/desktop/src/components/debugger/quick-filter');
    expect(chipText(keep)).toBe('Domain = a.com');
    expect(chipText(hide)).toBe('Domain != b.com');
    expect(chipAria(keep)).toBe('Show the rows hidden by Domain = a.com');
    expect(chipAria(hide)).toBe('Show the rows hidden by Domain != b.com');
    expect(chipTitle(keep)).toMatch(/Showing only/);
    expect(chipTitle(hide)).toMatch(/Hiding the rows where Domain = b\.com/);
    for (const q of [keep, hide]) expect(chipTitle(q)).toContain('The rule stays in Rules');
  });

  it('are never saved in a filter preset and ignored when one is loaded', async () => {
    const { presetOf, applyPreset } = await import('../../apps/desktop/src/components/debugger/quick-filter');
    const filter = { text: 'x', host: '', quick: [keep, hide] };
    expect(presetOf(filter)).toEqual({ text: 'x', host: '' });
    expect('quick' in presetOf(filter)).toBe(false);
    // an older preset that still carries chips: they are not restored, the ones on screen stay
    const loaded = applyPreset({ text: '', host: '', quick: [keep] }, { text: 'y', quick: [hide, hide] });
    expect(loaded.text).toBe('y');
    expect(loaded.quick).toEqual([keep]);
  });

  it('two Capture only chips keep the union of their rows', async () => {
    const { filterRows } = await import('../../apps/desktop/src/components/debugger/useExchangeList');
    const mk = (id: string, host: string) => ({ id, kind: 'http', method: 'GET', url: `https://${host}/p`, host }) as never;
    const empty = { application: '', type: '', text: '', deep: false, host: '', method: '', status: '' as const, bookmarked: false, hideTunnels: false };
    const all = [mk('a', 'a.com'), mk('b', 'b.com'), mk('c', 'c.com')];
    const q = (host: string, k = true) => ({ id: host, label: host, keep: k, match: { host } });
    expect(filterRows(all, { ...empty, quick: [q('a.com'), q('b.com')] }).map((e) => e.id)).toEqual(['a', 'b']);
    expect(filterRows(all, { ...empty, quick: [q('a.com'), q('b.com'), q('b.com', false)] }).map((e) => e.id)).toEqual(['a']);
  });

  it('the strip draws them with the chip tokens and the aria-label', () => {
    const view = read('views/DebuggerView.tsx');
    expect(view).toContain('bg-chip text-chip-fg');
    expect(view).toContain('aria-label={chipAria(q)}');
    expect(view).not.toMatch(/bg-accent-soft text-accent[^"]*"\s*\n?\s*title=\{?"Showing/);
  });
});

describe('Capture all traffic and See inside HTTPS', () => {
  const setup = (cert: Record<string, unknown>, opts: { proxyFails?: boolean; confirm?: boolean | boolean[] } = {}) => {
    const calls: Array<[string, unknown]> = [];
    const confirms: string[] = [];
    const answers = Array.isArray(opts.confirm) ? [...opts.confirm] : [];
    return import('../../apps/desktop/src/components/debugger/capture-flow').then(({ createCaptureFlow }) => {
      const flow = createCaptureFlow<unknown>({
        call: (async (method: string, params?: unknown) => {
          calls.push([method, params]);
          if (method === 'debug.systemProxy' && opts.proxyFails) throw new Error('no powershell');
          if (method === 'debug.certificate' && !params) return cert;
          return { ok: true };
        }) as never,
        confirm: async (o) => (confirms.push(o.cancelLabel), Array.isArray(opts.confirm) ? (answers.shift() ?? true) : (opts.confirm ?? true)),
        toast: () => undefined,
        fail: () => undefined,
        setStatus: () => undefined,
      });
      return { flow, calls, confirms };
    });
  };
  const names = (calls: Array<[string, unknown]>) => calls.map(([m, p]) => (p && typeof p === 'object' && 'action' in p ? `${m}:${(p as { action: string }).action}` : m));

  it('a trusted certificate: decryption goes on, nothing is asked or installed', async () => {
    const { flow, calls, confirms } = await setup({ trusted: true, known: true });
    await flow.readHttps();
    expect(confirms).toEqual([]);
    expect(names(calls)).toEqual(['debug.certificate', 'debug.decrypt']);
  });

  it('an unknown trust (undefined / known: false): the steps are shown once, nothing is installed, no second prompt', async () => {
    for (const cert of [{ trusted: undefined }, { trusted: false, known: false }]) {
      const { flow, calls, confirms } = await setup(cert, { confirm: true });
      await flow.readHttps();
      await flow.readHttps();
      expect(confirms).toHaveLength(1);
      expect(names(calls)).not.toContain('debug.certificate:install');
      expect(names(calls).filter((n) => n === 'debug.decrypt')).toHaveLength(2);
    }
  });

  it('a certificate that is not trusted asks, with the cancel label "Keep HTTPS as tunnels", and installs on yes', async () => {
    const { flow, calls, confirms } = await setup({ trusted: false, known: true }, { confirm: true });
    await flow.readHttps();
    expect(confirms).toEqual(['Keep HTTPS as tunnels']);
    expect(names(calls)).toEqual(['debug.certificate', 'debug.certificate:install', 'debug.decrypt']);
  });

  it('declined once, the next click asks again (the one-click path is not lost)', async () => {
    const { flow, calls, confirms } = await setup({ trusted: false, known: true }, { confirm: [false, true] });
    expect(await flow.readHttps()).toBe(false);
    expect(names(calls)).not.toContain('debug.decrypt');
    expect(await flow.readHttps()).toBe(true);
    expect(confirms).toHaveLength(2);
    expect(names(calls)).toContain('debug.decrypt');
  });

  it('when the system proxy fails, nothing else runs: no certificate question, no install', async () => {
    const { flow, calls, confirms } = await setup({ trusted: false, known: true }, { proxyFails: true });
    expect(await flow.captureAll()).toBe(false);
    expect(names(calls)).toEqual(['debug.systemProxy']);
    expect(confirms).toEqual([]);
  });

  it('on macOS and Linux the toast tells how to reach localhost', async () => {
    const { createCaptureFlow } = await import('../../apps/desktop/src/components/debugger/capture-flow');
    const said: string[] = [];
    const mk = (platform: string) => createCaptureFlow<unknown>({ call: (async () => ({})) as never, confirm: async () => true, toast: (m) => said.push(m), fail: () => undefined, setStatus: () => undefined, platform });
    await mk('darwin').systemProxy(true);
    await mk('win32').systemProxy(true);
    expect(said[0]).toContain('localhost.');
    expect(said[1]).not.toContain('localhost.');
  });

  it("decryption goes on from exactly one place in the window's code", () => {
    const hits = files(SRC).filter((f) => /'debug\.decrypt', \{ on: true \}/.test(readFileSync(f, 'utf8')));
    expect(hits.map((f) => f.slice(SRC.length + 1).replace(/\\/g, '/'))).toEqual(['components/debugger/capture-flow.ts']);
    const view = read('views/DebuggerView.tsx');
    expect(view).not.toMatch(/'debug\.decrypt', \{ on: !/);
    expect(view).not.toContain("'debug.decrypt', { on: true }");
  });
});

describe('one start button, one place per action', () => {
  const view = read('views/DebuggerView.tsx');

  it('the idle header has one primary start control, no "Start capturing"', () => {
    expect(view.match(/variant=\{status\?\.running \? 'default' : 'primary'\}/g)).toHaveLength(1);
    expect(view).not.toContain('Start capturing');
    expect(view).toContain('Only a program I point at the proxy');
    // the Capture menu no longer repeats "Everything on this computer"
    expect(view).not.toContain('Everything on this computer (the system proxy');
    const menu = view.slice(view.indexOf('const captureItems'), view.indexOf('const outputSpec'));
    expect(menu).not.toContain('captureAll');
  });

  it('clear() and saveSession() are referenced from at most two sites each', () => {
    expect((view.match(/\bclear\(\)/g) ?? []).length).toBeLessThanOrEqual(2);
    expect((view.match(/\bsaveSession\(\)/g) ?? []).length).toBeLessThanOrEqual(2);
    // the row menu has no Clear of its own; the strip, the Session menu and the rail read one definition
    expect(read('components/debugger/DebuggerGrid.tsx')).not.toMatch(/label: 'Clear'/);
    expect(view).toContain('acts.save');
    expect(view).toContain('acts.clear');
    expect(view).toContain('exportItems={transferItems}');
  });

  it('the shared session actions carry the disabled reason', async () => {
    const { sessionActions } = await import('../../apps/desktop/src/components/debugger/session-actions');
    const a = sessionActions({ canSave: false, canClear: false, save: () => undefined, clear: () => undefined });
    expect(a.save.disabled).toBe(true);
    expect(a.save.reason).toMatch(/Nothing captured/);
    expect(a.clear.disabled).toBe(true);
    expect(a.clear.reason).toMatch(/Nothing captured/);
  });

  it('Clear filters sits with the filters and Clear is at the far right behind a divider', () => {
    const at = (s: string) => view.indexOf(s);
    expect(at('data-clear-filters')).toBeGreaterThan(at('Presets'));
    expect(at('data-clear-filters')).toBeLessThan(at('data-session-actions'));
    expect(view).toMatch(/ml-auto flex items-center gap-1\.5 pl-2 border-l border-line" data-session-actions/);
  });

  it('Remove all is a labelled button with a reason, data-clear-rules kept', () => {
    const rules = read('components/debugger/DockRules.tsx');
    expect(rules).toMatch(/data-clear-rules[\s\S]{0,120}onClick=\{clearAll\}[\s\S]{0,40}Remove all/);
    expect(rules).toContain('reason={!rules.length');
  });
});

describe('what the window says about its own menus', () => {
  // every "Menu ▸ Item" in a string of the window names a menu and an item that exist
  const MENUS: Record<string, string[]> = {
    HTTPS: ['See inside HTTPS', 'Stop decrypting HTTPS', 'Root certificate', 'Keep hosts encrypted'],
    Capture: ['Proxy port', 'Stop capturing everything', 'Capture traffic for one API', 'Connections', 'A program'],
    Session: ['Save session', 'Clear the session', 'Export as HAR', 'Import a HAR file', 'Export as a Fiddler session', 'Import Fiddler rules', 'Compare with an earlier session', 'Share as a bundle', 'Open a bundle'],
    Debugger: ['Save session'],
  };
  it('each named item exists in the code that builds that menu', () => {
    const built = read('views/DebuggerView.tsx') + read('lib/vocabulary.ts') + read('components/debugger/DebuggerEnterprise.tsx');
    for (const [menu, items] of Object.entries(MENUS)) for (const i of items) expect(built, `${menu} ▸ ${i}`).toContain(i);
  });

  it('every path in a string uses only those items', () => {
    const bad: string[] = [];
    for (const f of files(SRC)) {
      const text = readFileSync(f, 'utf8');
      for (const m of text.matchAll(/\b(HTTPS|Capture|Session|Debugger)(?: menu)? ▸ ([^\n.,;:)'`"<(]+)/g)) {
        const item = m[2]!.replace(/…$/, '').trim();
        if (!MENUS[m[1]!]!.some((i) => item.startsWith(i))) bad.push(`${f.slice(SRC.length + 1)}: ${m[0]}`);
      }
    }
    expect(bad).toEqual([]);
  });

  it('the Keep this host encrypted item the advice names exists on the row menu', () => {
    expect(read('components/debugger/DebuggerGrid.tsx')).toContain("label: 'Keep this host encrypted'");
  });
});

describe('Keep this host encrypted and the keyboard route to the row menu', () => {
  it('is offered only while decryption is on or the row failed on the certificate', () => {
    const grid = read('components/debugger/DebuggerGrid.tsx');
    expect(grid).toMatch(/decrypt \|\| certificateError\(e\)/);
    const view = read('views/DebuggerView.tsx');
    expect(view).toContain('onKeepEncrypted={status?.decrypt || certificateError(sel)');
  });

  it('the certificate error test is one regular expression', async () => {
    const { certificateError } = await import('../../apps/desktop/src/components/debugger/ExchangeExtras');
    expect(certificateError({ error: 'The program did not trust the TestPion root certificate' })).toBe(true);
    expect(certificateError({ error: 'ECONNREFUSED' })).toBe(false);
    expect(certificateError({})).toBe(false);
  });

  it('Shift+F10 and the Menu key are the row menu keys', async () => {
    const { isMenuKey, openRowMenu } = await import('../../apps/desktop/src/components/debugger/row-menu-key');
    expect(isMenuKey({ key: 'F10', shiftKey: true })).toBe(true);
    expect(isMenuKey({ key: 'ContextMenu' })).toBe(true);
    expect(isMenuKey({ key: 'F10' })).toBe(false);
    expect(isMenuKey({ key: 'Enter', shiftKey: true })).toBe(false);
    // with a row on screen the same event a right-click sends reaches it
    const sent: Array<{ type: string; x: number }> = [];
    vi.stubGlobal('CSS', { escape: (s: string) => s });
    vi.stubGlobal('MouseEvent', class { constructor(public type: string, public init: { clientX: number }) {} });
    const row = { getBoundingClientRect: () => ({ left: 10, top: 100, height: 24 }), dispatchEvent: (e: { type: string; init: { clientX: number } }) => sent.push({ type: e.type, x: e.init.clientX }) };
    expect(openRowMenu({ querySelector: (q: string) => (q.includes('"a1"') ? row : null) } as never, 'a1')).toBe(true);
    expect(sent).toEqual([{ type: 'contextmenu', x: 34 }]);
    expect(openRowMenu({ querySelector: () => null } as never, 'gone')).toBe(false);
    vi.unstubAllGlobals();
  });

  it('DebuggerView routes the key to the selected row', () => {
    expect(read('views/DebuggerView.tsx')).toMatch(/isMenuKey\(ev\) && selected[\s\S]{0,120}openRowMenu\(ev\.currentTarget/);
  });
});

describe('the exchange summary is one component', () => {
  it('the request side has a Summary tab drawn by the dock panel, and no Overview', () => {
    const panes = read('components/debugger/ExchangePanes.tsx');
    expect(panes).toContain("label: 'Summary', render: () => <SummaryPanel e={e} />");
    expect(panes).not.toContain("label: 'Overview'");
    expect(read('components/debugger/ExchangeExtras.tsx')).not.toContain('OverviewView');
  });
});
