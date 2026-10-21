/**
 * Render counting for e2e plans (E2E_RENDER_COUNT=1; see harness.cjs): a minimal React DevTools hook, installed before the
 * app's scripts run, that counts how often each component function rendered in the commits that follow. Use it with a build made
 * with TESTPION_PROFILE=1 (readable component names). In a plan step:
 *
 *   window.__renders.reset();  ... type, filter, switch tabs ...  return window.__renders.report(12);
 *
 * `report(n)` is "commits 14 · components rendered 212 · List 14, Row 120 …": the n components that rendered most. A change that
 * should not re-render a part of the window shows as a lower count here, measured the same way before and after.
 */
const HOOK = `(() => {
  if (window.__renders) return;
  const counts = new Map();
  let commits = 0;
  const nameOf = (t) => {
    if (!t) return null;
    if (typeof t === 'function') return t.displayName || t.name || 'anonymous';
    if (t.displayName) return t.displayName;
    if (t.render) return (t.render.displayName || t.render.name || 'anonymous') + '(forwardRef)';
    return null;
  };
  // function components (0), class components (1), forwardRef (11) and simple memo components (15) that rendered
  const renderable = (f) => f.tag === 0 || f.tag === 1 || f.tag === 11 || f.tag === 15;
  const watched = new Set();
  const why = new Map();
  const count = (f) => {
    const n = nameOf(f.type);
    if (!n) return;
    counts.set(n, (counts.get(n) ?? 0) + 1);
    // watch(name): which props were new (by identity) when it rendered again
    if (watched.has(n) && f.alternate) {
      const a = f.alternate.memoizedProps ?? {}, b = f.memoizedProps ?? {};
      let any = false;
      for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) if (!Object.is(a[k], b[k])) (any = true), why.set(n + '.' + k, (why.get(n + '.' + k) ?? 0) + 1);
      if (!any) why.set(n + ' (props same: state, context or parent)', (why.get(n + ' (props same: state, context or parent)') ?? 0) + 1);
    }
  };
  const mount = (f) => {
    for (let c = f; c; c = c.sibling) {
      if (renderable(c)) count(c);
      if (c.child) mount(c.child);
    }
  };
  const update = (next, prev) => {
    if (renderable(next) && (next.flags & 1) === 1) count(next);
    if (next.child !== prev.child) {
      for (let c = next.child; c; c = c.sibling) {
        if (c.alternate) update(c, c.alternate);
        else {
          if (renderable(c)) count(c);
          if (c.child) mount(c.child);
        }
      }
    }
  };
  let id = 0;
  window.__REACT_DEVTOOLS_GLOBAL_HOOK__ = {
    supportsFiber: true,
    renderers: new Map(),
    inject(r) { this.renderers.set(++id, r); return id; },
    checkDCE() {},
    onScheduleFiberRoot() {},
    onCommitFiberUnmount() {},
    onPostCommitFiberRoot() {},
    onCommitFiberRoot(_id, root) {
      commits++;
      const cur = root.current;
      if (cur.alternate) update(cur, cur.alternate);
      else mount(cur);
    },
  };
  window.__renders = {
    reset() { counts.clear(); why.clear(); commits = 0; },
    watch(...names) { names.forEach((n) => watched.add(n)); },
    why: () => [...why].sort((a, b) => b[1] - a[1]).map(([k, v]) => k + ' ' + v).join(', '),
    commits: () => commits,
    total: () => [...counts.values()].reduce((a, b) => a + b, 0),
    counts: () => Object.fromEntries(counts),
    top: (n = 10) => [...counts].sort((a, b) => b[1] - a[1]).slice(0, n),
    report(n = 10) { return 'commits ' + commits + ' · components rendered ' + this.total() + ' · ' + this.top(n).map(([k, v]) => k + ' ' + v).join(', '); },
  };
})();`;

module.exports = { HOOK };
