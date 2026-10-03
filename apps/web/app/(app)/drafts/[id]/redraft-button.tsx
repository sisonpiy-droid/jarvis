"use client";

import { useState } from "react";

/** Tell JARVIS what to change (saved for this assignment), or redo it as-is. */
export function ReviseBox({ assignmentId, placeholder = "e.g. Our startup is Snitch · Use 2 cities, not 5 · Make the recommendation sharper" }: { assignmentId: string; placeholder?: string }) {
  const [text, setText] = useState("");
  const [state, setState] = useState<"idle" | "busy" | "started" | "error">("idle");
  const send = async (instruction: string) => {
    setState("busy");
    const r = await fetch("/api/draft", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ assignmentId, instruction }) });
    setState(r.ok ? "started" : "error");
    if (r.ok) setText("");
  };
  return (
    <form
      className="card mt-4 p-4"
      onSubmit={(e) => {
        e.preventDefault();
        if (text.trim()) void send(text.trim());
      }}
    >
      <label className="text-sm font-medium" htmlFor={`revise-${assignmentId}`}>
        ✏️ Tell JARVIS what to change
      </label>
      <textarea
        id={`revise-${assignmentId}`}
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder={placeholder}
        rows={2}
        maxLength={4000}
        className="mt-2 w-full rounded-lg border border-[var(--color-line)] bg-transparent px-3 py-2 text-sm outline-none focus:border-[var(--color-accent)]"
      />
      <div className="mt-2 flex flex-wrap items-center gap-3 text-sm">
        <button disabled={!text.trim() || state === "busy"} className="rounded-lg bg-[var(--color-accent)] px-3 py-1.5 font-medium text-white disabled:opacity-50">
          Revise
        </button>
        <button type="button" disabled={state === "busy"} onClick={() => void send("")} className="rounded-lg border border-[var(--color-line)] px-3 py-1.5 disabled:opacity-50">
          ↻ Redo as-is
        </button>
        <span className="text-[var(--color-muted)]">
          {state === "started" ? "On it — you’ll get a notification and the revised files appear here in ~2 min." : state === "error" ? "Failed — try again." : "Saved for this assignment; every future draft follows it."}
        </span>
      </div>
    </form>
  );
}

export { ReviseBox as RedraftButton };
