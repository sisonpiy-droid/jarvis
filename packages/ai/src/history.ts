import type { Sql, Tx } from "@jarvis/db";
import { fromGeminiContent, type GeminiPart } from "./gemini";
import { SYNTHETIC_ID_PREFIX, isNeutralParts, textOf, toolCallsOf, type Message, type Part, type ProviderMeta, type Role } from "./model";

// Chat history in jarvis.chat_messages, read and written as neutral Messages.
// Rows written since migration 0019 are format 'neutral' (parts are our Part
// objects); older rows keep Gemini's shape (format 'gemini') and are converted
// when read, never rewritten. A 'marker' row records "New conversation": the
// model's context starts after the latest one, while the transcript keeps
// everything and shows the marker as a divider.

export interface StoredRow {
  id: number;
  role: "user" | "model" | "tool" | "marker";
  parts: unknown;
  format: "gemini" | "neutral";
  meta: unknown;
  created_at: string;
}

const PART_TYPES = new Set<string>(["text", "thinking", "tool_call", "tool_result", "file"]);
const HISTORY_ROWS = 24;
/** Tool results older than the newest exchange are cut to this many JSON characters in the model's context. */
const OLD_RESULT_CHARS = 4_000;

const roleOf = (r: StoredRow["role"]): Role => (r === "model" ? "assistant" : r === "tool" ? "tool" : "user");

/**
 * Stored rows → Messages (marker rows produce nothing). Gemini rows go through fromGeminiContent with the row id
 * as the seed; a stored functionResponse has no id, so each one takes the first unused call of the same name in
 * the assistant message just before it (first in, first out), or an id that matches nothing.
 */
export function fromStoredRows(rows: StoredRow[]): Array<{ rowId: number; msg: Message }> {
  const out: Array<{ rowId: number; msg: Message }> = [];
  for (const row of rows) {
    if (row.role === "marker") continue;
    const raw = Array.isArray(row.parts) ? (row.parts as unknown[]) : [];
    const role = roleOf(row.role);
    if (row.format === "neutral" && isNeutralParts(raw)) {
      out.push({ rowId: row.id, msg: { role, parts: (raw as Part[]).filter((p) => PART_TYPES.has(p.type)) } });
      continue;
    }
    let parts = fromGeminiContent({ role: row.role === "model" ? "model" : "user", parts: raw as GeminiPart[] }, row.id).parts;
    if (role === "tool") {
      const prev = out[out.length - 1]?.msg;
      const pending = prev?.role === "assistant" ? toolCallsOf(prev) : [];
      const used = new Set(parts.flatMap((p) => (p.type === "tool_result" && p.id ? [p.id] : [])));
      parts = parts.map((p, i) => {
        if (p.type !== "tool_result" || p.id) return p;
        const call = pending.find((c) => c.name === p.name && !used.has(c.id));
        const id = call?.id ?? `${SYNTHETIC_ID_PREFIX}${row.id}-o${i}`;
        used.add(id);
        return { ...p, id };
      });
    }
    out.push({ rowId: row.id, msg: { role, parts } });
  }
  return out;
}

/**
 * Makes history safe to send: starts at a real user message (never mid tool-exchange), drops any assistant turn
 * whose tool calls aren't answered one-for-one by the next tool message (and those orphaned results), and cuts
 * large tool results before the newest exchange.
 */
export function sanitizeHistory(msgs: Message[]): Message[] {
  const isUserText = (m: Message) => m.role === "user" && m.parts.some((p) => p.type === "text");
  const start = msgs.findIndex(isUserText);
  if (start < 0) return [];
  const list = msgs.slice(start);
  const kept: Message[] = [];
  for (let i = 0; i < list.length; i++) {
    const m = list[i]!;
    if (m.role === "tool") continue; // its call was dropped or never stored
    const calls = m.role === "assistant" ? toolCallsOf(m) : [];
    if (!calls.length) {
      kept.push(m);
      continue;
    }
    const next = list[i + 1];
    if (next?.role === "tool") {
      i++;
      const ids = next.parts.flatMap((p) => (p.type === "tool_result" ? [p.id] : []));
      if (ids.length === calls.length && calls.every((c) => ids.includes(c.id))) kept.push(m, next);
    }
  }
  let newest = -1;
  kept.forEach((m, i) => {
    if (isUserText(m)) newest = i;
  });
  return kept.map((m, i) => (i >= newest || m.role !== "tool" ? m : { ...m, parts: m.parts.map(truncateResult) }));
}

