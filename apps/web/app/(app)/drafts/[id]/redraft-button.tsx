"use client";

import { useState } from "react";

export function RedraftButton({ assignmentId }: { assignmentId: string }) {
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
      className="rounded-lg border border-[var(--color-line)] px-3 py-1.5 disabled:opacity-60"
    >
      {state === "started" ? "Re-drafting — check Drafts in ~2 min" : state === "busy" ? "Starting…" : state === "error" ? "Failed — try again" : "↻ Re-draft"}
    </button>
  );
}
