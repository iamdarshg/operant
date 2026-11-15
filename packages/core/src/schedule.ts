/**
 * Recurrence for scheduled jobs.
 *
 * Deliberately a **documented subset** of RFC 5545 rather than a half-implemented
 * rrule library: a scheduler that silently mis-fires is worse than one that
 * refuses a rule it does not understand.
 *
 * Supported forms (order-independent, `;` separated):
 *   FREQ=DAILY|WEEKLY|HOURLY
 *   INTERVAL=<n>            (default 1; multiplies the frequency period)
 *   BYHOUR=<0-23>[,..]      (default: same hour as `from`)
 *   BYMINUTE=<0-59>[,..]    (default: same minute as `from`)
 *   BYDAY=MO,TU,...         (WEEKLY only)
 *
 * Anything else throws `UnsupportedRule` so the caller records a real error
 * instead of scheduling something surprising.
 */

export class UnsupportedRule extends Error {
  constructor(rule: string, detail: string) {
    super(`unsupported recurrence ${JSON.stringify(rule)}: ${detail}`);
    this.name = 'UnsupportedRule';
  }
}

export interface ParsedRule {
  freq: 'HOURLY' | 'DAILY' | 'WEEKLY';
  interval: number;
  byHour: number[];
  byMinute: number[];
  byDay: number[]; // 0 = Sunday … 6 = Saturday
}

const DAY_INDEX: Record<string, number> = { SU: 0, MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6 };

/** Parse a supported rule, rejecting everything else loudly. */
export function parseRule(rule: string): ParsedRule {
  const parts = new Map<string, string>();
  for (const kv of rule.split(';')) {
    const trimmed = kv.trim();
    if (trimmed.length === 0) continue;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) throw new UnsupportedRule(rule, `malformed segment ${JSON.stringify(trimmed)}`);
    parts.set(trimmed.slice(0, eq).toUpperCase(), trimmed.slice(eq + 1));
  }

  const freqRaw = parts.get('FREQ');
  if (!freqRaw) throw new UnsupportedRule(rule, 'FREQ is required');
  const freq = freqRaw.toUpperCase();
  if (freq !== 'HOURLY' && freq !== 'DAILY' && freq !== 'WEEKLY') {
    throw new UnsupportedRule(rule, `FREQ=${freq} is not supported (HOURLY, DAILY, WEEKLY)`);
  }

  const interval = parts.has('INTERVAL') ? Number(parts.get('INTERVAL')) : 1;
  if (!Number.isInteger(interval) || interval < 1 || interval > 60) {
    throw new UnsupportedRule(rule, 'INTERVAL must be an integer 1..60');
  }

  const numbers = (key: string, max: number): number[] => {
    if (!parts.has(key)) return [];
    return parts
      .get(key)!
      .split(',')
      .map((v) => {
        const n = Number(v.trim());
        if (!Number.isInteger(n) || n < 0 || n > max) {
          throw new UnsupportedRule(rule, `${key}=${v} is out of range 0..${max}`);
        }
        return n;
      });
  };

  const byHour = numbers('BYHOUR', 23);
  const byMinute = numbers('BYMINUTE', 59);

  let byDay: number[] = [];
  if (parts.has('BYDAY')) {
    if (freq !== 'WEEKLY') throw new UnsupportedRule(rule, 'BYDAY is only supported with FREQ=WEEKLY');
    byDay = parts
      .get('BYDAY')!
      .split(',')
      .map((d) => {
        const idx = DAY_INDEX[d.trim().toUpperCase().slice(0, 2)];
        if (idx === undefined) throw new UnsupportedRule(rule, `unknown BYDAY ${d}`);
        return idx;
      });
    if (byDay.length === 0) throw new UnsupportedRule(rule, 'BYDAY list is empty');
  }

  return { freq, interval, byHour, byMinute, byDay };
}

/* ------------------------------------------------------------------ *
 * Timezone helpers
 * ------------------------------------------------------------------ */

/** Offset of `zone` at `at`, in minutes east of UTC. */
export function zoneOffsetMinutes(at: Date, zone: string): number {
  // Formatting the instant in the target zone and reading it back as if it were
  // UTC yields the difference between the two clocks.
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: zone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  const parts = Object.fromEntries(fmt.formatToParts(at).map((p) => [p.type, p.value]));
  const asUtc = Date.UTC(
    Number(parts['year']),
    Number(parts['month']) - 1,
    Number(parts['day']),
    Number(parts['hour']) % 24,
    Number(parts['minute']),
    Number(parts['second']),
  );
  return Math.round((asUtc - at.getTime()) / 60_000);
}

