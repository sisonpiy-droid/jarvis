import { addDays, daysBetween, isDay, istDay, weekday, type Day } from "@jarvis/db";

// Grounding: which dates and ids a piece of text claims, and whether the data behind it backs them. The chat
// guard checks a reply against its tool results with this, the focus-note tests prove the note can't invent a
// date, and the brief's render check runs it over the rendered text. Pure — no SQL, no AI, Edge-safe.
//
// Checked: calendar days (in any of the formats JARVIS and its users write), weekdays and ids. Not checked:
// clock times, counts and durations — "5:30 pm" or "3 tasks" pass whatever the data says.

export const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];
/** ISO order: index + 1 is the ISO weekday (Monday = 1). */
export const WEEKDAYS = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"];
/** Words that name a day relative to today (the focus note may not write them; "today" and "now" are fine). */
export const RELATIVE_DAY_WORDS = ["tomorrow", "tonight", "yesterday", "weekend", "next week", "this week", "last week", "end of day", "day after", "day before", "fortnight", "next month"];
export const NUMBER_WORDS = [
  "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten",
  "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen", "nineteen", "twenty",
  "dozen", "couple", "half", "double", "twice",
  // Beyond the spec's list (appended, so the first twenty stay one..twenty): tens, ordinals that read as a
  // date ("by the third") and other quantities, so the focus note can't state "thirty minutes" either.
  "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety", "hundred", "thousand", "quarter", "triple", "thrice",
  "second", "third", "fourth", "fifth", "sixth", "seventh", "eighth", "ninth", "tenth", "eleventh", "twelfth",
  "thirteenth", "fourteenth", "fifteenth", "sixteenth", "seventeenth", "eighteenth", "nineteenth", "twentieth", "thirtieth",
];

export type Mention = { kind: "day"; day: Day; raw: string } | { kind: "weekday"; dow: number; raw: string } | { kind: "id"; id: number; raw: string };

export interface Evidence {
  days: Set<Day>;
  ids: Set<number>;
}

// ── patterns ──────────────────────────────────────────────────────────────────

const MONTH_ALT = [...MONTHS, "sept", ...MONTHS.map((m) => m.slice(0, 3))].join("|");
const WEEKDAY_ALT = [...WEEKDAYS, "tues", "thurs", "thur", ...WEEKDAYS.map((d) => d.slice(0, 3))].join("|");
const ORD = "(?:st|nd|rd|th)?";
const WD_PREFIX = `(?:\\b(?:${WEEKDAY_ALT})(?![a-z])\\.?,?\\s+)?`;
/** A written year: only 19xx / 20xx, so "Oct 2, 1000 words" isn't the year 1000. */
const YEAR = "(?:,?\\s+((?:19|20)\\d{2})(?!\\d))?";

