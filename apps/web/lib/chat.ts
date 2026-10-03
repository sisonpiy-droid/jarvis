import { markdownToChatHtml, type TranscriptItem } from "@jarvis/ai";
import { escapeHtml } from "@jarvis/notify";
import { dayLabel, sourceLabels, timeLabel, type ChatView } from "./chat-view";

// Server side of the chat page: the stored web transcript (chatTranscript) turned into bubbles. User text is
// escaped; JARVIS text goes through the same escape-first Markdown converter the live replies use.

export * from "./chat-view";

export function toChatView(items: TranscriptItem[], now = new Date()): ChatView[] {
  return items.map((t) => ({
    id: t.id,
    role: t.role,
    html: t.role === "jarvis" ? markdownToChatHtml(t.text) : t.role === "user" ? escapeHtml(t.text) : "",
    at: t.at,
    timeLabel: timeLabel(t.at),
    dayLabel: dayLabel(t.at, now),
    sources: t.role === "jarvis" ? sourceLabels(t.tools) : [],
    guarded: t.role === "jarvis" && t.guarded,
  }));
}
