// Minimal, dependency-free iCalendar (RFC 5545) reader for a Google Calendar
// "secret address" feed: VEVENTs with time zones, all-day dates, RRULE
// recurrence (DAILY/WEEKLY/MONTHLY/YEARLY with INTERVAL, COUNT, UNTIL, BYDAY,
// BYMONTHDAY), EXDATE exclusions and RECURRENCE-ID overrides.

export interface IcsProp {
  name: string;
  params: Record<string, string>;
  value: string;
}

export interface RawEvent {
  props: IcsProp[];
}

const DEFAULT_TZ = "Asia/Kolkata";

/** Splits a calendar into VEVENT property lists (lines unfolded). */
export function parseIcs(text: string): RawEvent[] {
  const lines = text.replace(/\r\n[ \t]/g, "").replace(/\n[ \t]/g, "").split(/\r?\n/);
  const events: RawEvent[] = [];
  let cur: IcsProp[] | null = null;
  let depth = 0; // skip nested components like VALARM
  for (const line of lines) {
    if (line === "BEGIN:VEVENT") {
      cur = [];
      depth = 0;
      continue;
    }
    if (!cur) continue;
    if (line === "END:VEVENT") {
      events.push({ props: cur });
      cur = null;
      continue;
    }
    if (line.startsWith("BEGIN:")) depth++;
    else if (line.startsWith("END:")) depth--;
    else if (depth === 0) {
      const p = parseProp(line);
      if (p) cur.push(p);
    }
  }
  return events;
}

function parseProp(line: string): IcsProp | null {
  // NAME;PARAM=a;PARAM2="b:c":VALUE — the first ':' outside quotes ends the parameters.
  let inQuote = false;
  let colon = -1;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') inQuote = !inQuote;
    else if (ch === ":" && !inQuote) {
      colon = i;
      break;
    }
  }
  if (colon < 0) return null;
  const [name = "", ...rawParams] = line.slice(0, colon).split(";");
  const params: Record<string, string> = {};
  for (const rp of rawParams) {
    const eq = rp.indexOf("=");
    if (eq > 0) params[rp.slice(0, eq).toUpperCase()] = rp.slice(eq + 1).replace(/^"|"$/g, "");
  }
  return { name: name.toUpperCase(), params, value: line.slice(colon + 1) };
}

export const unescapeText = (s: string) => s.replace(/\\n/gi, "\n").replace(/\\([,;\\])/g, "$1");

// ── time ──────────────────────────────────────────────────────────────────────

const partsFmt = new Map<string, Intl.DateTimeFormat>();
function tzOffsetMs(tz: string, utcMs: number): number {
  let f = partsFmt.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" });
    partsFmt.set(tz, f);
  }
  const p = Object.fromEntries(f.formatToParts(new Date(utcMs)).map((x) => [x.type, x.value]));
  const asUtc = Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), Number(p.hour) % 24, Number(p.minute), Number(p.second));
  return asUtc - Math.floor(utcMs / 1000) * 1000;
}

/** Wall-clock time in a zone → UTC epoch ms. */
export function zonedToUtc(y: number, mo: number, d: number, h: number, mi: number, s: number, tz: string): number {
  const guess = Date.UTC(y, mo, d, h, mi, s);
  let ms = guess - tzOffsetMs(tz, guess);
  ms = guess - tzOffsetMs(tz, ms); // second pass settles DST edges
  return ms;
}

export interface Stamp {
  ms: number;
  allDay: boolean;
  tz: string;
  /** Wall-clock fields in `tz` (used to step recurrences without DST drift). */
  wall: { y: number; mo: number; d: number; h: number; mi: number; s: number };
}

export function parseStamp(p: IcsProp | undefined, fallbackTz = DEFAULT_TZ): Stamp | null {
  if (!p) return null;
  const v = p.value.trim();
  const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?$/.exec(v);
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]) - 1, Number(m[3])];
  if (!m[4] || p.params.VALUE === "DATE") {
    return { ms: zonedToUtc(y, mo, d, 0, 0, 0, fallbackTz), allDay: true, tz: fallbackTz, wall: { y, mo, d, h: 0, mi: 0, s: 0 } };
  }
  const [h, mi, s] = [Number(m[4]), Number(m[5]), Number(m[6])];
  if (m[7] === "Z") {
    const ms = Date.UTC(y, mo, d, h, mi, s);
    // Step recurrences in the fallback zone's wall clock.
    const wallMs = ms + tzOffsetMs(fallbackTz, ms);
    const w = new Date(wallMs);
    return { ms, allDay: false, tz: fallbackTz, wall: { y: w.getUTCFullYear(), mo: w.getUTCMonth(), d: w.getUTCDate(), h: w.getUTCHours(), mi: w.getUTCMinutes(), s: w.getUTCSeconds() } };
  }
  const tz = validTz(p.params.TZID) ?? fallbackTz;
  return { ms: zonedToUtc(y, mo, d, h, mi, s, tz), allDay: false, tz, wall: { y, mo, d, h, mi, s } };
}

