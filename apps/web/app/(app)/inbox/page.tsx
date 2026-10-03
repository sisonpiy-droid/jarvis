import Link from "next/link";
import { inbox, NOTIFICATION_CATEGORIES } from "@jarvis/db";
import { toSafeHtml } from "@jarvis/notify";
import { sql } from "@/lib/passkey";
import { Section } from "../ui";
import { InboxList, MarkAllRead } from "./inbox-list";

export const dynamic = "force-dynamic";

export default async function InboxPage({ searchParams }: { searchParams: Promise<{ c?: string; unread?: string }> }) {
  const { c, unread } = await searchParams;
  const category = c && (NOTIFICATION_CATEGORIES as readonly string[]).includes(c) ? c : null;
  const items = await inbox(sql(), { category, unreadOnly: unread === "1", limit: 150 });
  const chip = (href: string, label: string, active: boolean) => (
    <Link key={href} href={href} className={`rounded-full px-2.5 py-1 text-xs no-underline ${active ? "bg-[var(--color-accent)] text-white" : "bg-[var(--color-line)] text-[var(--color-muted)]"}`}>
      {label}
    </Link>
  );
  return (
    <main>
      <h1 className="text-2xl font-semibold tracking-tight">Inbox</h1>
      <div className="mt-3 flex flex-wrap gap-1.5">
        {chip("/inbox", "All", !category && unread !== "1")}
        {chip("/inbox?unread=1", "Unread", unread === "1")}
        {NOTIFICATION_CATEGORIES.map((k) => chip(`/inbox?c=${k}`, k, category === k))}
      </div>
      <Section title={`${items.length} notification${items.length === 1 ? "" : "s"}`} action={<MarkAllRead />}>
        <InboxList
          items={items.map((i) => ({ id: i.id, priority: i.priority, category: i.category, url: i.url, html: toSafeHtml(i.text), at: i.at, unread: !i.readAt }))}
        />
      </Section>
    </main>
  );
}
