import Link from "next/link";

// The phone's More tab: everything that isn't one of the four main tabs, as big tap targets, plus Sign out.
const ITEMS = [
  ["/plan", "🗓️", "Week plan"],
  ["/checkin", "🌙", "Check-in"],
  ["/goals", "🎯", "Goals"],
  ["/projects", "📁", "Projects"],
  ["/assignments", "📝", "Assignments"],
  ["/drafts", "✍️", "Drafts"],
  ["/emails", "✉️", "Emails"],
  ["/classes", "🎓", "Classes"],
  ["/share", "📎", "Share"],
  ["/settings", "⚙️", "Settings"],
  ["/costs", "💸", "AI costs"],
  ["/status", "📡", "Status"],
] as const;

export default function MorePage() {
  return (
    <main>
      <h1 className="text-2xl font-semibold tracking-tight">More</h1>
      <ul className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-3">
        {ITEMS.map(([href, icon, label]) => (
          <li key={href}>
            <Link href={href} className="card flex min-h-16 items-center gap-3 px-4 py-3 font-medium text-[var(--color-ink)] no-underline hover:bg-[var(--color-line)]">
              <span aria-hidden className="text-xl">
                {icon}
              </span>
              {label}
            </Link>
          </li>
        ))}
      </ul>
      <form action="/logout" method="post" className="mt-6">
        <button className="min-h-11 text-sm text-[var(--color-muted)] hover:text-[var(--color-ink)]">Sign out</button>
      </form>
    </main>
  );
}
