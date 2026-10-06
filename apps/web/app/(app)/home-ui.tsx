import Link from "next/link";
import { fmtIstTime, refKey, type CalendarEntry, type Deadline, type FocusItem, type InboxItem, type Project, type RiskItem } from "@jarvis/db";
import { toPlainText } from "@jarvis/notify";
import type { CalendarRow, GlanceChip, StripDay } from "@/lib/command";
import { relative, shortCourse } from "@/lib/format";
import { Badge, Chip, Empty } from "./ui";
import { TaskRow } from "./tasks/task-ui";

// The command center's building blocks (server components). They only lay out what lib/command.ts and
// BriefFacts already worked out — no counting or ranking happens here.

/** One row of pills that scrolls sideways on a phone (the only deliberate horizontal scroll on the page). */
export function GlanceChips({ chips }: { chips: GlanceChip[] }) {
  if (!chips.length) return null;
  return (
    <nav aria-label="At a glance" className="scroll-x -mx-4 mt-3 flex snap-x gap-2 overflow-x-auto px-4 pb-1 md:mx-0 md:flex-wrap md:px-0">
      {chips.map((c) => (
        <Chip key={c.label} href={c.href} tone={c.tone}>
          {c.label}
        </Chip>
      ))}
    </nav>
  );
}

/** 🧭 Focus: the brief's note (or the live fallback), with where it came from. */
export function FocusCard({ text, caption }: { text: string; caption: string }) {
  if (!text) return null;
  return (
    <section className="card mt-4 border-l-4 border-l-[var(--color-accent)] p-4 sm:p-5">
      <div className="flex items-baseline justify-between gap-3">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-[var(--color-muted)]">🧭 Focus</h2>
        <span className="text-xs text-[var(--color-muted)]">{caption}</span>
      </div>
      <p className="mt-2 leading-relaxed break-words">{text}</p>
    </section>
  );
}

/** The one-time offer to review old goal/project memories; gone once every note is answered. */
export function MemoryReviewBanner({ count }: { count: number }) {
  if (count <= 0) return null;
  return (
    <Link href="/settings/memory" className="card mt-4 flex items-center justify-between gap-3 p-4 text-sm text-[var(--color-ink)] no-underline">
      <span className="min-w-0">
        🧠 <span className="font-medium">{count === 1 ? "1 old note could become a real goal or project" : `${count} old notes could become real goals or projects`}</span>
        <span className="text-[var(--color-muted)]"> — review them once; nothing changes unless you choose.</span>
      </span>
      <span className="shrink-0 text-[var(--color-accent)]">Review →</span>
    </Link>
  );
}

/** Numbered focus rows: reasons as the hint, a large numeral, ✓, and the ⋯ menu (Move to tomorrow, Open project, Edit). */
export function PriorityList({ items, back, projects, empty }: { items: FocusItem[]; back: string; projects: Project[]; empty?: string }) {
  if (!items.length) return empty ? <Empty>{empty}</Empty> : null;
  return (
    <ul className="divide-y divide-[var(--color-line)]">
      {items.map((i, n) => (
        <TaskRow key={i.task.id} t={i.task} back={back} projects={projects} rank={n + 1} hint={i.reasons.filter((r) => !/^(due |overdue|P[1-4]$|next action|in progress)/.test(r)).slice(0, 3).join(" · ") || undefined} menu />
      ))}
    </ul>
  );
}

function EventRow({ e }: { e: CalendarEntry }) {
  return (
    <li className={`flex gap-3 py-1.5 ${e.cancelled ? "opacity-50 line-through" : ""}`}>
      <span className="w-16 shrink-0 text-sm tabular-nums text-[var(--color-muted)]">{fmtIstTime(e.startAt)}</span>
      <span className="min-w-0">
        <span className="block font-medium break-words">{e.personal ? e.title : shortCourse(e.course ?? e.title)}</span>
        <span className="block text-sm text-[var(--color-muted)]">{[e.personal ? "Personal" : e.title !== e.course ? e.title : null, e.room].filter(Boolean).join(" · ")}</span>
      </span>
    </li>
  );
}

