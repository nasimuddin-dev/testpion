/**
 * A monitor's maintenance window: a time that comes back (a cron schedule, in the local time of the computer that runs
 * it) and how long it lasts, e.g. every Sunday at 02:00 for two hours, when a deploy or a backup makes the API fail on
 * purpose. No scheduled run starts inside it, so no alert pages anyone; Run now still works.
 */
import { cronProblem, describeCron, nextCronTime } from '@testpion/shared';

export interface QuietWindow {
  /** When it starts: a cron expression ("0 2 * * 0": Sundays at 02:00). */
  cron: string;
  /** How long it lasts, in minutes (1 to 1440). */
  minutes: number;
  /** Why, shown while it lasts ("deploy"). */
  reason?: string;
}

/** Why a window is not one (undefined: it is). */
export function quietProblem(q: QuietWindow): string | undefined {
  if (!q || typeof q !== 'object') return 'A maintenance window is { cron, minutes }';
  const problem = typeof q.cron === 'string' ? cronProblem(q.cron) : 'it needs a cron schedule';
  if (problem) return `The maintenance window "${String(q.cron)}": ${problem}`;
  if (!(Number.isInteger(q.minutes) && q.minutes >= 1 && q.minutes <= 1440)) return 'A maintenance window lasts 1 minute to 24 hours (minutes: 1 to 1440)';
  return undefined;
}

/** The end of the window `now` is in (ms), or undefined when it is in none. */
export function quietUntil(q: QuietWindow | undefined, now = Date.now()): number | undefined {
  if (!q || quietProblem(q)) return undefined;
  const span = q.minutes * 60_000;
  // the starts of the window in the last `minutes` (and the minute before): the latest one that has begun
  let start: number | undefined;
  for (let t = nextCronTime(q.cron, now - span - 60_000); t && t.getTime() <= now; t = nextCronTime(q.cron, t)) start = t.getTime();
  return start !== undefined && now < start + span ? start + span : undefined;
}

/** The window in words: "quiet at 02:00 on Sunday for 2 hours (deploy)". */
export function quietText(q: QuietWindow): string {
  const h = q.minutes % 60 === 0 ? `${q.minutes / 60} hour${q.minutes === 60 ? '' : 's'}` : `${q.minutes} minutes`;
  let when: string;
  try {
    when = describeCron(q.cron);
  } catch {
    when = `"${q.cron}"`;
  }
  return `quiet ${when} for ${h}${q.reason ? ` (${q.reason})` : ''}`;
}
