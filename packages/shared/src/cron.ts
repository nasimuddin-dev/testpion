/**
 * Cron schedules (five fields: minute hour day-of-month month day-of-week), in the local time of the computer that runs
 * them: "0 9 * * 1-5" is 09:00 on weekdays. Lists (1,15), ranges (1-5), steps (*\/15, 0-30/10) and names (mon-fri,
 * jan-dec) are read; `@hourly`, `@daily`, `@weekly`, `@monthly` too. Day of month and day of week, both restricted, match
 * when either matches (as cron does). Shared by the scheduler (the next run) and the editors (the words, the next runs).
 */

export interface CronSchedule {
  minutes: Set<number>;
  hours: Set<number>;
  days: Set<number>;
  months: Set<number>;
  weekdays: Set<number>;
  /** Day of month and day of week were both restricted: either matching is enough. */
  either: boolean;
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const MACROS: Record<string, string> = { '@hourly': '0 * * * *', '@daily': '0 0 * * *', '@midnight': '0 0 * * *', '@weekly': '0 0 * * 0', '@monthly': '0 0 1 * *', '@yearly': '0 0 1 1 *', '@annually': '0 0 1 1 *' };
const FIELDS = [
  { name: 'minute', min: 0, max: 59 },
  { name: 'hour', min: 0, max: 23 },
  { name: 'day of month', min: 1, max: 31 },
  { name: 'month', min: 1, max: 12, names: MONTHS, base: 1 },
  { name: 'day of week', min: 0, max: 7, names: DAYS, base: 0 },
] as const;

function field(text: string, f: (typeof FIELDS)[number]): Set<number> {
  const out = new Set<number>();
  const value = (v: string) => {
    const names = 'names' in f ? (f.names as readonly string[]) : undefined;
    const named = names ? names.indexOf(v.toLowerCase().slice(0, 3)) : -1;
    const n = named >= 0 && /^[a-z]+$/i.test(v) ? named + ('base' in f ? f.base : 0) : /^\d+$/.test(v) ? Number(v) : NaN;
    if (!(n >= f.min && n <= f.max)) throw new Error(`"${v}" is out of range for the ${f.name} (${f.min}–${f.max})`);
    return n;
  };
  for (const part of text.split(',')) {
    const [range, stepText] = part.split('/');
    const step = stepText === undefined ? 1 : Number(stepText);
    if (!(Number.isInteger(step) && step >= 1)) throw new Error(`"${part}": the step after / is a whole number from 1`);
    let lo: number;
    let hi: number;
    if (range === '*') [lo, hi] = [f.min, f.name === 'day of week' ? 6 : f.max];
    else if (range!.includes('-')) {
      const [a, b] = range!.split('-');
      [lo, hi] = [value(a!), value(b!)];
      if (lo > hi) throw new Error(`"${range}": the range goes from low to high`);
    } else [lo, hi] = [value(range!), stepText === undefined ? value(range!) : f.max];
    for (let n = lo; n <= hi; n += step) out.add(f.name === 'day of week' && n === 7 ? 0 : n);
  }
  return out;
}

/** The schedule of a cron expression; throws with a sentence naming the wrong part. */
export function parseCron(expression: string): CronSchedule {
  const text = MACROS[expression.trim().toLowerCase()] ?? expression.trim();
  const parts = text.split(/\s+/);
  if (parts.length !== 5) throw new Error('A schedule has 5 parts: minute hour day-of-month month day-of-week, e.g. "0 9 * * 1-5" (09:00 on weekdays)');
  const [minutes, hours, days, months, weekdays] = parts.map((p, i) => field(p, FIELDS[i]!));
  return { minutes: minutes!, hours: hours!, days: days!, months: months!, weekdays: weekdays!, either: !parts[2]!.startsWith('*') && !parts[4]!.startsWith('*') };
}

/** Why an expression is not a schedule (undefined: it is). */
export function cronProblem(expression: string): string | undefined {
  try {
    parseCron(expression);
    return undefined;
  } catch (e) {
    return (e as Error).message;
  }
}

const dayMatches = (s: CronSchedule, d: Date) => {
  const dom = s.days.has(d.getDate());
  const dow = s.weekdays.has(d.getDay());
  return s.either ? dom || dow : dom && dow;
};

/** The first time after `after` (to the minute, local time) the schedule runs; undefined when none in five years (31 February). */
export function nextCronTime(expression: string | CronSchedule, after: Date | number, timeZone?: string): Date | undefined {
  const s = typeof expression === 'string' ? parseCron(expression) : expression;
  const from = typeof after === 'number' ? after : after.getTime();
  if (timeZone) return nextCronTimeIn(s, from, timeZone);
  // the next whole minute (offsets are whole minutes, so a minute on the clock is a minute of absolute time)
  let d = new Date(Math.floor(from / 60_000) * 60_000 + 60_000);
  const limit = d.getTime() + 5 * 366 * 86_400_000;
  while (d.getTime() <= limit) {
    if (!s.months.has(d.getMonth() + 1)) {
      d.setMonth(d.getMonth() + 1, 1);
      d.setHours(0, 0, 0, 0);
      continue;
    }
    if (!dayMatches(s, d)) {
      d.setDate(d.getDate() + 1);
      d.setHours(0, 0, 0, 0);
      continue;
    }
    // hours and minutes step on absolute time: when the clocks go back, the repeated hour is not a step back in time
    if (!s.hours.has(d.getHours())) {
      const next = new Date(d.getTime() + (60 - d.getMinutes()) * 60_000);
      // the clocks went forward (02:00 is 03:00): a time of the hour that never came runs right after the gap, as cron does
      const skipped = next.getDate() === d.getDate() && next.getHours() > d.getHours() + 1;
      if (skipped && next.getTime() > from) for (let h = d.getHours() + 1; h < next.getHours(); h++) if (s.hours.has(h)) return next;
      d = next;
      continue;
    }
    if (!s.minutes.has(d.getMinutes())) {
      d = new Date(d.getTime() + 60_000);
      continue;
    }
    if (d.getTime() > from) return d;
    d = new Date(d.getTime() + 60_000);
  }
  return undefined;
}

/** The next `count` runs after `after` (in `timeZone` when given, else local time). */
export function nextCronTimes(expression: string, after: Date | number, count: number, timeZone?: string): Date[] {
  const s = parseCron(expression);
  const out: Date[] = [];
  let t: Date | undefined = new Date(typeof after === 'number' ? after : after.getTime());
  while (out.length < count && (t = nextCronTime(s, t, timeZone))) out.push(t);
  return out;
}

/* ------------------------------------------------------------------ in a time zone */

/** Why a time zone is not one (an IANA name such as Europe/Berlin or UTC); undefined: it is. */
export function timeZoneProblem(timeZone: string): string | undefined {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone });
    return undefined;
  } catch {
    return `"${timeZone}" is not a time zone: write an IANA name, e.g. Europe/Berlin, America/New_York or UTC`;
  }
}

