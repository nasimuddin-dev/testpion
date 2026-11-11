import { afterAll, describe, expect, it } from 'vitest';
import { nextCronTime } from '../../packages/shared/src/cron.js';

// A cron schedule in the computer's own time (no zone named): a time the clocks skip runs when they jump, wherever the
// gap is (inside the schedule's hours, a 30-minute gap, a skipped midnight). Each case sets the process's zone (TZ).
const before = process.env.TZ;
afterAll(() => {
  if (before === undefined) delete process.env.TZ;
  else process.env.TZ = before;
});
const at = (tz: string, cron: string, after: string) => {
  process.env.TZ = tz;
  return nextCronTime(cron, Date.parse(after))?.toISOString().slice(0, 16);
};

describe('local cron across the clocks going forward', () => {
  it('a gap inside the schedule hours, a 30-minute gap, a skipped midnight', () => {
    expect(at('America/New_York', '30 1,2 * * *', '2026-03-08T06:30:00Z')).toBe('2026-03-08T07:00');
    expect(at('Australia/Lord_Howe', '0 2 * * *', '2026-10-03T00:00:00Z')).toBe('2026-10-03T15:30');
    expect(at('America/Santiago', '30 0 * * *', '2026-09-05T12:00:00Z')).toBe('2026-09-06T04:00');
    // an ordinary day is unchanged
    expect(at('America/New_York', '0 9 * * 1-5', '2026-11-06T12:00:00Z')).toBe('2026-11-06T14:00');
  });
});

describe('local cron across the clocks going back', () => {
  it('a schedule at set hours runs once (the first time); one for every hour keeps its pace', () => {
    // New York 2026-11-01: 01:30 comes twice (05:30Z and 06:30Z)
    expect(at('America/New_York', '30 1 * * *', '2026-11-01T00:00:00Z')).toBe('2026-11-01T05:30');
    expect(at('America/New_York', '30 1 * * *', '2026-11-01T05:30:00Z')).toBe('2026-11-02T06:30');
    expect(at('America/New_York', '*/15 * * * *', '2026-11-01T05:45:00Z')).toBe('2026-11-01T06:00');
    expect(at('America/New_York', '*/15 * * * *', '2026-11-01T06:45:00Z')).toBe('2026-11-01T07:00');
  });
});
