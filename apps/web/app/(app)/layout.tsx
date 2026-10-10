import Link from "next/link";
import { unreadCount } from "@jarvis/db";
import { requireSession } from "@/lib/auth";
import { sql } from "@/lib/passkey";
import { PwaSetup } from "./pwa-setup";
import { TabLink } from "./tab-link";

export const dynamic = "force-dynamic";

const NAV = [
  ["/", "Today"],
  ["/tasks", "Tasks"],
  ["/plan", "Plan"],
  ["/projects", "Projects"],
  ["/goals", "Goals"],
  ["/inbox", "Inbox"],
  ["/assignments", "Assignments"],
  ["/drafts", "Drafts"],
  ["/emails", "Emails"],
  ["/reading", "Reading"],
  ["/classes", "Classes"],
  ["/chat", "Chat"],
  ["/share", "Share"],
  ["/costs", "Costs"],
  ["/status", "Status"],
  ["/settings", "Settings"],
] as const;

// Phone tab bar: the five places used most.
const TABS = [
  ["/", "Today", "🏠"],
  ["/tasks", "Tasks", "✅"],
  ["/inbox", "Inbox", "🔔"],
  ["/chat", "Chat", "💬"],
  ["/more", "More", "☰"],
] as const;

function Badge({ n }: { n: number }) {
  if (!n) return null;
  return <span className="ml-1 rounded-full bg-[var(--color-accent)] px-1.5 py-px text-[10px] font-semibold text-white">{n > 99 ? "99+" : n}</span>;
}

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  await requireSession();
  const unread = await unreadCount(sql()).catch(() => 0);
  return (
    <div className="mx-auto max-w-5xl px-4 pb-24 md:pb-16">
      <PwaSetup />
      <header className="flex flex-wrap items-center gap-x-6 gap-y-2 py-3 pt-[max(0.75rem,env(safe-area-inset-top))] md:py-4">
        <Link href="/" className="text-lg font-semibold tracking-tight text-[var(--color-ink)] no-underline">
          JARVIS
        </Link>
        <nav className="hidden flex-wrap gap-1 text-sm md:flex">
          {NAV.map(([href, label]) => (
            <TabLink
              key={href}
              href={href}
              className="rounded-md px-2.5 py-1.5 no-underline hover:bg-[var(--color-line)] hover:text-[var(--color-ink)]"
              active="bg-[var(--color-line)] font-medium text-[var(--color-ink)]"
              idle="text-[var(--color-muted)]"
            >
              {label}
              {href === "/inbox" && <Badge n={unread} />}
            </TabLink>
          ))}
        </nav>
        <form action="/logout" method="post" className="ml-auto hidden md:block">
          <button className="text-sm text-[var(--color-muted)] hover:text-[var(--color-ink)]">Sign out</button>
        </form>
      </header>
      {children}
      <nav className="fixed inset-x-0 bottom-0 z-10 flex border-t border-[var(--color-line)] bg-[var(--color-panel)] pb-[env(safe-area-inset-bottom)] md:hidden">
        {TABS.map(([href, label, icon]) => (
          <TabLink key={href} href={href} className="flex flex-1 flex-col items-center gap-0.5 py-2 text-[11px] no-underline" active="font-semibold text-[var(--color-accent)]" idle="text-[var(--color-muted)]">
            <span aria-hidden className="text-lg leading-none">
              {icon}
            </span>
            <span>
              {label}
              {href === "/inbox" && <Badge n={unread} />}
            </span>
          </TabLink>
        ))}
      </nav>
    </div>
  );
}
