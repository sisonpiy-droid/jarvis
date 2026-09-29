import { ChatBox } from "./chat-box";

export default function ChatPage() {
  return (
    <main>
      <h1 className="text-2xl font-semibold tracking-tight">Chat with JARVIS</h1>
      <p className="mt-1 text-sm text-[var(--color-muted)]">Same JARVIS as on Telegram, using your live LMS data. Web conversations are kept separately.</p>
      <ChatBox />
    </main>
  );
}
