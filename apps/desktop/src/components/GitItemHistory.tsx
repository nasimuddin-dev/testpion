import { lazy, Suspense, type ComponentProps } from 'react';
export type { HistoryTarget } from './GitItemHistoryBody';

// An item's git history: loads when first opened, not at startup
const GitItemHistoryBody = lazy(async () => ({ default: (await import('./GitItemHistoryBody')).GitItemHistoryBody }));

export function GitItemHistory(props: ComponentProps<typeof GitItemHistoryBody>) {
  return (
    <Suspense fallback={null}>
      <GitItemHistoryBody {...props} />
    </Suspense>
  );
}