/** Zones: "Z", "+05:30", "+0530", and Postgres's "+00". */
const ISO_RE = /\b(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::\d{2}(?:\.\d+)?)?(Z|[+-]\d{2}:?\d{2}|\+\d{2})?)?(?![\d-])/g;
/** "2 Oct", "2nd October", "Fri, 2 Oct", "Thursday, 1 October 2026", "2 of October". */
const DAY_MONTH_RE = new RegExp(`${WD_PREFIX}\\b(\\d{1,2})${ORD}\\s+(?:of\\s+)?(${MONTH_ALT})(?![a-z])\\.?${YEAR}`, "gi");
/** "Oct 2", "October 2nd, 2026", "Fri, Oct 2". */
const MONTH_DAY_RE = new RegExp(`${WD_PREFIX}\\b(${MONTH_ALT})(?![a-z])\\.?\\s+(\\d{1,2})${ORD}(?![\\d:])${YEAR}`, "gi");
/** "02/10" (day/month) — both parts zero-padded, or with a year, so fractions like "3/4" aren't read as dates. */
const NUMERIC_RE = /(?<![\d/])(\d{1,2})\/(\d{1,2})(?:\/(\d{4}|\d{2}))?(?![\d/])/g;
const REL_WORD_RE = /\b(day after tomorrow|today|tonight|tomorrow|yesterday)\b/gi;
const REL_WEEKDAY_RE = new RegExp(`\\b(next|this|coming|last)\\s+(${WEEKDAY_ALT})(?![a-z])`, "gi");
const IN_DAYS_RE = new RegExp(`\\bin\\s+(\\d{1,2}|${NUMBER_WORDS.slice(0, 20).join("|")})\\s+days?\\b`, "gi");
const WEEKDAY_RE = new RegExp(`\\b(${WEEKDAYS.join("|")})\\b`, "gi");
/** Short weekdays only when capitalised and followed by "," or a number — "sat down" and "sun" aren't days. */
const WEEKDAY_SHORT_RE = /\b(Mon|Tues?|Wed|Thu(?:rs?)?|Fri|Sat|Sun)\b\.?(?=,|\s*\d)/g;
/** "task 12", "goal #3" — but not a count or amount: "goal 3 times a week", "habit 5 days in a row", "habit 3 of 4". */
const ID_WORD_RE =
  /\b(task|goal|project|habit|memory|id)\s*(?:#|no\.?\s*)?(\d{1,9})\b(?![.,]?\d|-|\s*(?:\/|%|x\b|times\b|of\s+\d|out\s+of\b|per\b|(?:days?|weeks?|months?|hours?|hrs?|h|mins?|minutes?|pages?|chapters?)\b))/gi;
/** "#12" — but not "#1 priority". */
const HASH_ID_RE = /#(\d{1,9})\b(?!\s+priorit)/g;

const monthIndex = (name: string) => MONTHS.findIndex((m) => m.startsWith(name.toLowerCase().slice(0, 3)));
const isoDow = (name: string) => WEEKDAYS.findIndex((d) => d.startsWith(name.toLowerCase().slice(0, 3))) + 1;
const numberValue = (s: string) => (/^\d+$/.test(s) ? Number(s) : NUMBER_WORDS.indexOf(s.toLowerCase()) + 1);
const pad = (n: number) => String(n).padStart(2, "0");

/** The day for a day and month: with a year when written, else the occurrence nearest today (within ±6 months). */
function dayOf(dd: number, mm: number, year: string | undefined, today: Day): Day | null {
  if (year) {
    const y = year.length === 2 ? 2000 + Number(year) : Number(year);
    const d = `${y}-${pad(mm)}-${pad(dd)}`;
    return isDay(d) ? d : null;
  }
  const y = Number(today.slice(0, 4));
  const candidates = [y - 1, y, y + 1].map((c) => `${c}-${pad(mm)}-${pad(dd)}`).filter(isDay);
  if (!candidates.length) return null;
  return candidates.reduce((best, c) => (Math.abs(daysBetween(today, c)) < Math.abs(daysBetween(today, best)) ? c : best));
}

/** The next (or this, or last) given weekday: "this" is 0–6 days ahead, "next" 1–7 ahead, "last" 1–7 back. */
function relativeWeekday(which: string, dow: number, today: Day): Day {
  const ahead = (dow - weekday(today) + 7) % 7;
  switch (which.toLowerCase()) {
    case "last":
      return addDays(today, -(((weekday(today) - dow + 7) % 7) || 7));
    case "next":
      return addDays(today, ahead || 7);
    default:
      return addDays(today, ahead);
  }
}

/** The IST day of an ISO date or timestamp; a timestamp without a zone keeps its written date. */
function isoDay(m: RegExpMatchArray): Day | null {
  const [, y, mo, d, hh, mi, zone] = m;
  const date = `${y}-${mo}-${d}`;
  if (!isDay(date)) return null;
  if (!hh || !zone) return date;
  const z = zone === "Z" ? "Z" : zone.length === 3 ? `${zone}:00` : zone.length === 5 ? `${zone.slice(0, 3)}:${zone.slice(3)}` : zone;
  const ms = Date.parse(`${date}T${hh}:${mi}:00${z}`);
  return Number.isFinite(ms) ? istDay(ms) : date;
}

/** Every day, weekday and id the text mentions, in text order. Days resolve against IST today. */
export function extractMentions(text: string, now: Date): Mention[] {
  const today = istDay(now);
  const found: Array<{ at: number; end: number; m: Mention }> = [];
  const taken = (at: number, end: number) => found.some((f) => at < f.end && end > f.at);
  const scan = (re: RegExp, make: (m: RegExpMatchArray) => Mention | null) => {
    for (const m of text.matchAll(re)) {
      const at = m.index!;
      const end = at + m[0].length;
      if (taken(at, end)) continue;
      const mention = make(m);
      if (mention) found.push({ at, end, m: mention });
    }
  };
  const day = (d: Day | null, raw: string): Mention | null => (d ? { kind: "day", day: d, raw } : null);
  // "may" is a verb far more often than a month: only "May" counts.
  const month = (name: string) => (name === "may" ? -1 : monthIndex(name));

  // Most specific first; a later pattern never matches inside an earlier match.
  scan(ISO_RE, (m) => day(isoDay(m), m[0]));
  scan(ID_WORD_RE, (m) => ({ kind: "id", id: Number(m[2]), raw: m[0] }));
  scan(HASH_ID_RE, (m) => ({ kind: "id", id: Number(m[1]), raw: m[0] }));
  scan(DAY_MONTH_RE, (m) => {
    const mo = month(m[2]!);
    return mo < 0 ? null : day(dayOf(Number(m[1]), mo + 1, m[3], today), m[0]);
  });
  scan(MONTH_DAY_RE, (m) => {
    const mo = month(m[1]!);
    return mo < 0 ? null : day(dayOf(Number(m[2]), mo + 1, m[3], today), m[0]);
  });
  scan(NUMERIC_RE, (m) => {
    const [, dd, mm, yy] = m;
    if (!yy && (dd!.length < 2 || mm!.length < 2)) return null;
    return day(dayOf(Number(dd), Number(mm), yy, today), m[0]);
  });
  scan(REL_WEEKDAY_RE, (m) => day(relativeWeekday(m[1]!, isoDow(m[2]!), today), m[0]));
  scan(IN_DAYS_RE, (m) => day(addDays(today, numberValue(m[1]!)), m[0]));
  scan(REL_WORD_RE, (m) => {
    const w = m[1]!.toLowerCase();
    return day(addDays(today, w === "day after tomorrow" ? 2 : w === "tomorrow" ? 1 : w === "yesterday" ? -1 : 0), m[0]);
  });
  scan(WEEKDAY_RE, (m) => ({ kind: "weekday", dow: isoDow(m[1]!), raw: m[0] }));
  scan(WEEKDAY_SHORT_RE, (m) => ({ kind: "weekday", dow: isoDow(m[1]!), raw: m[0] }));

  return found.sort((a, b) => a.at - b.at).map((f) => f.m);
}

// ── evidence ──────────────────────────────────────────────────────────────────

const ID_KEY_RE = /^ids?$|_ids?$|[a-z]Ids?$/;

/**
 * The days and ids that tool results (`values`, walked recursively) and free texts (the owner's message,
 * memory ids as "#N") back: ISO timestamps as IST days, YYYY-MM-DD values, `id` / `*_id` numbers, and
 * whatever extractMentions finds in other strings. Today, tomorrow and yesterday are always in.
 */
export function evidenceFrom(values: unknown[], texts: string[], now: Date): Evidence {
  const today = istDay(now);
  const ev: Evidence = { days: new Set([addDays(today, -1), today, addDays(today, 1)]), ids: new Set() };
  const addText = (s: string) => {
    for (const m of extractMentions(s, now)) {
      if (m.kind === "day") ev.days.add(m.day);
      else if (m.kind === "id") ev.ids.add(m.id);
    }
  };
  const walk = (v: unknown, key: string, depth: number): void => {
    if (v == null || depth > 30) return;
    const idKey = ID_KEY_RE.test(key);
    if (typeof v === "number") {
      if (idKey && Number.isInteger(v)) ev.ids.add(v);
    } else if (typeof v === "string") {
      if (idKey && /^\d{1,9}$/.test(v)) ev.ids.add(Number(v));
      else if (isDay(v)) ev.days.add(v);
      // Timestamps go through extractMentions too, so a zoned one becomes its IST day and a zoneless one keeps
      // its written date — never Date.parse's machine-local reading.
      else addText(v);
    } else if (v instanceof Date) {
      if (Number.isFinite(v.getTime())) ev.days.add(istDay(v));
    } else if (Array.isArray(v)) {
      for (const x of v) walk(x, key, depth + 1);
    } else if (typeof v === "object") {
      for (const [k, x] of Object.entries(v)) walk(x, k, depth + 1);
    }
  };
  for (const v of values) walk(v, "", 0);
  for (const t of texts) addText(t);
  return ev;
}

// ── the check ─────────────────────────────────────────────────────────────────

/**
 * Does the evidence back every day, weekday and id the reply mentions? A weekday passes when some evidence
 * day from a week ago to 13 days ahead falls on it. Violations are "10-09"-style day keys, "#44" ids, or the
 * weekday as written.
 */
export function checkGrounding(reply: string, ev: Evidence, now: Date): { ok: boolean; violations: string[] } {
  const today = istDay(now);
  const near = [...ev.days].filter((d) => {
    const n = daysBetween(today, d);
    return n >= -7 && n <= 13;
  });
  const violations = new Set<string>();
  for (const m of extractMentions(reply, now)) {
    if (m.kind === "day" && !ev.days.has(m.day)) violations.add(m.day.slice(5));
    else if (m.kind === "id" && !ev.ids.has(m.id)) violations.add(`#${m.id}`);
    else if (m.kind === "weekday" && !near.some((d) => weekday(d) === m.dow)) violations.add(m.raw.replace(/[.,]$/, ""));
  }
  return { ok: violations.size === 0, violations: [...violations] };
}

/** The repair turn the chat guard sends when a draft reply mentions something the data doesn't back. */
export function groundingCorrection(violations: string[]): string {
  return `Your draft mentions ${violations.join(", ")}, which are not in any tool result or this conversation. Use only dates and IDs from tool results — call a tool if you need one — or say you don't know.`;
}
