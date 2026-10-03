import { ShareInbox } from "./share-inbox";

// Where the phone's Share menu lands (Android), and a capture page anywhere: text, a link or files → ask JARVIS
// about it, or keep it as a task.
export default async function SharePage({ searchParams }: { searchParams: Promise<{ failed?: string }> }) {
  const { failed } = await searchParams;
  return (
    <main>
      <h1 className="text-2xl font-semibold tracking-tight">Share to JARVIS</h1>
      <p className="mt-1 text-sm text-[var(--color-muted)]">Ask JARVIS about something, or keep it as a task. On Android, pick JARVIS in any app&apos;s Share menu.</p>
      <ShareInbox failed={failed === "1"} />
    </main>
  );
}
