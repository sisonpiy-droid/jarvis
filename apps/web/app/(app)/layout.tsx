import Link from "next/link";
import { requireSession } from "@/lib/auth";

export const dynamic = "force-dynamic";

const NAV = [
  ["/", "Today"],
  ["/assignments", "Assignments"],
  ["/classes", "Classes"],
  ["/chat", "Chat"],
  ["/status", "Status"],
] as const;

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  await requireSession();
  return (
    <div className="mx-auto max-w-5xl px-4 pb-16">
      <header className="flex flex-wrap items-center gap-x-6 gap-y-2 py-4">
        <Link href="/" className="text-lg font-semibold tracking-tight text-[var(--color-ink)] no-underline">
          JARVIS
        </Link>
        <nav className="flex flex-wrap gap-1 text-sm">
          {NAV.map(([href, label]) => (
            <Link key={href} href={href} className="rounded-md px-2.5 py-1.5 text-[var(--color-muted)] no-underline hover:bg-[var(--color-line)] hover:text-[var(--color-ink)]">
              {label}
            </Link>
          ))}
        </nav>
        <form action="/logout" method="post" className="ml-auto">
          <button className="text-sm text-[var(--color-muted)] hover:text-[var(--color-ink)]">Sign out</button>
        </form>
      </header>
      {children}
    </div>
  );
}
