/**
 * Render counting for the window's components in unit tests (the e2e suite has the same hook in e2e/render-count.cjs):
 * a minimal React DevTools hook, installed before React loads, that counts how often each component function mounted
 * and rendered again in the commits that follow. A change that must not render (or remount) a part of the window shows
 * as a count here, measured the same way before and after. This module imports no React: it must run first.
 */
interface Fiber {
  tag: number;
  type: unknown;
  flags: number;
  alternate: Fiber | null;
  child: Fiber | null;
  sibling: Fiber | null;
}

const mounted = new Map<string, number>();
const updated = new Map<string, number>();
let commits = 0;

const nameOf = (t: unknown): string | null => {
  if (!t) return null;
  if (typeof t === 'function') return (t as { displayName?: string; name?: string }).displayName || (t as { name?: string }).name || 'anonymous';
  const o = t as { displayName?: string; render?: { displayName?: string; name?: string }; type?: unknown };
  if (o.displayName) return o.displayName;
  if (o.render) return (o.render.displayName || o.render.name || 'anonymous') + '(forwardRef)';
  if (o.type) return nameOf(o.type);
  return null;
};
// function components (0), class components (1), forwardRef (11), memo wrappers (14) and simple memo components (15)
const renderable = (f: Fiber) => f.tag === 0 || f.tag === 1 || f.tag === 11 || f.tag === 14 || f.tag === 15;
const bump = (m: Map<string, number>, f: Fiber) => {
  const n = nameOf(f.type);
  if (n) m.set(n, (m.get(n) ?? 0) + 1);
};
const mountAll = (f: Fiber | null) => {
  for (let c = f; c; c = c.sibling) {
    if (renderable(c)) bump(mounted, c);
    if (c.child) mountAll(c.child);
  }
};
const update = (next: Fiber, prev: Fiber) => {
  if (renderable(next) && (next.flags & 1) === 1) bump(updated, next);
  if (next.child !== prev.child)
    for (let c = next.child; c; c = c.sibling) {
      if (c.alternate) update(c, c.alternate);
      else {
        if (renderable(c)) bump(mounted, c);
        if (c.child) mountAll(c.child);
      }
    }
};

/** Install the hook (once, before React is imported). */
export function installRenderCounter(): void {
  const g = globalThis as { __REACT_DEVTOOLS_GLOBAL_HOOK__?: unknown };
  if (g.__REACT_DEVTOOLS_GLOBAL_HOOK__) return;
  let id = 0;
  g.__REACT_DEVTOOLS_GLOBAL_HOOK__ = {
    supportsFiber: true,
    renderers: new Map(),
    inject(r: unknown) {
      (this as { renderers: Map<number, unknown> }).renderers.set(++id, r);
      return id;
    },
    checkDCE() {},
    onScheduleFiberRoot() {},
    onCommitFiberUnmount() {},
    onPostCommitFiberRoot() {},
    onCommitFiberRoot(_id: number, root: { current: Fiber }) {
      commits++;
      const cur = root.current;
      if (cur.alternate) update(cur, cur.alternate);
      else mountAll(cur);
    },
  };
}

export const renders = {
  reset() {
    mounted.clear();
    updated.clear();
    commits = 0;
  },
  commits: () => commits,
  /** How many instances of the component mounted since the reset. */
  mounts: (name: string) => mounted.get(name) ?? 0,
  /** How many times instances of the component rendered again since the reset. */
  updates: (name: string) => updated.get(name) ?? 0,
  /** Mounts and updates together. */
  of: (name: string) => (mounted.get(name) ?? 0) + (updated.get(name) ?? 0),
  report: () => `commits ${commits} · mounted ${[...mounted].map(([k, v]) => `${k} ${v}`).join(', ')} · updated ${[...updated].map(([k, v]) => `${k} ${v}`).join(', ')}`,
};

/** Browser globals the components touch on import or render, enough for a render without a DOM. */
export function installBrowserStubs(): void {
  const g = globalThis as Record<string, unknown>;
  const store = new Map<string, string>();
  // always ours: Node 24 has a localStorage of its own that throws without --localstorage-file
  Object.defineProperty(g, 'localStorage', { configurable: true, value: { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, String(v)), removeItem: (k: string) => void store.delete(k), clear: () => store.clear(), key: () => null, length: 0 } });
  g.addEventListener ??= () => undefined;
  g.removeEventListener ??= () => undefined;
  g.dispatchEvent ??= () => true;
  g.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
  g.requestAnimationFrame ??= (fn: (t: number) => void) => setTimeout(() => fn(Date.now()), 0) as unknown as number;
  g.cancelAnimationFrame ??= (id: number) => clearTimeout(id as unknown as NodeJS.Timeout);
  g.matchMedia ??= () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  if (!g.window) g.window = g;
  if (!g.navigator) g.navigator = { platform: 'Win32', clipboard: { writeText: async () => undefined } };
  if (!g.document)
    g.document = {
      querySelector: () => null,
      querySelectorAll: () => [],
      addEventListener() {},
      removeEventListener() {},
      visibilityState: 'visible',
      readyState: 'complete',
      activeElement: null,
      body: { appendChild() {}, removeChild() {}, classList: { add() {}, remove() {} } },
      documentElement: { dataset: {}, style: { setProperty() {} }, classList: { add() {}, remove() {} } },
      createElement: () => ({ style: {}, setAttribute() {}, appendChild() {}, remove() {} }),
      getElementById: () => null,
    };
}
