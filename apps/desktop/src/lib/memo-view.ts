import { createElement, lazy, memo, useState, type ComponentType } from 'react';

/** A view of the shell: loaded on first use or by `prefetch()`. */
export type LazyView = ComponentType & { prefetch(): Promise<unknown> };

/**
 * A view, loaded on first use or by `prefetch()`; once loaded it renders at once (a Suspense fallback is held 300 ms).
 * Memoised (it takes no props): the shell renders for a dialog, the palette or the bottom panel without rendering the
 * views it keeps mounted; a view renders again only for its own state, its stores and its contexts.
 */
export function lazyMemoView(load: () => Promise<Record<string, unknown>>, name: string): LazyView {
  let loaded: ComponentType | undefined;
  const prefetch = async () => (loaded ??= (await load())[name] as ComponentType);
  const Lazy = lazy(async () => ({ default: await prefetch() }));
  const V = memo(() => createElement(useState(() => loaded ?? Lazy)[0]));
  V.displayName = name;
  return Object.assign(V as unknown as ComponentType, { prefetch });
}
