import { fmtIstTime, fmtMinutes, PERIOD_LABEL, refKey, whenLabel, type BriefFacts, type BriefSections, type FactRef, type FocusItem, type RiskItem } from "@jarvis/db";
import { MONTHS, NUMBER_WORDS, RELATIVE_DAY_WORDS, WEEKDAYS } from "./grounding";
import { textOf, userText, type ModelProvider } from "./model";

// The 🧭 FOCUS note of the morning brief: 2–3 sentences of advice about today. The model never writes a fact
// itself — it sees the facts as numbered tokens and may only refer to them as placeholders ({P1}, {U1.when}).
// The validator rejects any digit, date word or number word outside a placeholder, so the note can't state a
// date or number the data doesn't hold; we substitute the real values afterwards. One model call a day, no
// retry; anything wrong falls back to a deterministic note built from the same tokens.

export type NoteKey = `P${1 | 2 | 3}` | `Q${1 | 2 | 3}` | `H${1 | 2 | 3 | 4}` | `U${1 | 2 | 3 | 4 | 5}` | `G${1 | 2 | 3 | 4 | 5}` | `R${1 | 2 | 3 | 4 | 5}` | "FREE" | "FIRST";

export interface NoteToken {
  /** A title (quoted when substituted), or for FREE / FIRST a phrase used as-is. */
  value: string;
  /** Extra values the note may use as {KEY.field}, substituted as-is. */
  fields: Record<string, string>;
  refs: FactRef[];
  /** Substitute `value` without quotes (FREE, FIRST, and risks about MESA itself). */
  plain?: boolean;
}

const NOTE_TIMEOUT_MS = 20_000;
const TITLE_MAX = 60;
const RISK_WORD: Record<string, string> = { off_track: "off track", at_risk: "at risk", on_track: "on track", met: "met", untracked: "untracked" };

const num = (n: number) => String(Math.round(n * 10) / 10);
const taskRef = (i: FocusItem): FactRef => ({ t: "task", id: i.task.id });
const dueOf = (i: FocusItem, now: Date) => (i.task.dueAt ? whenLabel(i.task.dueAt, i.task.dueIsDateOnly, now) : null);

function focusToken(i: FocusItem, now: Date): NoteToken {
  const due = dueOf(i, now);
  return { value: i.task.title, fields: { ...(due ? { due } : {}), why: i.reasons.join(", ") }, refs: [taskRef(i)] };
}

/** What a risk line is about: the title of its row, "MESA" for sign-in and data freshness. */
function riskAbout(r: RiskItem, f: BriefFacts): { about: string; plain: boolean } {
  if (r.refs.length > 1) return { about: r.kind === "overdue" ? "the other overdue items" : r.text, plain: true };
  const ref = r.refs[0];
  let title: string | undefined;
  switch (ref?.t) {
    case "task":
      title = f.openTasks.find((t) => t.id === ref.id)?.title;
      break;
    case "goal":
      title = f.goals.find((g) => g.id === ref.id)?.title;
      break;
    case "habit":
      title = (f.slipping.find((s) => s.habit.id === ref.id)?.habit ?? f.habits.find((h) => h.id === ref.id))?.name;
      break;
    case "project":
      title = f.projects.find((p) => p.id === ref.id)?.title;
      break;
    case "lms":
      title = f.lmsDue.find((a) => a.id === ref.id)?.title ?? [...f.calendar, ...f.calendarWeek].find((e) => e.ref.t === "lms" && e.ref.id === ref.id)?.title;
      break;
    case "integration":
      return { about: "MESA", plain: true };
  }
  return title ? { about: title, plain: false } : { about: r.text, plain: true };
}

/**
 * The note's facts as tokens: P1–P3 priorities, Q1–Q3 personal tasks, H1–H4 habits, U1–U5 upcoming, G1–G5
 * goals, R1–R5 risks, FREE (today's free time) and FIRST (the next class or event today). Each carries the
 * rows it came from.
 */
