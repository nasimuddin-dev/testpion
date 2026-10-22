/**
 * Everything TestPion itself sends over the network besides the requests you make: what the Privacy tab of Settings shows
 * (and docs/security/privacy.md says). `files` are the program files that make the calls: a test fails when another file
 * of the desktop app starts one that is not listed here.
 */
export interface NetworkDisclosure {
  id: string;
  title: string;
  /** Where it goes. */
  to: string;
  /** What it carries. */
  carries: string;
  /** When it happens, and the default. */
  when: string;
  /** The setting that turns it off, in plain words. */
  off: string;
  files: string[];
}

export const NETWORK_DISCLOSURES: NetworkDisclosure[] = [
  {
    id: 'updates',
    title: 'Check for updates',
    to: 'api.github.com and github.com (the TestPion releases)',
    carries: 'The question "what is the newest release?" and the TestPion version in the user agent. No workspace data, no account.',
    when: 'A few seconds after the app starts and every 6 hours while it runs. On by default.',
    off: 'Settings ▸ About ▸ Check for updates when the app starts',
    files: ['electron/updater.ts'],
  },
  {
    id: 'ai',
    title: 'AI actions',
    to: 'The AI provider you set up (or a model on this computer)',
    carries: 'The context of the action you started, with secrets and personal data masked: see "What will be sent" before every call.',
    when: 'Only when you use an AI action. Nothing is sent otherwise.',
    off: 'Settings ▸ AI assistant ▸ Hide all AI actions, or Local only',
    files: [],
  },
  {
    id: 'feedback',
    title: 'Send feedback',
    to: 'Nowhere by itself: it builds a report and a link to a pre-filled GitHub issue that you open',
    carries: 'What you typed, and the diagnostics you ticked.',
    when: 'Only when you open the link.',
    off: 'Do not use Send feedback',
    files: [],
  },
];
