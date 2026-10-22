import { useApp } from '../store';

/**
 * The clipboard, the one way in the window (E1): every copy goes through here, so every copy says so the same way, with
 * one toast ("Copied the URL"), and a clipboard that refuses is reported the same way too. No button turns into a tick
 * of its own, no message is drawn into the page.
 */

/** Put text on the clipboard; rejects when the clipboard refuses. For a caller that says what it copied in its own toast. */
export function writeClipboard(text: string): Promise<void> {
  return navigator.clipboard.writeText(text);
}

/** Copy text to the clipboard and say so: "Copied the URL" (or "Copied"); a clipboard that refuses is reported. */
export function copyText(text: string, what?: string): Promise<void> {
  return writeClipboard(text).then(
    () => useApp.getState().toast(what ? `Copied ${what}` : 'Copied', 'success'),
    () => useApp.getState().toast('Could not copy to the clipboard', 'error'),
  );
}

/**
 * Copy text for a message that says more ("Recording at <url> (copied)"), or with no message at all (a terminal's
 * selection, copied as it is made): true when the clipboard took it; false, and "Could not copy to the clipboard"
 * shown, when it refused. The caller then leaves "(copied)" out.
 */
export function copyQuietly(text: string): Promise<boolean> {
  return writeClipboard(text).then(
    () => true,
    () => (useApp.getState().toast('Could not copy to the clipboard', 'error'), false),
  );
}
