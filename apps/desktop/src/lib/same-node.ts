import { isValidElement } from 'react';

/**
 * Whether two values would draw the same thing: equal primitives, React elements of the same type and key whose props are
 * equal in the same sense, arrays and plain objects of equal members. Functions are equal only if they are the same function. It
 * errs one way only: "not the same" when unsure, so a memoized component that compares its JSX props with it re-renders at
 * worst, and never keeps a stale picture. Bounded in depth, so a big prop is not walked.
 */
export function sameNode(a: unknown, b: unknown, depth = 6): boolean {
  if (Object.is(a, b)) return true;
  if (depth <= 0 || typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  if (isValidElement(a) || isValidElement(b)) {
    if (!isValidElement(a) || !isValidElement(b)) return false;
    return a.type === b.type && a.key === b.key && sameNode(a.props, b.props, depth - 1);
  }
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((x, i) => sameNode(x, b[i], depth - 1));
  }
  const proto = Object.getPrototypeOf(a);
  if (proto !== Object.prototype && proto !== null) return false;
  if (Object.getPrototypeOf(b) !== proto) return false;
  const ka = Object.keys(a as object);
  const kb = Object.keys(b as object);
  if (ka.length !== kb.length) return false;
  return ka.every((k) => Object.hasOwn(b as object, k) && sameNode((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k], depth - 1));
}

/** For a memoized component's props: every key equal in the sense of `sameNode`. */
export function sameProps<P extends object>(a: P, b: P): boolean {
  return sameNode(a, b);
}