/** Local wall-clock fields for an instant in a zone. */
export function zonedParts(at: Date, zone: string): { y: number; m: number; d: number; hour: number; minute: number; weekday: number } {
  const offset = zoneOffsetMinutes(at, zone);
  const shifted = new Date(at.getTime() + offset * 60_000);
  return {
    y: shifted.getUTCFullYear(),
    m: shifted.getUTCMonth() + 1,
    d: shifted.getUTCDate(),
    hour: shifted.getUTCHours(),
    minute: shifted.getUTCMinutes(),
    weekday: shifted.getUTCDay(),
  };
}

/** Convert a wall-clock time in a zone to the matching UTC instant. */
export function zonedToUtc(y: number, m: number, d: number, hour: number, minute: number, zone: string): Date {
  const guess = Date.UTC(y, m - 1, d, hour, minute, 0);
  const firstOffset = zoneOffsetMinutes(new Date(guess), zone);
  const candidate = new Date(guess - firstOffset * 60_000);
  // One correction pass handles a DST boundary between the guess and the answer.
  const secondOffset = zoneOffsetMinutes(candidate, zone);
  return secondOffset === firstOffset ? candidate : new Date(guess - secondOffset * 60_000);
}

/* ------------------------------------------------------------------ *
 * Next occurrence
 * ------------------------------------------------------------------ */

/**
 * Compute the first occurrence strictly after `from`.
 *
 * @throws UnsupportedRule for rules outside the supported subset
 */
export function nextRunAt(rule: string, timeZone: string, from: Date): Date {
  const parsed = parseRule(rule);
  const local = zonedParts(from, timeZone);
  const hours = parsed.byHour.length > 0 ? parsed.byHour : [local.hour];
  const minutes = parsed.byMinute.length > 0 ? parsed.byMinute : [local.minute];

  if (parsed.freq === 'HOURLY') {
    // Advance whole intervals from the top of the current hour.
    const base = zonedToUtc(local.y, local.m, local.d, local.hour, 0, timeZone);
    for (let step = 1; step <= 60 * 24 * 7; step += 1) {
      const candidate = new Date(base.getTime() + step * parsed.interval * 3_600_000);
      if (candidate.getTime() > from.getTime()) return candidate;
    }
    throw new UnsupportedRule(rule, 'no hourly occurrence found within a week');
  }

  // DAILY / WEEKLY: walk forward day by day and take the earliest matching wall
  // time. Bounded so a rule that can never match fails loudly instead of looping.
  const startOfDay = new Date(Date.UTC(local.y, local.m - 1, local.d));
  for (let offsetDays = 0; offsetDays <= 400 * parsed.interval; offsetDays += 1) {
    const day = new Date(startOfDay.getTime() + offsetDays * 86_400_000);
    const dayParts = {
      y: day.getUTCFullYear(),
      m: day.getUTCMonth() + 1,
      d: day.getUTCDate(),
      weekday: day.getUTCDay(),
    };

    if (parsed.freq === 'WEEKLY') {
      if (parsed.byDay.length > 0 && !parsed.byDay.includes(dayParts.weekday)) continue;
      // Weekly intervals are measured in whole weeks from the start week.
      if (Math.floor(offsetDays / 7) % parsed.interval !== 0) continue;
    } else if (offsetDays % parsed.interval !== 0) {
      continue;
    }

    for (const hour of [...hours].sort((a, b) => a - b)) {
      for (const minute of [...minutes].sort((a, b) => a - b)) {
        const candidate = zonedToUtc(dayParts.y, dayParts.m, dayParts.d, hour, minute, timeZone);
        if (candidate.getTime() > from.getTime()) return candidate;
      }
    }
  }

  throw new UnsupportedRule(rule, 'no occurrence found within the search window');
}

/** Human-readable description for UI and logs. */
export function describeRule(rule: string): string {
  try {
    const p = parseRule(rule);
    const at = `${p.byHour.length > 0 ? p.byHour.join(',') : 'same hour'}:${p.byMinute.length > 0 ? String(p.byMinute[0]).padStart(2, '0') : 'same minute'}`;
    if (p.freq === 'HOURLY') return p.interval === 1 ? 'every hour' : `every ${p.interval} hours`;
    if (p.freq === 'DAILY') return `${p.interval === 1 ? 'daily' : `every ${p.interval} days`} at ${at}`;
    const days = p.byDay.length > 0 ? p.byDay.map((d) => ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][d]).join(', ') : 'same weekday';
    return `${p.interval === 1 ? 'weekly' : `every ${p.interval} weeks`} on ${days} at ${at}`;
  } catch {
    return rule;
  }
}