export function noteFacts(f: BriefFacts, s: BriefSections): Record<string, NoteToken> {
  const now = new Date(f.at);
  const out: Record<string, NoteToken> = {};
  s.priorities.slice(0, 3).forEach((i, n) => (out[`P${n + 1}`] = focusToken(i, now)));
  s.personal.tasks.slice(0, 3).forEach((i, n) => (out[`Q${n + 1}`] = focusToken(i, now)));
  s.personal.habits.slice(0, 4).forEach((h, n) => {
    const st = h.status;
    const status = st.today === "done" ? "done today" : st.today === "skipped" ? "skipped today" : "due today";
    const detail = st.periodTarget != null ? `${st.periodDone} of ${st.periodTarget} ${h.schedule.freq === "monthly" ? "this month" : "this week"}` : st.streak > 0 ? `${st.streak}-day streak` : status;
    out[`H${n + 1}`] = { value: h.name, fields: { detail, status }, refs: [{ t: "habit", id: h.id }] };
  });
  s.upcoming.slice(0, 5).forEach((d, n) => (out[`U${n + 1}`] = { value: d.title, fields: { when: d.when, ...(d.context ? { context: d.context } : {}) }, refs: [d.ref] }));
  s.goals.slice(0, 5).forEach((g, n) => {
    const p = g.progress;
    const progress = p.target != null ? `${num(p.current ?? 0)} of ${num(p.target)}${g.unit ? ` ${g.unit}` : ""} ${PERIOD_LABEL[g.period]}` : null;
    out[`G${n + 1}`] = { value: g.title, fields: { ...(progress ? { progress } : {}), risk: RISK_WORD[g.risk.risk] ?? g.risk.risk, reason: g.risk.reason }, refs: [{ t: "goal", id: g.id }] };
  });
  s.risks.slice(0, 5).forEach((r, n) => {
    const { about, plain } = riskAbout(r, f);
    out[`R${n + 1}`] = { value: about, fields: { text: r.text }, refs: r.refs, ...(plain ? { plain } : {}) };
  });

  const timed = f.calendar.filter((e) => !e.cancelled && !e.allDay);
  if (f.freeTime.freeMin > 0) {
    out.FREE = { value: `${fmtMinutes(f.freeTime.freeMin)} free ${timed.length ? "between classes" : "today"}`, fields: {}, refs: timed.map((e) => e.ref), plain: true };
  }
  const first = timed.find((e) => Date.parse(e.startAt) >= now.getTime());
  if (first) out.FIRST = { value: `${fmtIstTime(first.startAt)} ${first.title}`, fields: { time: fmtIstTime(first.startAt), title: first.title }, refs: [first.ref], plain: true };
  return out;
}

/** What the model sees: the tokens' values only (no ids or refs). */
function modelFacts(tokens: Record<string, NoteToken>) {
  return Object.fromEntries(
    Object.entries(tokens).map(([k, t]) => [k, k === "FREE" || k === "FIRST" ? t.value : { [k.startsWith("R") ? "about" : "title"]: t.value, ...t.fields }]),
  );
}

export const FOCUS_NOTE_SYSTEM =
  "Write the FOCUS note of the owner's morning brief: 2–3 short, practical sentences in second person about today, using ONLY FACTS. " +
  "Refer to facts ONLY with placeholders in braces: {P1}, {P1.due}, {Q1}, {H1}, {H1.detail}, {U1}, {U1.when}, {G1}, {G1.progress}, {R1}, {R1.text}, {FREE}, {FIRST}. " +
  'Never write a title, name, number, date, weekday, month or time yourself; no digits; no "tomorrow/tonight/weekend/next week". ' +
  "Don't say anything is done, submitted, moved, cancelled or extended. No markdown, emoji or links. Max 300 characters. " +
  'Reply as JSON {"note": "..."}.';

// ── validation ────────────────────────────────────────────────────────────────

