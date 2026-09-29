"use client";

import { useEffect, useRef, useState } from "react";

type Msg = { role: "user" | "jarvis"; html: string };

const SUGGESTIONS = ["What's due this week?", "What do I have tomorrow?", "Find the Business Frameworks slides", "What changed on the LMS today?"];
const escape = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export function ChatBox() {
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => {
    // Block body on purpose: newer browsers return a Promise from scrollIntoView, which React must not receive.
    end.current?.scrollIntoView({ behavior: "smooth" });
  }, [msgs, busy]);

  async function send(text: string) {
    const t = text.trim();
    if (!t || busy) return;
    setMsgs((m) => [...m, { role: "user", html: escape(t) }]);
    setInput("");
    setBusy(true);
    try {
      const r = await fetch("/api/chat", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ message: t }) });
      const j = (await r.json()) as { html?: string; error?: string };
      // Server returns HTML produced by an escape-first converter (only b/i/a/code/pre are re-introduced).
      setMsgs((m) => [...m, { role: "jarvis", html: j.html ?? `⚠️ ${escape(j.error ?? "Something went wrong")}` }]);
    } catch {
      setMsgs((m) => [...m, { role: "jarvis", html: "⚠️ Network error — try again." }]);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card mt-4 flex h-[70vh] min-h-[420px] flex-col">
      <div className="flex-1 space-y-3 overflow-y-auto p-4">
        {msgs.length === 0 && (
          <div className="flex flex-wrap gap-2">
            {SUGGESTIONS.map((s) => (
              <button key={s} onClick={() => send(s)} className="rounded-full border border-[var(--color-line)] px-3 py-1.5 text-sm hover:bg-[var(--color-line)]">
                {s}
              </button>
            ))}
          </div>
        )}
        {msgs.map((m, i) => (
          <div key={i} className={m.role === "user" ? "flex justify-end" : "flex"}>
            <div
              className={`prose-chat max-w-[85%] whitespace-pre-wrap rounded-2xl px-3.5 py-2 text-sm leading-relaxed ${
                m.role === "user" ? "bg-[var(--color-accent)] text-white" : "bg-[var(--color-line)]"
              }`}
              dangerouslySetInnerHTML={{ __html: m.html }}
            />
          </div>
        ))}
        {busy && <p className="text-sm text-[var(--color-muted)]">JARVIS is thinking…</p>}
        <div ref={end} />
      </div>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void send(input);
        }}
        className="flex gap-2 border-t border-[var(--color-line)] p-3"
      >
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Ask JARVIS…"
          className="min-w-0 flex-1 rounded-lg border border-[var(--color-line)] bg-transparent px-3 py-2 text-sm outline-none focus:border-[var(--color-accent)]"
          maxLength={4000}
        />
        <button disabled={busy || !input.trim()} className="rounded-lg bg-[var(--color-accent)] px-4 py-2 text-sm font-medium text-white disabled:opacity-50">
          Send
        </button>
      </form>
    </div>
  );
}
