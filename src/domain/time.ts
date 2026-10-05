/**
 * Time helpers. The pilot city is in America/New_York; every date shown to a resident is formatted in that zone.
 * `nowMs()` is the app clock: device time plus the demo offset, so demo scenarios can set "tonight".
 * Device-time facts (cache ages, GPS fixes) must use Date.now() / useRealNow instead.
 * Pure module: no React Native or Expo imports.
 */

export const TZ = 'America/New_York';

let clockOffsetMs = 0;

export function setClockOffset(ms: number): void {
  clockOffsetMs = Number.isFinite(ms) ? ms : 0;
}

export function clockOffset(): number {
  return clockOffsetMs;
}

/** App clock (device time + demo offset). */
export function nowMs(): number {
  return Date.now() + clockOffsetMs;
}

export function nowIso(): string {
  return new Date(nowMs()).toISOString();
}

export function toEpoch(iso: string | number | Date): number {
  if (typeof iso === 'number') return iso;
  if (iso instanceof Date) return iso.getTime();
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : 0;
}

export const DAY_MS = 86_400_000;

/** Whole days between two instants (floor, never negative). */
export function daysBetween(from: string | number, to: string | number): number {
  const d = Math.floor((toEpoch(to) - toEpoch(from)) / DAY_MS);
  return d < 0 ? 0 : d;
}

/** "just now", "3 min ago", "2 h ago", "4 days ago". */
export function relativeAgo(then: string | number, now: number): string {
  const diff = Math.max(0, now - toEpoch(then));
  const min = Math.round(diff / 60_000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min} min ago`;
  const h = Math.round(min / 60);
  if (h < 24) return `${h} h ago`;
  const d = Math.round(h / 24);
  return d === 1 ? '1 day ago' : `${d} days ago`;
}

export function formatDate(iso: string | number, opts: Intl.DateTimeFormatOptions = { month: 'short', day: 'numeric' }): string {
  return new Intl.DateTimeFormat('en-US', { timeZone: TZ, ...opts }).format(new Date(toEpoch(iso)));
}

export function formatTime(iso: string | number): string {
  return new Intl.DateTimeFormat('en-US', { timeZone: TZ, hour: 'numeric', minute: '2-digit' }).format(new Date(toEpoch(iso)));
}

export function formatDateTime(iso: string | number): string {
  return `${formatDate(iso, { weekday: 'short', month: 'short', day: 'numeric' })} · ${formatTime(iso)}`;
}

/** Minutes since local midnight in the pilot zone, for quiet-hour checks. */
export function localMinutes(at: number): number {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: TZ, hour: 'numeric', minute: 'numeric', hourCycle: 'h23' }).formatToParts(new Date(at));
  const h = Number(parts.find((p) => p.type === 'hour')?.value ?? 0);
  const m = Number(parts.find((p) => p.type === 'minute')?.value ?? 0);
  return h * 60 + m;
}

/** True when `at` falls inside a quiet-hours window such as 22:00–07:00 (wraps midnight). */
export function inQuietHours(at: number, window: { start: string; end: string } | null): boolean {
  if (!window) return false;
  const toMin = (s: string) => {
    const [h, m] = s.split(':').map(Number);
    return (h ?? 0) * 60 + (m ?? 0);
  };
  const start = toMin(window.start);
  const end = toMin(window.end);
  const cur = localMinutes(at);
  return start <= end ? cur >= start && cur < end : cur >= start || cur < end;
}