const PLACEHOLDER_RE = /\{([^{}]*)\}/g;
const KEY_RE = /^([A-Z][A-Z0-9]*)(?:\.([a-z]+))?$/;
const words = (list: string[]) => new RegExp(`\\b(?:${list.map((w) => w.replace(/ /g, "\\s+")).join("|")})\\b`, "i");
// "may" is left to the modal verb; a capitalised "May" is still a month.
const DATE_WORD_RES = [
  words([...MONTHS.filter((m) => m !== "may"), "sept", ...MONTHS.filter((m) => m !== "may").map((m) => m.slice(0, 3))]),
  /\bMay\b/,
  words([...WEEKDAYS, "tues", "thur", "thurs", ...WEEKDAYS.map((d) => d.slice(0, 3))]),
  words(RELATIVE_DAY_WORDS),
  // Clock words: a time the note would state itself ("by noon").
  words(["noon", "midday", "midnight", "eod"]),
];
const NUMBER_WORD_RE = words(NUMBER_WORDS);
const MARKUP_RE = /[<>*_`#[\]|~@{}]|http|www|\p{Extended_Pictographic}/iu;
const NAME_OK = new Set(["I", "JARVIS", "MESA"]);
const STATUS_RE = words(["already", "submitted", "completed", "finished", "cancelled", "canceled", "postponed", "rescheduled", "extended", "moved"]);

const stripFences = (raw: string) => raw.trim().replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "");

/** A capitalised word that doesn't start a sentence (or follow ":") and isn't I / JARVIS / MESA. */
function strayName(t: string): boolean {
  let start = true;
  let last = 0;
  for (const m of t.matchAll(/\{[^{}]*\}|[A-Za-z][A-Za-z'’-]*/g)) {
    if (/[.!?:]/.test(t.slice(last, m.index))) start = true;
    last = m.index! + m[0].length;
    if (m[0].startsWith("{")) {
      start = false;
      continue;
    }
    const w = m[0].split(/['’]/)[0]!;
    if (/^[A-Z]/.test(w) && !start && !NAME_OK.has(w)) return true;
    start = false;
  }
  return false;
}

/**
 * Checks the model's reply, rules in order (the first failure names the rule): json, length (20–320 before
 * substitution), sentences (1–3), placeholders (all known, at least one), digits, date_word, number_word,
 * markup, name, status_claim.
 */
export function validateFocusNote(raw: string, tokens: Record<string, NoteToken>): { ok: true; template: string } | { ok: false; rule: string } {
  const fail = (rule: string) => ({ ok: false as const, rule });
  let note: unknown;
  try {
    note = (JSON.parse(stripFences(raw)) as { note?: unknown } | null)?.note;
  } catch {
    return fail("json");
  }
  if (typeof note !== "string") return fail("json");
  const t = note.trim();
  if (t.length < 20 || t.length > 320) return fail("length");
  const sentences = t.split(/[.!?]+(?=\s|$)/).filter((x) => x.trim());
  if (sentences.length < 1 || sentences.length > 3) return fail("sentences");

  const used = [...t.matchAll(PLACEHOLDER_RE)];
  if (!used.length) return fail("placeholders");
  for (const m of used) {
    const k = KEY_RE.exec(m[1]!);
    const tok = k ? tokens[k[1]!] : undefined;
    if (!k || !tok || (k[2] && !Object.hasOwn(tok.fields, k[2]))) return fail("placeholders");
  }

  const bare = t.replace(PLACEHOLDER_RE, " ");
  if (/\p{N}/u.test(bare)) return fail("digits"); // any numeral: "5", "５", "५", "½", "²"
  if (DATE_WORD_RES.some((re) => re.test(bare))) return fail("date_word");
  if (NUMBER_WORD_RE.test(bare)) return fail("number_word");
  if (MARKUP_RE.test(bare)) return fail("markup");
  if (strayName(t)) return fail("name");
  if (STATUS_RE.test(bare)) return fail("status_claim");
  return { ok: true, template: t };
}

const cut = (s: string) => (s.length > TITLE_MAX ? `${s.slice(0, TITLE_MAX - 1).trimEnd()}…` : s);

/** Fills the placeholders: titles become “title” (cut to 60), fields their value. Plain text; refs of every token used. */
export function substituteNote(template: string, tokens: Record<string, NoteToken>): { text: string; refs: FactRef[] } {
  const refs = new Map<string, FactRef>();
  const text = template.replace(PLACEHOLDER_RE, (_, inner: string) => {
    const k = KEY_RE.exec(inner);
    const tok = k ? tokens[k[1]!] : undefined;
    if (!k || !tok) return "";
    for (const r of tok.refs) refs.set(refKey(r), r);
    if (k[2]) return tok.fields[k[2]] ?? "";
    return tok.plain ? tok.value : `“${cut(tok.value)}”`;
  });
  return { text: text.replace(/\s+/g, " ").trim(), refs: [...refs.values()] };
}

// ── fallback ──────────────────────────────────────────────────────────────────

const RISK_PHRASE: Record<RiskItem["kind"], string> = {
  overdue: "it is overdue",
  soon: "it is due soon and not started",
  goal: "it is behind pace",
  neglect: "nothing logged lately",
  habit: "it has slipped",
  effort: "it won't fit today's free time",
  session: "LMS data may be out of date",
  stale: "LMS data may be out of date",
};

/** The deterministic note as a placeholder template (always passes the validator's shape rules). */
export function fallbackTemplate(f: BriefFacts, s: BriefSections, tokens: Record<string, NoteToken> = noteFacts(f, s)): string {
  const out: string[] = [];
  const p1 = s.priorities[0];
  if (p1 && tokens.P1) out.push(p1.bucket === "overdue" ? "Start with {P1} — it's overdue." : tokens.P1.fields.due ? "Start with {P1} — due {P1.due}." : "Start with {P1}.");
  else if (tokens.Q1) out.push("Start with {Q1}.");
  else if (tokens.H1) out.push("A light day — make room for {H1}.");
  else out.push("Nothing urgent today — a good day to get ahead on your upcoming work.");

  const r1 = s.risks[0];
  const p1Rows = new Set((tokens.P1?.refs ?? []).map(refKey));
  if (r1 && tokens.R1 && !r1.refs.some((r) => p1Rows.has(refKey(r)))) out.push(`Keep an eye on {R1}: ${RISK_PHRASE[r1.kind]}.`);
  else if (tokens.P2) out.push("Then {P2}.");

  if (f.freeTime.freeMin >= 60 && tokens.FREE) out.push("You have about {FREE}.");
  return out.join(" ");
}

/** The note without the model: deterministic, always valid, numbers allowed (they are computed). */
export function fallbackFocusNote(f: BriefFacts, s: BriefSections): { text: string; refs: FactRef[] } {
  const tokens = noteFacts(f, s);
  return substituteNote(fallbackTemplate(f, s, tokens), tokens);
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out after ${ms} ms`)), ms);
  });
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
}

