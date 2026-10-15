/**
 * `testpion://open?…` links that arrived before the window could take them (the link started the app). The desktop
 * shell queues them here (electron/main.ts) and the window takes them once it is ready (`app.takeOpenLinks`); links
 * that arrive while it runs go to the window at once as an `app.openLink` event. Other hosts (the web bridge, a server)
 * have no links: the queue stays empty.
 */
const pending: string[] = [];
const LIMIT = 20;

/** Keep a link for the window (the newest 20; a link is text, at most 4 KB). */
export function queueOpenLink(url: string): void {
  if (typeof url !== 'string' || url.length > 4096 || !/^testpion:\/\//i.test(url)) return;
  pending.push(url);
  if (pending.length > LIMIT) pending.shift();
}

/** The links queued so far, oldest first; the queue is empty afterwards. */
export function takeOpenLinks(): string[] {
  return pending.splice(0);
}

/** The `testpion://` links in a command line (a link that started the app, or a second launch's). */
export const openLinksIn = (argv: readonly string[]): string[] => argv.filter((a) => /^testpion:\/\//i.test(a));
