import { describe, expect, it } from 'vitest';
import { nextCronTime, nextCronTimes, timeZoneProblem } from '../../packages/shared/src/cron.js';

// A cron schedule in a time zone (a monitor of a team in Berlin, run by a server in UTC): the times are the zone's wall
// clock, whatever the computer's own zone; the clocks going forward skip nothing (a time in the gap runs right after).
const iso = (d: Date | undefined) => d?.toISOString().slice(0, 16);

describe('cron in a time zone', () => {
  it('09:00 on weekdays in Berlin, New York and UTC', () => {
    // Friday 2026-11-06 00:00 UTC: 09:00 in Berlin (CET, UTC+1) is 08:00 UTC
    expect(iso(nextCronTime('0 9 * * 1-5', Date.parse('2026-11-06T00:00:00Z'), 'Europe/Berlin'))).toBe('2026-11-06T08:00');
    // after it, the next weekday is Monday 09:00
    expect(iso(nextCronTime('0 9 * * 1-5', Date.parse('2026-11-06T08:00:00Z'), 'Europe/Berlin'))).toBe('2026-11-09T08:00');
    // New York (EST, UTC-5 after 2026-11-01)
    expect(iso(nextCronTime('0 9 * * *', Date.parse('2026-11-06T12:00:00Z'), 'America/New_York'))).toBe('2026-11-06T14:00');
    expect(iso(nextCronTime('0 9 * * *', Date.parse('2026-11-06T14:00:00Z'), 'America/New_York'))).toBe('2026-11-07T14:00');
    expect(iso(nextCronTime('15 3 1 * *', Date.parse('2026-11-06T00:00:00Z'), 'UTC'))).toBe('2026-12-01T03:15');
  });

  it('the spring gap: 02:30 in Berlin on 2027-03-28 never comes, it runs right after the clocks go forward', () => {
    expect(iso(nextCronTime('30 2 * * *', Date.parse('2027-03-27T23:00:00Z'), 'Europe/Berlin'))).toBe('2027-03-28T01:00');
    // the day after, at 02:30 CEST (UTC+2)
    expect(iso(nextCronTime('30 2 * * *', Date.parse('2027-03-28T01:00:00Z'), 'Europe/Berlin'))).toBe('2027-03-29T00:30');
  });

  it('says what is not a zone, and is quick', () => {
    expect(timeZoneProblem('Mars/Base')).toMatch(/not a time zone/);
    expect(timeZoneProblem('Asia/Kolkata')).toBeUndefined();
    const t0 = performance.now();
    expect(nextCronTimes('*/5 * * * *', Date.parse('2026-11-06T00:00:00Z'), 50, 'Asia/Kolkata')).toHaveLength(50);
    expect(iso(nextCronTime('0 0 29 2 *', Date.parse('2026-11-06T00:00:00Z'), 'Europe/Berlin'))).toBe('2028-02-28T23:00'); // 29 February 00:00 in Berlin
    expect(performance.now() - t0).toBeLessThan(1500);
  });

  it('a monitor with a time zone runs at the zone times, says so, and a wrong zone is refused', async () => {
    const { nextRunAt, monitorScheduleText, parseSchedule, saveMonitor, WorkspaceStore } = await import('../../packages/core/src/index.js');
    const { tempDir } = await import('../helpers.js');
    const { join } = await import('node:path');
    const m = { id: 'm', name: 'Morning', collectionId: 'c', ...parseSchedule('0 9 * * 1-5'), timezone: 'Asia/Tokyo', enabled: true } as never;
    // Friday 2026-11-06 00:00 UTC is 09:00 in Tokyo: due then (a never-run monitor looks back 10 minutes)
    expect(new Date(nextRunAt(m, undefined, Date.parse('2026-11-06T00:05:00Z'))).toISOString().slice(0, 16)).toBe('2026-11-06T00:00');
    expect(monitorScheduleText(m)).toBe('at 09:00 on weekdays (Asia/Tokyo)');
    const tmp = tempDir('tp-cron-tz-');
    try {
      const s = WorkspaceStore.create(join(tmp.dir, 'ws'), 'Zones');
      s.writeTestFile('smoke.yaml', 'tests:\n  - { id: a, name: A, url: "http://127.0.0.1:9/a" }\n');
      expect(() => saveMonitor(s, { name: 'Bad', testFile: 'smoke.yaml', ...parseSchedule('0 9 * * *'), timezone: 'Mars/Base', enabled: true } as never)).toThrow(/not a time zone/);
      s.close();
    } finally {
      tmp.cleanup();
    }
  });
});