function validTz(tz: string | undefined): string | null {
  if (!tz) return null;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return tz;
  } catch {
    return null;
  }
}

function parseDuration(v: string | undefined): number | null {
  const m = v && /^([+-])?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(v.trim());
  if (!m) return null;
  const ms = ((Number(m[2] ?? 0) * 7 + Number(m[3] ?? 0)) * 86_400 + Number(m[4] ?? 0) * 3600 + Number(m[5] ?? 0) * 60 + Number(m[6] ?? 0)) * 1000;
  return m[1] === "-" ? -ms : ms;
}

// ── recurrence ────────────────────────────────────────────────────────────────

const DAYS = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"];

export interface RRule {
  freq: "DAILY" | "WEEKLY" | "MONTHLY" | "YEARLY";
  interval: number;
  count: number | null;
  untilMs: number | null;
  byDay: Array<{ n: number | null; wd: number }>;
  byMonthDay: number[];
}

export function parseRRule(v: string, tz: string): RRule | null {
  const kv = Object.fromEntries(v.split(";").map((x) => x.split("=") as [string, string]));
  const freq = kv.FREQ as RRule["freq"];
  if (!["DAILY", "WEEKLY", "MONTHLY", "YEARLY"].includes(freq)) return null;
  const until = kv.UNTIL ? parseStamp({ name: "UNTIL", params: {}, value: kv.UNTIL }, tz) : null;
  return {
    freq,
    interval: Math.max(1, Number(kv.INTERVAL ?? 1) || 1),
    count: kv.COUNT ? Number(kv.COUNT) : null,
    // A date-only UNTIL includes that whole day.
    untilMs: until ? (until.allDay ? until.ms + 86_399_999 : until.ms) : null,
    byDay: (kv.BYDAY ?? "")
      .split(",")
      .filter(Boolean)
      .map((t) => {
        const m = /^([+-]?\d+)?([A-Z]{2})$/.exec(t);
        return m ? { n: m[1] ? Number(m[1]) : null, wd: DAYS.indexOf(m[2]!) } : null;
      })
      .filter((x): x is { n: number | null; wd: number } => !!x && x.wd >= 0),
    byMonthDay: (kv.BYMONTHDAY ?? "").split(",").filter(Boolean).map(Number),
  };
}

const daysInMonth = (y: number, mo: number) => new Date(Date.UTC(y, mo + 1, 0)).getUTCDate();

/** Occurrence start times (UTC ms) of a recurring event, from DTSTART up to `windowEnd`. */
export function expandRRule(start: Stamp, rule: RRule, windowEnd: number, maxIter = 3000): number[] {
  const { h, mi, s } = start.wall;
  const out: number[] = [];
  const at = (y: number, mo: number, d: number) => (start.allDay ? zonedToUtc(y, mo, d, 0, 0, 0, start.tz) : zonedToUtc(y, mo, d, h, mi, s, start.tz));
  const push = (ms: number) => {
    if (ms < start.ms) return true;
    if (rule.untilMs !== null && ms > rule.untilMs) return false;
    if (ms > windowEnd) return false;
    if (rule.count !== null && out.length >= rule.count) return false;
    out.push(ms);
    return true;
  };
  let { y, mo, d } = start.wall;
  for (let i = 0; i < maxIter; i++) {
    let candidates: number[] = [];
    if (rule.freq === "DAILY") {
      candidates = [at(y, mo, d)];
    } else if (rule.freq === "WEEKLY") {
      const base = new Date(Date.UTC(y, mo, d));
      const weekStart = new Date(base.getTime() - base.getUTCDay() * 86_400_000);
      const wds = rule.byDay.length ? rule.byDay.map((b) => b.wd) : [new Date(Date.UTC(start.wall.y, start.wall.mo, start.wall.d)).getUTCDay()];
      candidates = [...new Set(wds)].sort().map((wd) => {
        const dt = new Date(weekStart.getTime() + wd * 86_400_000);
        return at(dt.getUTCFullYear(), dt.getUTCMonth(), dt.getUTCDate());
      });
    } else if (rule.freq === "MONTHLY") {
      const dim = daysInMonth(y, mo);
      if (rule.byMonthDay.length) {
        candidates = rule.byMonthDay.map((md) => (md < 0 ? dim + md + 1 : md)).filter((md) => md >= 1 && md <= dim).map((md) => at(y, mo, md));
      } else if (rule.byDay.length) {
        for (const b of rule.byDay) {
          const days = Array.from({ length: dim }, (_, k) => k + 1).filter((dd) => new Date(Date.UTC(y, mo, dd)).getUTCDay() === b.wd);
          const pick = b.n === null ? days : [b.n > 0 ? days[b.n - 1] : days[days.length + b.n]].filter((x): x is number => x !== undefined);
          candidates.push(...pick.map((dd) => at(y, mo, dd)));
        }
      } else if (start.wall.d <= dim) candidates = [at(y, mo, start.wall.d)];
    } else {
      if (start.wall.d <= daysInMonth(y, start.wall.mo)) candidates = [at(y, start.wall.mo, start.wall.d)];
    }
    for (const c of candidates.sort((a, b) => a - b)) if (!push(c)) return out;
    // advance one period
    if (rule.freq === "DAILY") {
      const n = new Date(Date.UTC(y, mo, d + rule.interval));
      [y, mo, d] = [n.getUTCFullYear(), n.getUTCMonth(), n.getUTCDate()];
    } else if (rule.freq === "WEEKLY") {
      const n = new Date(Date.UTC(y, mo, d + 7 * rule.interval));
      [y, mo, d] = [n.getUTCFullYear(), n.getUTCMonth(), n.getUTCDate()];
    } else if (rule.freq === "MONTHLY") {
      const n = new Date(Date.UTC(y, mo + rule.interval, 1));
      [y, mo, d] = [n.getUTCFullYear(), n.getUTCMonth(), 1];
    } else y += rule.interval;
    if (at(y, mo, rule.freq === "MONTHLY" ? 1 : d) > windowEnd + 31 * 86_400_000) break;
  }
  return out;
}

