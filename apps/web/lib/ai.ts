import "server-only";
import { GeminiProvider, meterTo } from "@jarvis/ai";
import type { Sql } from "@jarvis/db";
import { db } from "@/lib/db";

/** The model for one-off calls (voice, shared images); null when no AI key is configured. */
export function aiModel(timeoutMs = 60_000): GeminiProvider | null {
  const key = process.env.GEMINI_API_KEY;
  return key ? new GeminiProvider(key, process.env.GEMINI_MODEL ?? "gemini-3.6-flash", fetch, timeoutMs, meterTo(db() as unknown as Sql)) : null;
}
