"use client";

import Link from "next/link";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { CHAT_STARTERS, chatCaption, contextDividerIndex, dayLabel, escapeChatText, groupByDay, sourceLabels, timeLabel, type ChatView } from "@/lib/chat-view";

// The web conversation: the stored transcript (rendered on the server) plus whatever is said on this page.
// Replies arrive as HTML from the server's escape-first converter (only b/i/a/code/pre are re-introduced).

type Reply = { html?: string; sources?: string[]; at?: string; repaired?: boolean; guarded?: boolean; error?: string };

function Divider({ children }: { children: React.ReactNode }) {
  return (
    <div role="separator" className="flex items-center gap-3 py-1 text-xs text-[var(--color-muted)]">
      <span className="h-px flex-1 bg-[var(--color-line)]" />
      <span className="max-w-[80%] text-center">{children}</span>
      <span className="h-px flex-1 bg-[var(--color-line)]" />
    </div>
  );
}

const bubble = "max-w-[85%] break-words rounded-2xl px-3.5 py-2 text-[15px] leading-relaxed whitespace-pre-wrap [overflow-wrap:anywhere]";

export function ChatBox({
  initial,
  nextBefore,
  contextStartId,
  olderPage,
  loadError,
}: {
  initial: ChatView[];
  nextBefore: number | null;
  contextStartId: number | null;
  /** Showing a ?before= page: read-only, with a way back to the latest messages. */
  olderPage: boolean;
  loadError: boolean;
}) {
  const [items, setItems] = useState(initial);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState<{ text: string; message: string } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const box = useRef<HTMLTextAreaElement>(null);
  const menu = useRef<HTMLDetailsElement>(null);
  const tempId = useRef(0);
  const view = (v: Omit<ChatView, "id" | "timeLabel" | "dayLabel">): ChatView => ({ ...v, id: -++tempId.current, timeLabel: timeLabel(v.at), dayLabel: dayLabel(v.at, new Date()) });

  // Open at the newest message, without an animated scroll through the history.
  useLayoutEffect(() => {
    if (scroller.current) scroller.current.scrollTop = scroller.current.scrollHeight;
  }, []);
  const count = items.length;
  useEffect(() => {
    // Scroll the transcript only. scrollIntoView would also scroll the page, pushing the composer below the
    // phone's tab bar.
    const el = scroller.current;
    if (el && (count || busy)) el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
  }, [count, busy, failed]);
  // The composer grows with its text, up to 5 lines (max-h on the textarea), then scrolls.
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight + el.offsetHeight - el.clientHeight}px`;
  }, [input]);

  async function ask(text: string) {
    setBusy(true);
    setFailed(null);
    try {
      const r = await fetch("/api/chat", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ message: text }) });
      const j = (await r.json().catch(() => ({}))) as Reply;
      if (r.ok && typeof j.html === "string") {
        const html = j.html;
        setItems((m) => [...m, view({ role: "jarvis", html, at: j.at ?? new Date().toISOString(), sources: sourceLabels(j.sources ?? []), guarded: !!(j.guarded || j.repaired) })]);
      } else setFailed({ text, message: j.error ?? "Something went wrong" });
    } catch {
      setFailed({ text, message: "Network error" });
    } finally {
      setBusy(false);
    }
  }

  function send(raw: string) {
    const text = raw.trim();
    if (!text || busy) return;
    setItems((m) => [...m, view({ role: "user", html: escapeChatText(text), at: new Date().toISOString(), sources: [], guarded: false })]);
    setInput("");
    void ask(text);
  }

  async function newConversation() {
    if (menu.current) menu.current.open = false;
    setNotice(null);
    try {
      const r = await fetch("/api/chat", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "reset" }) });
      const j = (await r.json().catch(() => ({}))) as { ok?: boolean; at?: string; error?: string };
      if (!r.ok || !j.ok) throw new Error(j.error);
      setFailed(null);
      // The server adds no second marker in a row; neither does the page.
      setItems((m) => (m[m.length - 1]?.role === "marker" ? m : [...m, view({ role: "marker", html: "", at: j.at ?? new Date().toISOString(), sources: [], guarded: false })]));
    } catch {
      setNotice("Couldn't start a new conversation. Try again.");
    }
  }

  const dividerAt = contextDividerIndex(items, contextStartId);
  const dividerId = dividerAt >= 0 ? items[dividerAt]!.id : null;
  const fresh = !olderPage && !busy && (items.length === 0 || items[items.length - 1]!.role === "marker");

  return (
    <div className="card mt-3 flex h-[calc(100dvh_-_16rem)] min-h-[22rem] flex-col md:mt-4 md:h-[calc(100dvh_-_11rem)]">
      <div className="flex items-center justify-between gap-3 border-b border-[var(--color-line)] px-3 py-1">
        <span className="text-xs text-[var(--color-muted)]">{olderPage ? "Earlier messages" : "Conversation"}</span>
        {!olderPage && (
          <details ref={menu} className="relative">
            <summary aria-label="Conversation options" className="inline-flex min-h-11 min-w-11 cursor-pointer list-none items-center justify-center text-lg leading-none text-[var(--color-muted)] [&::-webkit-details-marker]:hidden">
              ⋯
            </summary>
            <div className="card absolute top-full right-0 z-20 w-56 p-1 shadow-lg">
              {/* Not while a reply is pending: that turn would be stored after the marker, though it was asked before it. */}
              <button type="button" disabled={busy} onClick={() => void newConversation()} className="min-h-11 w-full rounded-lg px-3 text-left text-sm hover:bg-[var(--color-line)] disabled:opacity-50">
                New conversation
              </button>
              <p className="px-3 pb-2 text-xs text-[var(--color-muted)]">JARVIS starts fresh; these messages stay here.</p>
            </div>
          </details>
        )}
      </div>

      <div ref={scroller} role="log" aria-live="polite" aria-busy={busy} className="flex-1 overflow-y-auto overscroll-contain px-3 pb-3 sm:px-4">
        {nextBefore != null && (
          <p className="pt-3 text-center">
            <Link href={`/chat?before=${nextBefore}`} className="inline-flex min-h-11 items-center text-sm no-underline">
              Show earlier messages
            </Link>
          </p>
        )}
        {loadError && <p className="pt-3 text-center text-sm text-[var(--color-bad)]">Couldn&apos;t load earlier messages.</p>}
        {notice && <p className="pt-3 text-center text-sm text-[var(--color-bad)]">{notice}</p>}

        {groupByDay(items).map((g) => (
          <section key={`${g.day}:${g.items[0]!.id}`} aria-label={g.day}>
            <div className="sticky top-0 z-10 flex justify-center pt-2 pb-1">
              <span className="rounded-full border border-[var(--color-line)] bg-[var(--color-panel)] px-2.5 py-0.5 text-[11px] font-medium text-[var(--color-muted)]">{g.day}</span>
            </div>
            <div className="space-y-3">
              {g.items.map((m) => (
                <div key={m.id}>
                  {m.id === dividerId && <Divider>Earlier messages aren&apos;t in JARVIS&apos;s short-term context</Divider>}
                  {m.role === "marker" ? (
                    <Divider>New conversation · {m.timeLabel}</Divider>
                  ) : m.role === "user" ? (
                    <div className="flex justify-end">
                      <div className={`${bubble} bg-[var(--color-accent)] text-white`} dangerouslySetInnerHTML={{ __html: m.html }} />
                    </div>
                  ) : (
                    <div className="flex flex-col items-start">
                      <div className={`${bubble} prose-chat bg-[var(--color-line)]`} dangerouslySetInnerHTML={{ __html: m.html }} />
                      <p className="mt-1 max-w-[85%] px-1 text-xs text-[var(--color-muted)]">{chatCaption(m)}</p>
                    </div>
                  )}
                </div>
              ))}
            </div>
          </section>
        ))}

        {fresh && (
          <div className="mt-4 flex flex-wrap gap-2">
            {CHAT_STARTERS.map((s) => (
              <button key={s} type="button" onClick={() => send(s)} className="min-h-11 rounded-full border border-[var(--color-line)] px-3.5 text-sm hover:bg-[var(--color-line)]">
                {s}
              </button>
            ))}
          </div>
        )}
        {busy && (
          <div className="mt-3 flex">
            <div className={`${bubble} bg-[var(--color-line)] text-[var(--color-muted)]`}>Checking your data…</div>
          </div>
        )}
        {failed && !busy && (
          <div className="mt-3 flex flex-col items-start gap-2">
            <div className={`${bubble} bg-[color-mix(in_srgb,var(--color-bad)_12%,transparent)] text-[var(--color-bad)]`}>⚠️ {failed.message}</div>
            <button type="button" onClick={() => void ask(failed.text)} className="min-h-11 rounded-full border border-[var(--color-line)] px-3.5 text-sm hover:bg-[var(--color-line)]">
              Retry
            </button>
          </div>
        )}
      </div>

      {olderPage ? (
        <p className="border-t border-[var(--color-line)] p-3 text-center">
          <Link href="/chat" className="inline-flex min-h-11 items-center text-sm no-underline">
            Back to the latest messages →
          </Link>
        </p>
      ) : (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            send(input);
          }}
          className="flex items-end gap-2 border-t border-[var(--color-line)] p-2 sm:p-3"
        >
          <textarea
            ref={box}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              // Enter sends (the keyboard's key says "send"); Shift+Enter adds a newline.
              if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                send(input);
              }
            }}
            rows={1}
            enterKeyHint="send"
            maxLength={4000}
            placeholder="Ask JARVIS…"
            aria-label="Message JARVIS"
            // 16 px text: iOS zooms into smaller inputs on focus.
            className="max-h-[8.75rem] min-h-11 min-w-0 flex-1 resize-none rounded-xl border border-[var(--color-line)] bg-transparent px-3 py-2.5 text-base leading-6 outline-none focus:border-[var(--color-accent)]"
          />
          <button disabled={busy || !input.trim()} className="min-h-11 shrink-0 rounded-xl bg-[var(--color-accent)] px-4 text-sm font-medium text-white disabled:opacity-50">
            Send
          </button>
        </form>
      )}
    </div>
  );
}
