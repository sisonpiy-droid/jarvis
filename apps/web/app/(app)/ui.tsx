import Link from "next/link";
import { isSubmitted } from "@/lib/format";

export function Section({ title, action, id, children }: { title: string; action?: React.ReactNode; id?: string; children: React.ReactNode }) {
  return (
    <section id={id} className="card mt-4 scroll-mt-4 p-4 sm:p-5">
      <div className="mb-3 flex items-baseline justify-between gap-3">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-[var(--color-muted)]">{title}</h2>
        {action}
      </div>
      {children}
    </section>
  );
}

const TONES = {
  good: "bg-[color-mix(in_srgb,var(--color-good)_14%,transparent)] text-[var(--color-good)]",
  warn: "bg-[color-mix(in_srgb,var(--color-warn)_16%,transparent)] text-[var(--color-warn)]",
  bad: "bg-[color-mix(in_srgb,var(--color-bad)_14%,transparent)] text-[var(--color-bad)]",
  muted: "bg-[var(--color-line)] text-[var(--color-muted)]",
} as const;

export function Badge({ tone = "muted", children }: { tone?: keyof typeof TONES; children: React.ReactNode }) {
  // max-w-full + truncate: a long badge (an overdue date with its relative time) never widens a phone row.
  return <span className={`inline-block max-w-full truncate rounded-full px-2 py-0.5 align-middle text-xs font-medium ${TONES[tone]}`}>{children}</span>;
}

export function StatusBadge({ status, dueAt }: { status: string; dueAt: string | null }) {
  if (status === "submitted") return <Badge tone="good">Submitted</Badge>;
  if (status === "submitted_late") return <Badge tone="warn">Submitted late</Badge>;
  if (dueAt && Date.parse(dueAt) < Date.now()) return <Badge tone="bad">Overdue</Badge>;
  if (dueAt && Date.parse(dueAt) - Date.now() < 48 * 3_600_000) return <Badge tone="warn">Due soon</Badge>;
  return <Badge>{isSubmitted(status) ? "Submitted" : "Not submitted"}</Badge>;
}

export function Empty({ children }: { children: React.ReactNode }) {
  return <p className="text-sm text-[var(--color-muted)]">{children}</p>;
}

/** A tappable pill (at least 44 px tall). A "#section" href stays a plain in-page anchor. */
export function Chip({ href, tone = "muted", children }: { href: string; tone?: keyof typeof TONES; children: React.ReactNode }) {
  const cls = `inline-flex min-h-11 shrink-0 snap-start items-center rounded-full px-3.5 text-sm font-medium whitespace-nowrap no-underline ${TONES[tone]}`;
  return href.startsWith("#") ? (
    <a href={href} className={cls}>
      {children}
    </a>
  ) : (
    <Link href={href} className={cls}>
      {children}
    </Link>
  );
}

/** A collapsible card (<details>): works without client JavaScript. */
export function Fold({ summary, open, children }: { summary: string; open?: boolean; children: React.ReactNode }) {
  return (
    <details open={open} className="card mt-4 p-4 sm:p-5">
      <summary className="cursor-pointer text-sm font-semibold uppercase tracking-wide text-[var(--color-muted)]">{summary}</summary>
      <div className="mt-3">{children}</div>
    </details>
  );
}

export function More({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <Link href={href} className="text-sm no-underline">
      {children} →
    </Link>
  );
}
