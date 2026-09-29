"use client";

import { useState } from "react";

export function DraftButton({ assignmentId }: { assignmentId: string }) {
  const [state, setState] = useState<"idle" | "busy" | "started" | "error">("idle");
  return (
    <button
      type="button"
      disabled={state === "busy" || state === "started"}
      onClick={async () => {
        setState("busy");
        const r = await fetch("/api/draft", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ assignmentId }) });
        setState(r.ok ? "started" : "error");
      }}
      className="rounded-lg bg-[var(--color-accent)] px-3 py-1.5 text-sm font-medium text-white disabled:opacity-60"
    >
      {state === "started" ? "Drafting — it'll arrive on Telegram and here in ~1–3 min" : state === "busy" ? "Starting…" : state === "error" ? "Failed — try again" : "✍️ Draft with JARVIS"}
    </button>
  );
}
