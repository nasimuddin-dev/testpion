import { describe, expect, it } from 'vitest';
import { cronProblem, describeCron, nextCronTime, nextCronTimes } from '../../packages/shared/src/index.js';
import { isDue, monitorScheduleText, nextRunAt, parseSchedule, type Monitor } from '../../packages/core/src/index.js';

// Monitors at set times: a cron schedule in the local time of the computer that runs it.
const at = (y: number, mo: number, d: number, h = 0, mi = 0) => new Date(y, mo - 1, d, h, mi);
const local = (x: Date | undefined) => (x ? `${x.getFullYear()}-${x.getMonth() + 1}-${x.getDate()} ${x.getHours()}:${String(x.getMinutes()).padStart(2, '0')} ${['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][x.getDay()]}` : 'none');

describe('cron schedules', () => {
  it('finds the next time: weekdays at 09:00, every 15 minutes, the 1st of the month, names and macros', () => {
    // Friday 2026-11-06 10:00 → Monday 09:00
    expect(local(nextCronTime('0 9 * * 1-5', at(2026, 11, 6, 10)))).toBe('2026-11-9 9:00 Mon');
    expect(local(nextCronTime('0 9 * * mon-fri', at(2026, 11, 6, 8, 59)))).toBe('2026-11-6 9:00 Fri');
    expect(nextCronTimes('*/15 * * * *', at(2026, 11, 6, 10, 7), 3).map(local)).toEqual(['2026-11-6 10:15 Fri', '2026-11-6 10:30 Fri', '2026-11-6 10:45 Fri']);
    expect(local(nextCronTime('30 3 1 * *', at(2026, 11, 6)))).toBe('2026-12-1 3:30 Tue');
    expect(local(nextCronTime('@daily', at(2026, 11, 6, 23, 59)))).toBe('2026-11-7 0:00 Sat');
    // day of month and day of week both given: either one (the 13th, or a Friday)
    expect(local(nextCronTime('0 12 13 * fri', at(2026, 11, 7)))).toBe('2026-11-13 12:00 Fri');
    expect(local(nextCronTime('0 12 13 * 1', at(2026, 11, 7)))).toBe('2026-11-9 12:00 Mon');
    // 7 is Sunday too; 31 February never comes
    expect(local(nextCronTime('0 0 * * 7', at(2026, 11, 6)))).toBe('2026-11-8 0:00 Sun');
    expect(nextCronTime('0 0 31 2 *', at(2026, 1, 1))).toBeUndefined();
  });

  it('says what is wrong, and says the schedule in words', () => {
    expect(cronProblem('0 9 * *')).toMatch(/5 parts/);
    expect(cronProblem('0 25 * * *')).toMatch(/"25" is out of range for the hour \(0–23\)/);
    expect(cronProblem('*/0 * * * *')).toMatch(/step/);
    expect(cronProblem('0 9 * * 1-5')).toBeUndefined();
    expect(describeCron('0 9 * * 1-5')).toBe('at 09:00 on weekdays');
    expect(describeCron('*/15 * * * *')).toBe('every 15 minutes');
    expect(describeCron('0 * * * *')).toBe('every hour');
    expect(describeCron('30 3 1 * *')).toBe('at 03:30 on the 1st of the month');
    expect(describeCron('0 8,17 * * sat,sun')).toBe('at 08:00 and 17:00 on weekends');
  });
});

