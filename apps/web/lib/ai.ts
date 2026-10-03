import "server-only";
import { GeminiProvider } from "@jarvis/ai";

/** The model for one-off calls (voice, shared images); null when no AI key is configured. */
export function aiModel(timeoutMs = 60_000): GeminiProvider | null {
  const key = process.env.GEMINI_API_KEY;
  return key ? new GeminiProvider(key, process.env.GEMINI_MODEL ?? "gemini-3.6-flash", fetch, timeoutMs) : null;
}