function truncateResult(p: Part): Part {
  if (p.type !== "tool_result" || p.error !== undefined) return p;
  const json = JSON.stringify(p.result ?? null);
  return json.length > OLD_RESULT_CHARS ? { ...p, result: { truncated: true, partial: json.slice(0, OLD_RESULT_CHARS) } } : p;
}

const toStored = (r: Record<string, unknown>): StoredRow => ({
  id: Number(r.id),
  role: r.role as StoredRow["role"],
  parts: r.parts,
  format: r.format === "neutral" ? "neutral" : "gemini",
  meta: r.meta ?? null,
  created_at: new Date(r.created_at as string).toISOString(),
});

/** The rows the model's context is built from: the last 24 after the channel's latest marker, oldest first. */
async function contextRows(sql: Sql, channel: string): Promise<StoredRow[]> {
  const rows = await sql`
    select id, role, parts, format, meta, created_at from (
      select id, role, parts, format, meta, created_at from jarvis.chat_messages
       where channel = ${channel}
         and id > coalesce((select max(id) from jarvis.chat_messages where channel = ${channel} and role = 'marker'), 0)
       order by id desc limit ${HISTORY_ROWS}) t
     order by id`;
  return rows.map(toStored);
}

/** Recent conversation on this channel, as Messages ready to send to the model. */
export async function loadHistory(sql: Sql, channel: string): Promise<Message[]> {
  return sanitizeHistory(fromStoredRows(await contextRows(sql, channel)).map((x) => x.msg));
}

const hasMeta = (m: ProviderMeta | undefined) => !!m && Object.values(m).some((v) => v && Object.keys(v).length);
const STORED_ROLE: Record<Role, StoredRow["role"]> = { user: "user", assistant: "model", tool: "tool" };

/** A channel's rows are written one transaction at a time, so two turns (or a turn and a reset) never interleave. */
const lockChannel = (tx: Tx, channel: string) =>
  tx`select pg_advisory_xact_lock(hashtext(${`chat:${channel}`}))`;

/**
 * Appends a turn's messages as neutral rows, atomically: all of them or none. Empty thinking parts with no
 * signature are not worth a row's bytes (a message left with no parts is skipped). `finalMeta` (e.g. the
 * grounding guard's verdict) goes on the last assistant row. Returns the inserted ids in order.
 */
export async function saveTurns(sql: Sql, channel: string, msgs: Message[], finalMeta?: Record<string, unknown>): Promise<number[]> {
  const rows = msgs
    .map((m) => ({ role: m.role, parts: m.parts.filter((p) => !(p.type === "thinking" && !p.text && !hasMeta(p.meta))) }))
    .filter((m) => m.parts.length);
  if (!rows.length) return [];
  const metaAt = finalMeta ? rows.map((m) => m.role).lastIndexOf("assistant") : -1;
  return sql.begin(async (tx) => {
    await lockChannel(tx, channel);
    const ids: number[] = [];
    for (const [i, m] of rows.entries()) {
      const meta = i === metaAt ? tx.json(finalMeta as never) : null;
      const [row] = await tx`
        insert into jarvis.chat_messages (channel, role, parts, format, meta)
        values (${channel}, ${STORED_ROLE[m.role]}, ${tx.json(m.parts as never)}, 'neutral', ${meta})
        returning id`;
      ids.push(Number(row!.id));
    }
    return ids;
  });
}

/**
 * "New conversation": the model's context restarts after this marker; the transcript keeps the earlier
 * messages. Pressing it twice in a row adds no second marker.
 */
export async function resetConversation(sql: Sql, channel: string): Promise<void> {
  await sql.begin(async (tx) => {
    await lockChannel(tx, channel);
    await tx`
      insert into jarvis.chat_messages (channel, role, parts, format)
      select ${channel}, 'marker', '[]'::jsonb, 'neutral'
       where coalesce((select role from jarvis.chat_messages where channel = ${channel} order by id desc limit 1), '') <> 'marker'`;
  });
}