/** Today: all-day chips, then classes and events with the free gaps between them drawn as dashed rows. */
export function CalendarToday({ allDay, rows }: { allDay: CalendarEntry[]; rows: CalendarRow[] }) {
  if (!allDay.length && !rows.length) return <Empty>No classes today.</Empty>;
  return (
    <>
      {allDay.length > 0 && (
        <div className="mb-2 flex flex-wrap gap-1.5">
          {allDay.map((e) => (
            <Badge key={refKey(e.ref)} tone={e.cancelled ? "muted" : "good"}>
              All day · {e.title}
            </Badge>
          ))}
        </div>
      )}
      <ul>
        {rows.map((r) =>
          r.kind === "event" ? (
            <EventRow key={refKey(r.e.ref)} e={r.e} />
          ) : (
            <li key={`g${r.at}`} className="my-1 flex gap-3 rounded-lg border border-dashed border-[var(--color-line)] px-2 py-1.5 text-sm text-[var(--color-muted)]">
              <span className="w-14 shrink-0 tabular-nums">{fmtIstTime(r.at)}</span>
              <span>{r.label}</span>
            </li>
          ),
        )}
      </ul>
    </>
  );
}

/** The next few days as pills: a dot for classes, a dot for deadlines. */
export function DayStrip({ days }: { days: StripDay[] }) {
  return (
    <div className="mt-3 grid grid-cols-6 gap-1">
      {days.map((d) => (
        <Link
          key={d.day}
          href="/classes"
          aria-label={`${d.label}: ${d.classes} classes, ${d.deadlines} deadlines`}
          className="flex min-h-11 flex-col items-center justify-center rounded-lg bg-[var(--color-line)] px-1 py-1 text-xs text-[var(--color-ink)] no-underline"
        >
          <span className="whitespace-nowrap">{d.label}</span>
          <span className="mt-0.5 flex h-1.5 gap-1" aria-hidden>
            {d.classes > 0 && <span className="h-1.5 w-1.5 rounded-full bg-[var(--color-accent)]" />}
            {d.deadlines > 0 && <span className="h-1.5 w-1.5 rounded-full bg-[var(--color-warn)]" />}
          </span>
        </Link>
      ))}
    </div>
  );
}

const DEADLINE_ICON: Record<Deadline["kind"], string> = { assignment: "📝", project: "🎓", task: "✅", event: "📅" };

/** Upcoming deadlines: icon, linked title, when (warn for tomorrow) and context. */
export function DeadlineList({ items }: { items: Deadline[] }) {
  if (!items.length) return <Empty>Nothing due in the next 7 days. ✅</Empty>;
  return (
    <ul className="space-y-2.5">
      {items.map((d) => (
        <li key={refKey(d.ref)} className="flex gap-2">
          <span aria-hidden className="shrink-0">
            {DEADLINE_ICON[d.kind]}
          </span>
          <div className="min-w-0">
            <Link href={d.href} className="font-medium break-words text-[var(--color-ink)] no-underline hover:underline">
              {d.title}
            </Link>
            <div className="mt-0.5 flex flex-wrap items-center gap-1.5 text-xs text-[var(--color-muted)]">
              <Badge tone={d.when.startsWith("tomorrow") ? "warn" : "muted"}>{d.when}</Badge>
              {d.context && <span className="break-words">{d.kind === "assignment" ? shortCourse(d.context) : d.context}</span>}
            </div>
          </div>
        </li>
      ))}
    </ul>
  );
}

const RISK_DOT: Record<RiskItem["severity"], string> = { 3: "bg-[var(--color-bad)]", 2: "bg-[var(--color-warn)]", 1: "bg-[var(--color-muted)]" };

/** Risks other than goals and habits: a tone dot, the text, and where to act on it. */
export function RiskList({ items }: { items: RiskItem[] }) {
  if (!items.length) return null;
  return (
    <ul className="divide-y divide-[var(--color-line)]">
      {items.map((r, i) => (
        <li key={`${i}:${r.kind}`}className="flex items-start gap-2.5 py-2">
          <span aria-hidden className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${RISK_DOT[r.severity]}`} />
          <Link href={r.href} className="min-w-0 text-sm break-words text-[var(--color-ink)] no-underline hover:underline">
            {r.text}
          </Link>
        </li>
      ))}
    </ul>
  );
}

/** The latest unread notifications, read-only (opening Today must not mark them read or stop escalation). */
export function InboxPreview({ items }: { items: InboxItem[] }) {
  if (!items.length) return <Empty>No unread notifications.</Empty>;
  return (
    <ul className="divide-y divide-[var(--color-line)]">
      {items.map((i) => (
        <li key={i.id} className="py-2">
          <Link href={i.url || "/inbox"} className="block no-underline">
            <span className="block truncate text-sm text-[var(--color-ink)]">{toPlainText(i.text).split("\n")[0]}</span>
            <span className="block text-xs text-[var(--color-muted)]">{relative(i.at)}</span>
          </Link>
        </li>
      ))}
    </ul>
  );
}
