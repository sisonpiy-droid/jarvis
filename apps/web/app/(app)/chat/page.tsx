import { chatTranscript } from "@jarvis/ai";
import { sql } from "@/lib/passkey";
import { toChatView, type ChatView } from "@/lib/chat";
import { ChatBox } from "./chat-box";

// The web conversation, read back from chat_messages (channel 'web'; Telegram history is never shown here).
// Paging is a plain server link (?before=<id>); the chat box only appends what is said on this page.

export default async function ChatPage({ searchParams }: { searchParams: Promise<{ before?: string }> }) {
  const { before } = await searchParams;
  // Only a real row id pages back (a junk or out-of-range ?before= shows the latest messages).
  const beforeId = Number.isSafeInteger(Number(before)) && Number(before) > 0 ? Number(before) : undefined;
  let initial: ChatView[] = [];
  let nextBefore: number | null = null;
  let contextStartId: number | null = null;
  let loadError = false;
  try {
    const t = await chatTranscript(sql(), "web", { before: beforeId, limit: 40 });
    initial = toChatView(t.items);
    nextBefore = t.nextBefore;
    contextStartId = t.contextStartId;
  } catch {
    loadError = true;
  }
  return (
    <main>
      <h1 className="sr-only md:not-sr-only md:text-2xl md:font-semibold md:tracking-tight">Chat with JARVIS</h1>
      <p className="text-sm text-[var(--color-muted)] md:mt-1">Ask about your priorities, goals, tasks, deadlines and classes. Answers come from your JARVIS data.</p>
      <ChatBox
        // A new page (earlier messages, or back to latest) starts the chat box afresh.
        key={beforeId ?? "latest"}
        initial={initial}
        nextBefore={nextBefore}
        contextStartId={contextStartId}
        olderPage={beforeId !== undefined}
        loadError={loadError}
      />
    </main>
  );
}
