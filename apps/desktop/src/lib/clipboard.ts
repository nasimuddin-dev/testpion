import { useCallback, useEffect, useRef, useState } from 'react';
import { useApp } from '../store';

/** Copy text to the clipboard and say so: "Copied the URL" (or "Copied"); a clipboard that refuses is reported. */
export function copyText(text: string, what?: string): Promise<void> {
  return navigator.clipboard.writeText(text).then(
    () => useApp.getState().toast(what ? `Copied ${what}` : 'Copied', 'success'),
    () => useApp.getState().toast('Could not copy to the clipboard', 'error'),
  );
}

/**
 * A copy button that turns into a tick for a moment: `copied` is true for `ms` after `copy(text)` succeeded (a
 * clipboard that refuses is reported instead). For buttons whose own label says it; elsewhere copyText toasts.
 */
export function useCopied(ms = 1500): { copied: boolean; copy(text: string): Promise<void> } {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  const copy = useCallback(
    (text: string) =>
      navigator.clipboard.writeText(text).then(
        () => {
          setCopied(true);
          clearTimeout(timer.current);
          timer.current = setTimeout(() => setCopied(false), ms);
        },
        () => useApp.getState().toast('Could not copy to the clipboard', 'error'),
      ),
    [ms],
  );
  return { copied, copy };
}