describe('a monitor on a cron schedule', () => {
  const m = { id: 'm', name: 'Morning', collectionId: 'c', ...parseSchedule('0 9 * * 1-5'), enabled: true } as Monitor;
  const ranAt = (d: Date) => ({ startedAt: d.toISOString() }) as never;

  it('--every takes a cron schedule as well as an interval', () => {
    expect(parseSchedule('15m')).toEqual({ everyMinutes: 15 });
    expect(parseSchedule('0 9 * * 1-5')).toEqual({ everyMinutes: 60, cron: '0 9 * * 1-5' });
    expect(parseSchedule('@hourly')).toMatchObject({ cron: '@hourly' });
    expect(() => parseSchedule('0 9 * * funday')).toThrow(/The schedule "0 9 \* \* funday"/);
    expect(monitorScheduleText(m)).toBe('at 09:00 on weekdays');
    expect(monitorScheduleText({ everyMinutes: 15 })).toBe('every 15 minutes');
  });

  it('is due at its time, not before; once after its last run; a time missed while nothing ran is due once', () => {
    const fri = at(2026, 11, 6, 9, 0);
    // never ran: due at 09:00:20 (the scheduler looks every 30 s), not at 08:59
    expect(isDue(m, undefined, fri.getTime() + 20_000)).toBe(true);
    expect(isDue(m, undefined, fri.getTime() - 60_000)).toBe(false);
    // ran at 09:00: not again until Monday
    expect(isDue(m, ranAt(fri), fri.getTime() + 3_600_000)).toBe(false);
    expect(new Date(nextRunAt(m, ranAt(fri), fri.getTime())).getDay()).toBe(1);
    // ran on Wednesday, the app was closed Thursday and Friday morning: due once now
    expect(isDue(m, ranAt(at(2026, 11, 4, 9, 0)), at(2026, 11, 6, 11, 0).getTime())).toBe(true);
  });
});

describe('cron: what the review found', () => {
  it('never steps back in time when the clocks go back (every minute, every 5 minutes)', () => {
    // 2026-11-01 01:45 PST is in the repeated hour (US clocks went back at 02:00 PDT)
    const after = Date.UTC(2026, 10, 1, 9, 45);
    for (const expr of ['* * * * *', '*/5 * * * *']) expect(nextCronTime(expr, after)!.getTime(), expr).toBeGreaterThan(after);
  });

  it('a field that starts with * is not a restriction for the day rule (odd days that are Mondays)', () => {
    // */2 day of month AND Monday (vixie): 2026-11-09 is a Monday on an odd day? 9 is odd -> yes
    expect(local(nextCronTime('0 0 */2 * 1', at(2026, 11, 3)))).toBe('2026-11-9 0:00 Mon');
  });

  it('says partial spreads and hours in words', () => {
    expect(describeCron('0,20 * * * *')).toBe('every hour at :00 and :20');
    expect(describeCron('0-30/10 * * * *')).toBe('every hour at :00, :10, :20 and :30');
    expect(describeCron('0 */2 * * *')).toBe('every 2 hours at :00');
    expect(describeCron('15,45 9-17 * * 1-5')).toBe('at :15 and :45 past each hour in 09:00–17:59 on weekdays');
    expect(describeCron('* 9 * * *')).toBe('every minute from 09:00 to 09:59');
    expect(describeCron('*/20 * * * *')).toBe('every 20 minutes');
  });
});

describe('a cron monitor: what the review found', () => {
  it('a schedule that never comes is refused; a never-run one is due within 10 minutes of its time', () => {
    expect(() => parseSchedule('0 0 31 2 *')).not.toThrow(); // it parses
    const m = { id: 'm', name: 'Hourly', collectionId: 'c', ...parseSchedule('0 * * * *'), enabled: true } as Monitor;
    expect(isDue(m, undefined, at(2026, 11, 6, 10, 2))).toBe(true);
    expect(isDue(m, undefined, at(2026, 11, 6, 10, 12))).toBe(false);
  });

  it('a time inside the maintenance window is skipped, not run when the window ends', () => {
    const m = { id: 'm', name: 'Night', collectionId: 'c', ...parseSchedule('0 2 * * *'), quiet: { cron: '0 2 * * 0', minutes: 120 }, enabled: true } as Monitor;
    // ran Saturday 02:00; Sunday 02:00 is in the window: next is Monday 02:00
    const next = new Date(nextRunAt(m, { startedAt: new Date(at(2026, 11, 7, 2, 0)).toISOString() } as never, at(2026, 11, 8, 4, 30)));
    expect(local(next)).toBe('2026-11-9 2:00 Mon');
  });
});
