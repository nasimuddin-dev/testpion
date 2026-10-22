import { Redactor } from '../util/redact.js';

/**
 * Feedback and problem reports: one Markdown report built from what the user wrote, plus (only when they agree)
 * the app's versions and its recent errors, with home folders and secrets masked. Nothing is sent: the report
 * opens as a pre-filled GitHub issue that the user reviews and posts, or is copied / saved.
 */
export type FeedbackKind = 'bug' | 'idea' | 'ui' | 'question';

export const FEEDBACK_REPO = 'nasimuddin-dev/testpion';
/** Where emailed feedback goes (the maintainer). */
export const FEEDBACK_EMAIL = 'nasim.uddinbd02@gmail.com';

export const FEEDBACK_KINDS: Record<FeedbackKind, { label: string; prefix: string; labels: string[] }> = {
  bug: { label: 'Something is broken', prefix: 'Bug', labels: ['bug'] },
  idea: { label: 'An idea or a missing feature', prefix: 'Idea', labels: ['enhancement'] },
  ui: { label: 'Design and usability', prefix: 'UI', labels: ['enhancement'] },
  question: { label: 'A question', prefix: 'Question', labels: ['question'] },
};

export interface FeedbackInput {
  kind: FeedbackKind;
  title: string;
  description: string;
  /** Problems: what was done, and what was expected instead. */
  steps?: string;
  expected?: string;
  /** Where in the app (view or screen). */
  where?: string;
  /** Versions and platform, one fact per line (only when the user includes them). */
  diagnostics?: string[];
  /** Recent errors of the app (only when the user includes them). */
  errors?: string[];
}

export interface FeedbackReport {
  title: string;
  body: string;
  labels: string[];
  /** A new GitHub issue with the report filled in (shortened when it is too long for a link). */
  url: string;
  /** The body in the link was shortened: paste the full report (copied) into the issue. */
  shortened: boolean;
  /** An email to the maintainer with the report (mail apps take short links only: then the body is shortened too). */
  mailto: string;
  mailShortened: boolean;
}

/** Mail apps cut long mailto: links; keep the body under this. */
const MAX_MAIL_BODY = 1800;

/** Links longer than this are refused by some browsers and by GitHub. */
const MAX_URL = 7500;

/** Mask home folders (C:\Users\me, /home/me, /Users/me) and secret-looking values (bearer tokens, JWTs, key=value secrets). */
export function maskReportText(s: string, redactor = new Redactor()): string {
  return redactor.redactString(
    s
      .replace(/[A-Za-z]:\\Users\\[^\\\s"']+/g, '~')
      .replace(/\/(?:home|Users)\/[^/\s"']+/g, '~')
      .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, '$1 ***')
      .replace(/\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]*/g, '***')
      .replace(/\b((?:api[_-]?key|access[_-]?token|refresh[_-]?token|token|secret|password|passwd|pwd|client[_-]?secret)\\?["']?\s*[:=]\s*\\?["']?)[^\s"'&,;\\]+/gi, '$1***')
      .replace(/(\b[a-z][a-z0-9+.-]*:\/\/)[^\s/@:'"]+:[^\s/@'"]+@/gi, '$1***@') // user:password@ in a URL
      .replace(/\b(?:sk|pk|ghp|gho|xox[abp])[-_][A-Za-z0-9_-]{12,}/g, '***'),
  );
}

export function composeFeedback(i: FeedbackInput, opts: { repo?: string } = {}): FeedbackReport {
  const kind = FEEDBACK_KINDS[i.kind] ?? FEEDBACK_KINDS.idea;
  const mask = (s: string) => maskReportText(s);
  const title = `[${kind.prefix}] ${i.title.trim() || kind.label}`.slice(0, 200);
  const parts: string[] = [];
  parts.push(mask(i.description.trim() || '(no description)'));
  if (i.where?.trim()) parts.push(`**Where:** ${mask(i.where.trim())}`);
  if (i.kind === 'bug') {
    if (i.steps?.trim()) parts.push(`### Steps\n\n${mask(i.steps.trim())}`);
    if (i.expected?.trim()) parts.push(`### Expected\n\n${mask(i.expected.trim())}`);
  }
  if (i.diagnostics?.length) parts.push(`### Environment\n\n${i.diagnostics.map((d) => `- ${mask(d)}`).join('\n')}`);
  if (i.errors?.length) parts.push(`### Recent errors\n\n\`\`\`\n${i.errors.map(mask).join('\n').slice(0, 4000)}\n\`\`\``);
  parts.push('_Sent from TestPion (Help ▸ Send feedback)._');
  const body = parts.join('\n\n');
  const repo = opts.repo ?? FEEDBACK_REPO;
  const link = (b: string) => `https://github.com/${repo}/issues/new?${new URLSearchParams({ title, body: b, labels: kind.labels.join(',') }).toString()}`;
  let url = link(body);
  let shortened = false;
  if (url.length > MAX_URL) {
    shortened = true;
    const note = '\n\n_(The report was too long for a link: paste the full report from your clipboard here.)_';
    let b = body;
    while (b.length > 200 && link(b + note).length > MAX_URL) b = b.slice(0, Math.floor(b.length * 0.8));
    url = link(b + note);
  }
  const mailBody = body.length > MAX_MAIL_BODY ? `${body.slice(0, MAX_MAIL_BODY)}

(The report was longer: paste the full report from your clipboard here.)` : body;
  const mailto = `mailto:${FEEDBACK_EMAIL}?subject=${encodeURIComponent(`TestPion: ${title}`)}&body=${encodeURIComponent(mailBody)}`;
  return { title, body, labels: kind.labels, url, shortened, mailto, mailShortened: body.length > MAX_MAIL_BODY };
}
