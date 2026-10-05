/**
 * time.ts — America/New_York quiet hours (incl. the midnight wrap-around), relative ages, day maths and the demo clock.
 */
import { DAY_MS, clockOffset, daysBetween, formatDate, formatDateTime, formatTime, inQuietHours, localMinutes, nowMs, relativeAgo, setClockOffset, toEpoch } from '@/domain/time';

/** Winter (EST = UTC−5) and summer (EDT = UTC−4) instants, written as the New York wall-clock time they represent. */
const est = (h: number, m = 0) => Date.parse(`2026-01-16T${String((h + 5) % 24).padStart(2, '0')}:${String(m).padStart(2, '0')}:00Z`);
const edt = (h: number, m = 0) => Date.parse(`2026-07-15T${String((h + 4) % 24).padStart(2, '0')}:${String(m).padStart(2, '0')}:00Z`);

describe('localMinutes', () => {
  test('minutes since local midnight in New York, both sides of DST', () => {
    expect(localMinutes(est(23))).toBe(23 * 60);
    expect(localMinutes(est(0, 5))).toBe(5);
    expect(localMinutes(edt(3, 30))).toBe(3 * 60 + 30);
  });
});

describe('inQuietHours', () => {
  const night = { start: '22:00', end: '07:00' };

  test('a window that wraps midnight covers late evening and early morning', () => {
    expect(inQuietHours(est(23), night)).toBe(true);
    expect(inQuietHours(est(3, 30), night)).toBe(true);
    expect(inQuietHours(est(22), night)).toBe(true); // start inclusive
    expect(inQuietHours(est(21, 59), night)).toBe(false);
    expect(inQuietHours(est(6, 59), night)).toBe(true);
    expect(inQuietHours(est(7), night)).toBe(false); // end exclusive
    expect(inQuietHours(est(12), night)).toBe(false);
  });

  test('the same wall-clock rule holds in daylight time', () => {
    expect(inQuietHours(edt(3), night)).toBe(true);
    expect(inQuietHours(edt(8), night)).toBe(false);
    expect(inQuietHours(edt(22, 30), night)).toBe(true);
  });

  test('a window inside one day, and no window at all', () => {
    const office = { start: '09:00', end: '17:00' };
    expect(inQuietHours(est(10), office)).toBe(true);
    expect(inQuietHours(est(8, 59), office)).toBe(false);
    expect(inQuietHours(est(17), office)).toBe(false);
    expect(inQuietHours(est(10), null)).toBe(false);
  });
});

describe('relativeAgo', () => {
  const now = est(12);

  test('just now → minutes → hours → days', () => {
    expect(relativeAgo(now - 20_000, now)).toBe('just now');
    expect(relativeAgo(now + 60_000, now)).toBe('just now'); // clock skew never reads as the future
    expect(relativeAgo(now - 3 * 60_000, now)).toBe('3 min ago');
    expect(relativeAgo(now - 59.4 * 60_000, now)).toBe('59 min ago');
    expect(relativeAgo(now - 2 * 3_600_000, now)).toBe('2 h ago');
    expect(relativeAgo(now - 23.4 * 3_600_000, now)).toBe('23 h ago');
    expect(relativeAgo(now - 24 * 3_600_000, now)).toBe('1 day ago');
    expect(relativeAgo(now - 4 * DAY_MS, now)).toBe('4 days ago');
    expect(relativeAgo(new Date(now - 4 * DAY_MS).toISOString(), now)).toBe('4 days ago');
  });
});

describe('day maths and parsing', () => {
  test('daysBetween floors and never goes negative', () => {
    const t = est(12);
    expect(daysBetween(t, t + 1.9 * DAY_MS)).toBe(1);
    expect(daysBetween(t, t + 112 * DAY_MS)).toBe(112);
    expect(daysBetween(t + DAY_MS, t)).toBe(0);
    expect(daysBetween(new Date(t).toISOString(), new Date(t + 3 * DAY_MS).toISOString())).toBe(3);
  });

  test('toEpoch accepts numbers, Dates and ISO strings; garbage → 0', () => {
    const t = est(12);
    expect(toEpoch(t)).toBe(t);
    expect(toEpoch(new Date(t))).toBe(t);
    expect(toEpoch(new Date(t).toISOString())).toBe(t);
    expect(toEpoch('nope')).toBe(0);
  });
});

describe('formatting in America/New_York', () => {
  test('a UTC instant after midnight still reads as the previous New York evening', () => {
    const t = Date.parse('2026-01-16T04:30:00Z'); // 11:30 PM EST on Jan 15
    expect(formatDate(t)).toBe('Jan 15');
    expect(formatTime(t)).toMatch(/^11:30\sPM$/);
    expect(formatDateTime(t)).toMatch(/^Thu, Jan 15 · 11:30\sPM$/);
  });
});

describe('demo clock', () => {
  afterEach(() => setClockOffset(0));

  test('nowMs is device time plus the offset; a bad offset is ignored', () => {
    setClockOffset(3_600_000);
    expect(clockOffset()).toBe(3_600_000);
    expect(nowMs() - Date.now()).toBeGreaterThan(3_600_000 - 100);
    expect(nowMs() - Date.now()).toBeLessThanOrEqual(3_600_000);
    setClockOffset(Number.NaN);
    expect(clockOffset()).toBe(0);
  });
});