/**
 * Today's focus note: one model call (JSON, no tools, 20 s), validated and substituted; otherwise the
 * fallback, with `detail` saying why — `no_model`, `no_facts`, `error:<message>` or `invalid:<rule>`.
 * Never throws.
 */
export async function focusNote(
  model: ModelProvider | null,
  f: BriefFacts,
  s: BriefSections,
  o: { timeoutMs?: number } = {},
): Promise<{ text: string; refs: FactRef[]; source: "ai" | "fallback"; detail: string | null }> {
  const errorText = (err: unknown) => `error:${(err instanceof Error ? err.message : String(err)).slice(0, 80)}`;
  try {
    const tokens = noteFacts(f, s);
    const fallback = (detail: string) => ({ ...substituteNote(fallbackTemplate(f, s, tokens), tokens), source: "fallback" as const, detail });
    if (!model) return fallback("no_model");
    if (!Object.keys(tokens).length) return fallback("no_facts"); // nothing the model could refer to
    let raw: string;
    try {
      const reply = await withTimeout(
        model.generate({ system: FOCUS_NOTE_SYSTEM, messages: [userText(JSON.stringify({ FACTS: modelFacts(tokens) }))], tools: [], toolChoice: "none", json: true, temperature: 0.2, task: "brief_note" }),
        o.timeoutMs ?? NOTE_TIMEOUT_MS,
      );
      raw = textOf(reply);
    } catch (err) {
      return fallback(errorText(err));
    }
    const v = validateFocusNote(raw, tokens);
    if (!v.ok) return fallback(`invalid:${v.rule}`);
    return { ...substituteNote(v.template, tokens), source: "ai", detail: null };
  } catch (err) {
    // Only a bug in the facts above gets here; the brief still goes out, without a note.
    return { text: "", refs: [], source: "fallback", detail: errorText(err) };
  }
}
