/**
 * Scheduler math. These are the properties that decide whether a recurring job
 * fires once, never, or repeatedly — so they are tested directly rather than
 * discovered in production.
 */
import { describe, it, expect } from 'vitest';
import { nextRunAt, parseRule, UnsupportedRule, zoneOffsetMinutes, describeRule } from './schedule.js';

const TL = 'Asia/Calcutta'; // UTC+05:30, no DST — a clean reference zone

describe('parseRule', () => {
  it('parses the supported forms', () => {
    expect(parseRule('FREQ=DAILY')).toMatchObject({ freq: 'DAILY', interval: 1 });
    expect(parseRule('FREQ=DAILY;BYHOUR=9;BYMINUTE=30')).toMatchObject({ byHour: [9], byMinute: [30] });
    expect(parseRule('FREQ=WEEKLY;BYDAY=MO,TH')).toMatchObject({ byDay: [1, 4] });
    expect(parseRule('FREQ=HOURLY;INTERVAL=6')).toMatchObject({ freq: 'HOURLY', interval: 6 });
  });

  it('refuses what it does not understand instead of guessing', () => {
    expect(() => parseRule('FREQ=SECONDLY')).toThrow(UnsupportedRule);
    expect(() => parseRule('BYHOUR=9')).toThrow(UnsupportedRule);
    expect(() => parseRule('FREQ=DAILY;BYDAY=MO')).toThrow(UnsupportedRule);
    expect(() => parseRule('FREQ=DAILY;BYHOUR=99')).toThrow(UnsupportedRule);
    expect(() => parseRule('FREQ=DAILY;INTERVAL=0')).toThrow(UnsupportedRule);
    expect(() => parseRule('nonsense')).toThrow(UnsupportedRule);
  });
});

describe('timezone handling', () => {
  it('knows Asia/Calcutta is +05:30', () => {
    expect(zoneOffsetMinutes(new Date('2026-11-16T00:00:00Z'), TL)).toBe(330);
  });

  it('schedules 09:00 local as 03:30 UTC', () => {
    const next = nextRunAt('FREQ=DAILY;BYHOUR=9;BYMINUTE=0', TL, new Date('2026-11-16T00:00:00Z'));
    expect(next.toISOString()).toBe('2026-11-16T03:30:00.000Z');
  });
});

describe('nextRunAt', () => {
  it('returns the NEXT occurrence, never the current instant', () => {
    const at = new Date('2026-11-16T03:30:00Z'); // exactly 09:00 local
    const next = nextRunAt('FREQ=DAILY;BYHOUR=9;BYMINUTE=0', TL, at);
    expect(next.getTime()).toBeGreaterThan(at.getTime());
    expect(next.toISOString()).toBe('2026-11-17T03:30:00.000Z');
  });

  it('respects INTERVAL in days', () => {
    const next = nextRunAt('FREQ=DAILY;INTERVAL=3;BYHOUR=9;BYMINUTE=0', TL, new Date('2026-11-16T04:00:00Z'));
    expect(next.toISOString()).toBe('2026-11-19T03:30:00.000Z');
  });

  it('finds the next matching weekday for WEEKLY', () => {
    // 2026-11-16 is a Monday; next Thursday 09:00 local.
    const next = nextRunAt('FREQ=WEEKLY;BYDAY=TH;BYHOUR=9;BYMINUTE=0', TL, new Date('2026-11-16T04:00:00Z'));
    expect(next.toISOString()).toBe('2026-11-19T03:30:00.000Z');
    expect(new Date(next.getTime() + 330 * 60_000).getUTCDay()).toBe(4); // Thursday
  });

  it('advances by whole hours for HOURLY', () => {
    const from = new Date('2026-11-16T00:10:00Z');
    const next = nextRunAt('FREQ=HOURLY', TL, from);
    expect(next.getTime()).toBeGreaterThan(from.getTime());
    expect(next.getTime() - from.getTime()).toBeLessThanOrEqual(60 * 60_000);
  });

  it('is deterministic: same inputs, same output', () => {
    const from = new Date('2026-11-16T00:00:00Z');
    expect(nextRunAt('FREQ=DAILY;BYHOUR=7;BYMINUTE=15', TL, from).toISOString()).toBe(
      nextRunAt('FREQ=DAILY;BYHOUR=7;BYMINUTE=15', TL, from).toISOString(),
    );
  });
});

describe('describeRule', () => {
  it('renders something a human can read, and degrades to the raw rule', () => {
    expect(describeRule('FREQ=DAILY;BYHOUR=9;BYMINUTE=0')).toContain('daily');
    expect(describeRule('FREQ=WEEKLY;BYDAY=MO;BYHOUR=9')).toContain('Mon');
    expect(describeRule('FREQ=SECONDLY')).toBe('FREQ=SECONDLY');
  });
});