type Wall = { y: number; mo: number; d: number; h: number; mi: number; wd: number };
const FORMATS = new Map<string, Intl.DateTimeFormat>();
const WEEKDAY: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

/** The clock on the wall in a time zone at an instant. */
function wallIn(timeZone: string, t: number): Wall {
  let f = FORMATS.get(timeZone);
  if (!f) FORMATS.set(timeZone, (f = new Intl.DateTimeFormat('en-US', { timeZone, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', weekday: 'short' })));
  const p: Record<string, string> = {};
  for (const x of f.formatToParts(new Date(t))) p[x.type] = x.value;
  return { y: Number(p.year), mo: Number(p.month), d: Number(p.day), h: Number(p.hour) % 24, mi: Number(p.minute), wd: WEEKDAY[p.weekday!] ?? 0 };
}

/** The instant a wall clock in a time zone shows y-mo-d 00:00 (or the first minute after it, when midnight is skipped). */
function startOfDayIn(timeZone: string, y: number, mo: number, d: number): number {
  const guess = Date.UTC(y, mo - 1, d);
  // the zone's offset at the guess, then at the corrected time (the offset may change in between)
  let t = guess;
  for (let i = 0; i < 3; i++) {
    const w = wallIn(timeZone, t);
    const shown = Date.UTC(w.y, w.mo - 1, w.d, w.h, w.mi);
    const next = t + (guess - shown);
    if (next === t) break;
    t = next;
  }
  return t;
}

/** nextCronTime in a time zone: the same rules on the zone's wall clock (absolute minutes; a time the clocks skip runs right after). */
function nextCronTimeIn(s: CronSchedule, from: number, timeZone: string): Date | undefined {
  let t = Math.floor(from / 60_000) * 60_000 + 60_000;
  const limit = t + 5 * 366 * 86_400_000;
  while (t <= limit) {
    const w = wallIn(timeZone, t);
    if (!s.months.has(w.mo)) {
      t = startOfDayIn(timeZone, w.mo === 12 ? w.y + 1 : w.y, w.mo === 12 ? 1 : w.mo + 1, 1);
      continue;
    }
    const dom = s.days.has(w.d);
    const dow = s.weekdays.has(w.wd);
    if (!(s.either ? dom || dow : dom && dow)) {
      const next = new Date(Date.UTC(w.y, w.mo - 1, w.d + 1));
      t = startOfDayIn(timeZone, next.getUTCFullYear(), next.getUTCMonth() + 1, next.getUTCDate());
      continue;
    }
    if (!s.hours.has(w.h)) {
      const next = t + (60 - w.mi) * 60_000;
      const n = wallIn(timeZone, next);
      // the clocks went forward (02:00 is 03:00): a time of the hour that never came runs right after the gap
      if (n.d === w.d && n.h > w.h + 1 && next > from) for (let h = w.h + 1; h < n.h; h++) if (s.hours.has(h)) return new Date(next);
      t = next;
      continue;
    }
    if (!s.minutes.has(w.mi)) {
      t += 60_000;
      continue;
    }
    if (t > from) return new Date(t);
    t += 60_000;
  }
  return undefined;
}

const pad = (n: number) => String(n).padStart(2, '0');
const list = (xs: string[]) => (xs.length <= 1 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`);
const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** The schedule in words: "at 09:00 on weekdays", "every 15 minutes", "at 03:30 on the 1st of the month". */
export function describeCron(expression: string): string {
  const s = parseCron(expression);
  const sorted = (x: Set<number>) => [...x].sort((a, b) => a - b);
  const all = (x: Set<number>, n: number) => x.size === n;
  const mins = sorted(s.minutes);
  const hours = sorted(s.hours);
  /** The step of an even spread over the whole range from 0 (0, 15, 30, 45 of 60: 15), or 0. */
  const stepOf = (xs: number[], n: number) => {
    const step = xs.length > 1 ? xs[1]! - xs[0]! : 0;
    return step > 0 && xs[0] === 0 && n % step === 0 && xs.length === n / step && xs.every((x, i) => x === i * step) ? step : 0;
  };
  /** Hours in words: a range "09:00–17:59" when contiguous, else a list "08, 12 and 18". */
  const hoursText = (hs: number[]) => (hs.every((h, i) => i === 0 || h === hs[i - 1]! + 1) ? `${pad(hs[0]!)}:00–${pad(hs[hs.length - 1]!)}:59` : list(hs.map((h) => `${pad(h)}h`)));
  const minStep = stepOf(mins, 60);
  const hourStep = stepOf(hours, 24);
  let time: string;
  if (all(s.minutes, 60) && all(s.hours, 24)) time = 'every minute';
  else if (all(s.hours, 24) && minStep) time = `every ${minStep} minutes`;
  else if (all(s.hours, 24)) time = mins.length === 1 && mins[0] === 0 ? 'every hour' : `every hour at ${list(mins.map((m) => `:${pad(m)}`))}`;
  else if (hours.length * mins.length <= 6) time = `at ${list(hours.flatMap((h) => mins.map((m) => `${pad(h)}:${pad(m)}`)))}`;
  else if (hourStep && mins.length === 1) time = `every ${hourStep} hours at :${pad(mins[0]!)}`;
  else if (all(s.minutes, 60)) time = `every minute ${hours.length === 1 ? `from ${pad(hours[0]!)}:00 to ${pad(hours[0]!)}:59` : `in ${hoursText(hours)}`}`;
  else if (minStep) time = `every ${minStep} minutes in ${hoursText(hours)}`;
  else time = `at ${list(mins.map((m) => `:${pad(m)}`))} past each hour in ${hoursText(hours)}`;
  const days: string[] = [];
  const wd = sorted(s.weekdays);
  if (!all(s.weekdays, 7)) days.push(wd.join(',') === '1,2,3,4,5' ? 'on weekdays' : wd.join(',') === '0,6' ? 'on weekends' : `on ${list(wd.map((d) => DAY_NAMES[d]!))}`);
  if (!all(s.days, 31)) days.push(`on the ${list(sorted(s.days).map((d) => `${d}${d % 10 === 1 && d !== 11 ? 'st' : d % 10 === 2 && d !== 12 ? 'nd' : d % 10 === 3 && d !== 13 ? 'rd' : 'th'}`))} of the month`);
  const months = all(s.months, 12) ? '' : ` in ${list(sorted(s.months).map((m) => MONTH_NAMES[m - 1]!))}`;
  return `${time}${days.length ? ` ${days.join(s.either ? ' or ' : ' and ')}` : ''}${months}`;
}