/** One bubble (or divider) on the chat page. A JARVIS item is the final answer of an exchange. */
export interface TranscriptItem {
  id: number;
  role: "user" | "jarvis" | "marker";
  text: string;
  at: string;
  /** Unique names of the tools called for this answer (since the previous user message), in call order. */
  tools: string[];
  /** The grounding guard fired on this answer (its row has meta.guard). */
  guarded: boolean;
}

const TRANSCRIPT_LIMIT = 40;
const isUserTextRow = (r: StoredRow, msg: Message | undefined) => r.role === "user" && msg?.role === "user" && !!textOf(msg);

/**
 * The conversation as the owner sees it, one page at a time (oldest first); `before` is a previous page's
 * `nextBefore`. Reads up to 3 × limit rows. Tool rows, thinking and tool-call-only turns are not shown, and a
 * page always starts at a user message or marker, never mid-exchange. `contextStartId` is the first row the
 * model's context currently includes (null when it is empty, e.g. right after "New conversation").
 */
export async function chatTranscript(
  sql: Sql,
  channel: string,
  o: { before?: number; limit?: number } = {},
): Promise<{ items: TranscriptItem[]; nextBefore: number | null; contextStartId: number | null }> {
  const limit = Math.max(1, Math.min(Math.trunc(o.limit ?? TRANSCRIPT_LIMIT), 200));
  const fetch = 3 * limit;
  const before = o.before !== undefined && Number.isFinite(o.before) ? Math.trunc(o.before) : null;
  const [raw, ctx] = await Promise.all([
    sql`
      select id, role, parts, format, meta, created_at from jarvis.chat_messages
       where channel = ${channel} ${before !== null ? sql`and id < ${before}` : sql``}
       order by id desc limit ${fetch + 1}`,
    contextRows(sql, channel),
  ]);
  const more = raw.length > fetch;
  const fetched = raw.slice(0, fetch).map(toStored).reverse();
  const msgOf = new Map(fromStoredRows(fetched).map((x) => [x.rowId, x.msg]));
  // When older rows exist, the first rows may be the tail of an exchange whose question is on the previous page.
  const start = more ? fetched.findIndex((r) => r.role === "marker" || isUserTextRow(r, msgOf.get(r.id))) : 0;
  const rows = start < 0 ? [] : fetched.slice(start);

  const items: TranscriptItem[] = [];
  let tools: string[] = [];
  let answer: { row: StoredRow; text: string } | null = null;
  const flush = () => {
    if (answer) {
      const guard = (answer.row.meta as { guard?: unknown } | null)?.guard;
      items.push({ id: answer.row.id, role: "jarvis", text: answer.text, at: answer.row.created_at, tools, guarded: guard !== undefined && guard !== null });
    }
    answer = null;
    tools = [];
  };
  for (const r of rows) {
    const msg = msgOf.get(r.id);
    if (r.role === "marker") {
      flush();
      items.push({ id: r.id, role: "marker", text: "", at: r.created_at, tools: [], guarded: false });
    } else if (isUserTextRow(r, msg)) {
      flush();
      items.push({ id: r.id, role: "user", text: textOf(msg!), at: r.created_at, tools: [], guarded: false });
    } else if (msg?.role === "assistant") {
      for (const c of toolCallsOf(msg)) if (!tools.includes(c.name)) tools.push(c.name);
      const text = textOf(msg);
      if (text) answer = { row: r, text };
    }
  }
  flush();

  // Too many items: start the page at the first user message or marker that keeps it within the limit.
  let cut = Math.max(0, items.length - limit);
  if (cut > 0) {
    const boundary = items.findIndex((it, i) => i >= cut && it.role !== "jarvis");
    if (boundary >= 0) cut = boundary;
  }
  const page = items.slice(cut);
  // Everything below the page's first row is older; with no visible row at all, skip past what was read.
  const nextBefore = cut > 0 || more ? (page[0]?.id ?? fetched[0]?.id ?? null) : null;

  const firstInContext = fromStoredRows(ctx).find((x) => x.msg.role === "user" && x.msg.parts.some((p) => p.type === "text"));
  return { items: page, nextBefore, contextStartId: firstInContext?.rowId ?? null };
}
