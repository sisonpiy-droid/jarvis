"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";

export interface InboxView {
  id: number;
  priority: string;
  category: string;
  url: string;
  html: string;
  at: string;
  unread: boolean;
}

const LEVEL: Record<string, { label: string; cls: string }> = {
  urgent: { label: "Critical", cls: "text-[var(--color-bad)]" },
  high: { label: "High", cls: "text-[var(--color-warn)]" },
  normal: { label: "", cls: "" },
  low: { label: "", cls: "" },
};

const post = (body: object) => fetch("/api/notifications", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
const when = (iso: string) => new Date(iso).toLocaleString("en-IN", { timeZone: "Asia/Kolkata", day: "numeric", month: "short", hour: "numeric", minute: "2-digit" });

export function InboxList({ items }: { items: InboxView[] }) {
  const router = useRouter();
  const [hidden, setHidden] = useState<Set<number>>(new Set());

  // Seeing it in the inbox counts as read (that also stops email escalation). Unread styling stays until refresh.
  useEffect(() => {
    const unread = items.filter((i) => i.unread).map((i) => i.id);
    if (unread.length) void post({ action: "read", ids: unread }).then(() => router.refresh());
  }, [items, router]);

  async function dismiss(id: number) {
    setHidden((h) => new Set(h).add(id));
    await post({ action: "dismiss", ids: [id] });
  }

  const visible = items.filter((i) => !hidden.has(i.id));
  if (!visible.length) return <p className="text-sm text-[var(--color-muted)]">Nothing here. New alerts appear here first, then on your phone per your settings.</p>;
  return (
    <ul className="divide-y divide-[var(--color-line)]">
      {visible.map((i) => (
        <li key={i.id} className={`flex gap-3 py-3 ${i.unread ? "" : "opacity-80"}`}>
          <span aria-hidden className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${i.unread ? "bg-[var(--color-accent)]" : "bg-transparent"}`} />
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-baseline gap-x-2 text-xs text-[var(--color-muted)]">
              <span>{when(i.at)}</span>
              <span>· {i.category}</span>
              {LEVEL[i.priority]?.label && <span className={`font-medium ${LEVEL[i.priority]!.cls}`}>· {LEVEL[i.priority]!.label}</span>}
            </div>
            <div className="notification-body mt-1 text-sm leading-relaxed break-words" dangerouslySetInnerHTML={{ __html: i.html }} />
            <div className="mt-1.5 flex gap-4 text-sm">
              <Link href={i.url}>Open</Link>
              <button onClick={() => void dismiss(i.id)} className="text-[var(--color-muted)] hover:text-[var(--color-ink)]">
                Dismiss
              </button>
            </div>
          </div>
        </li>
      ))}
    </ul>
  );
}

export function MarkAllRead() {
  const router = useRouter();
  return (
    <button onClick={() => void post({ action: "read", ids: "all" }).then(() => router.refresh())} className="text-sm text-[var(--color-muted)] hover:text-[var(--color-ink)]">
      Mark all read
    </button>
  );
}