// ── events ────────────────────────────────────────────────────────────────────

export interface CalendarInstance {
  uid: string;
  /** Stable per occurrence: uid for single events, uid@originalStart for recurring ones. */
  instanceId: string;
  title: string;
  startMs: number;
  endMs: number;
  allDay: boolean;
  location: string | null;
  description: string | null;
  status: "confirmed" | "tentative" | "cancelled";
  recurring: boolean;
}

const get = (e: RawEvent, n: string) => e.props.find((p) => p.name === n);
const all = (e: RawEvent, n: string) => e.props.filter((p) => p.name === n);

/** All event occurrences overlapping [fromMs, toMs]. */
export function eventsBetween(text: string, fromMs: number, toMs: number, defaultTz = DEFAULT_TZ): CalendarInstance[] {
  const raw = parseIcs(text);
  const overrides = new Map<string, RawEvent>(); // uid@originalStartMs → override
  for (const e of raw) {
    const rid = parseStamp(get(e, "RECURRENCE-ID"), defaultTz);
    const uid = get(e, "UID")?.value;
    if (rid && uid) overrides.set(`${uid}@${rid.ms}`, e);
  }

  const out: CalendarInstance[] = [];
  const build = (e: RawEvent, uid: string, startMs: number, durMs: number, allDay: boolean, recurring: boolean, originalMs: number): CalendarInstance => {
    const st = (get(e, "STATUS")?.value ?? "CONFIRMED").toLowerCase();
    return {
      uid,
      instanceId: recurring ? `${uid}@${new Date(originalMs).toISOString()}` : uid,
      title: unescapeText(get(e, "SUMMARY")?.value ?? "(no title)").trim() || "(no title)",
      startMs,
      endMs: startMs + Math.max(0, durMs),
      allDay,
      location: get(e, "LOCATION") ? unescapeText(get(e, "LOCATION")!.value).trim() || null : null,
      description: get(e, "DESCRIPTION") ? unescapeText(get(e, "DESCRIPTION")!.value).trim().slice(0, 1000) || null : null,
      status: st === "cancelled" ? "cancelled" : st === "tentative" ? "tentative" : "confirmed",
      recurring,
    };
  };

  for (const e of raw) {
    if (get(e, "RECURRENCE-ID")) continue; // handled through its master
    const uid = get(e, "UID")?.value;
    const start = parseStamp(get(e, "DTSTART"), defaultTz);
    if (!uid || !start) continue;
    const end = parseStamp(get(e, "DTEND"), defaultTz);
    const durMs = end ? end.ms - start.ms : (parseDuration(get(e, "DURATION")?.value) ?? (start.allDay ? 86_400_000 : 0));
    const rr = get(e, "RRULE");
    if (!rr) {
      if (start.ms <= toMs && start.ms + durMs >= fromMs) out.push(build(e, uid, start.ms, durMs, start.allDay, false, start.ms));
      continue;
    }
    const rule = parseRRule(rr.value, start.tz);
    if (!rule) continue;
    const ex = new Set(all(e, "EXDATE").flatMap((p) => p.value.split(",").map((v) => parseStamp({ ...p, value: v }, start.tz)?.ms).filter((x): x is number => x !== undefined)));
    for (const occ of expandRRule(start, rule, toMs)) {
      if (ex.has(occ)) continue;
      const ov = overrides.get(`${uid}@${occ}`);
      if (ov) {
        const os = parseStamp(get(ov, "DTSTART"), defaultTz);
        const oe = parseStamp(get(ov, "DTEND"), defaultTz);
        if (!os) continue;
        const od = oe ? oe.ms - os.ms : durMs;
        if (os.ms <= toMs && os.ms + od >= fromMs) out.push(build(ov, uid, os.ms, od, os.allDay, true, occ));
        continue;
      }
      if (occ + durMs >= fromMs) out.push(build(e, uid, occ, durMs, start.allDay, true, occ));
    }
  }
  return out.sort((a, b) => a.startMs - b.startMs || a.instanceId.localeCompare(b.instanceId));
}
