import { Suspense } from "react";
import Link from "next/link";
import { fallbackFocusNote, listLegacyMemories } from "@jarvis/ai";
import { briefSections, getBrief, inbox, istDay, loadBriefFacts } from "@jarvis/db";
import { sql } from "@/lib/passkey";
import { recentUpdates } from "@/lib/queries";
import { EVENT_LABEL, relative } from "@/lib/format";
import {
  attentionGoals,
  calendarRows,
  chooseNote,
  classesToday,
  dayMode,
  dayStrip,
  doneTodayLine,
  glanceChips,
  greeting,
  habitsDone,
  homeProjects,
  mesaHeader,
  otherRisks,
  otherTasks,
} from "@/lib/command";
import { Empty, Fold, More, Section } from "./ui";
import { FormError, QuickAdd, TaskList } from "./tasks/task-ui";
import { AttentionList, GoalCard, HabitRow } from "./goals/goal-ui";
import { ProjectRow } from "./projects/project-ui";
import { CalendarToday, DayStrip, DeadlineList, FocusCard, GlanceChips, InboxPreview, MemoryReviewBanner, PriorityList, RiskList } from "./home-ui";

// The command center: the same facts and sections as the 8:00 brief (loadBriefFacts / briefSections), live.
// Phone first — one column in the order of the brief; on md+ a two-column grid under the header. Every number
// shown comes from the facts, the sections or a loaded row. No model is called while the page renders.

const TASKS_SHOWN = 5;

/** LMS changes in the last 3 days — streamed in after the rest of the page (it sits in a closed fold). */
async function RecentChanges() {
  const updates = await recentUpdates(72);
  if (!updates.length) return <Empty>No changes on the LMS in the last 3 days.</Empty>;
  return (
    <ul className="divide-y divide-[var(--color-line)]">
      {updates.map((u, i) => (
        <li key={i} className="flex flex-wrap items-baseline gap-x-3 py-2 text-sm">
          <span className="w-24 shrink-0 text-[var(--color-muted)]">{relative(u.at)}</span>
          <span className="font-medium">{EVENT_LABEL[u.type] ?? u.type}</span>
          {u.kind === "assignment" && u.id ? (
            <Link href={`/assignments/${u.id}`} className="min-w-0 truncate">
              {u.title}
            </Link>
          ) : (
            <span className="min-w-0 truncate text-[var(--color-muted)]">{u.title}</span>
          )}
        </li>
      ))}
    </ul>
  );
}

export default async function TodayPage({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  const { error } = await searchParams;
  const now = new Date();
  const db = sql();
  const [f, brief, unreadItems, oldNotes] = await Promise.all([
    loadBriefFacts(db, now),
    getBrief(db, istDay(now)).catch(() => null),
    inbox(db, { unreadOnly: true, limit: 3 }),
    listLegacyMemories(db).catch(() => []),
  ]);
  const s = briefSections(f);

  const mesa = mesaHeader(f);
  const note = chooseNote(brief, f, () => fallbackFocusNote(f, s));
  const evening = dayMode(now) === "evening";
  const others = otherTasks(f, s);
  const habits = habitsDone(f);
  const classes = classesToday(f).length;
  const goals = attentionGoals(f);
  const risks = otherRisks(s);
  const projects = homeProjects(f);

  return (
    <main>
      {/* 0. Header */}
      <h1 className="text-2xl font-semibold tracking-tight">{greeting(now)}</h1>
      <p className="mt-1 text-sm text-[var(--color-muted)]">
        {f.label} ·{" "}
        <Link href="/status" className="text-[var(--color-muted)] no-underline hover:underline">
          {mesa.lastCheck ? `Last LMS check ${relative(mesa.lastCheck, now.getTime())}` : "LMS not checked yet"} · {mesa.connected ? "MESA connected" : "⚠️ MESA needs sign-in"}
          {mesa.expiresSoon && ` · sign-in ${mesa.expired ? "expired" : "expires"} ${relative(mesa.expiresSoon, now.getTime())}`}
        </Link>
      </p>
      <FormError error={error} />

      {/* 1. At a glance */}
      <GlanceChips chips={glanceChips(f, s)} />

      {/* 2. Focus */}
      <FocusCard text={note.text} caption={note.caption} />
      <MemoryReviewBanner count={oldNotes.length} />

      <div className="md:grid md:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)] md:gap-x-4">
        <div className="min-w-0">
          {/* 3. Professional priorities */}
          <Section id="priorities" title={evening ? "Still open today" : "Today's priorities"}>
            {evening && <p className="-mt-1 mb-2 text-sm text-[var(--color-muted)]">{doneTodayLine(f)}</p>}
            <PriorityList items={s.priorities} back="/" projects={f.projects} empty="Nothing pressing at work." />
            <p className="mt-3 text-sm">
              <More href="/tasks">All tasks</More>
            </p>
          </Section>

          {/* 4. Personal priorities */}
          {s.personal.tasks.length > 0 && (
            <Section title="Personal">
              <PriorityList items={s.personal.tasks} back="/" projects={f.projects} />
            </Section>
          )}

          {/* 5. The rest of today's tasks */}
          <Section title={`Also today (${others.length})`}>
            <TaskList tasks={others.slice(0, TASKS_SHOWN)} back="/" projects={f.projects} empty="Nothing else due today." />
            {others.length > TASKS_SHOWN && (
              <p className="mt-2 text-sm">
                <More href="/tasks?view=today">{`All ${others.length}`}</More>
              </p>
            )}
            <details className="mt-3">
              <summary className="cursor-pointer text-sm text-[var(--color-accent)]">+ Add task</summary>
              <div className="mt-2">
                <QuickAdd back="/" projects={f.projects} />
              </div>
            </details>
          </Section>

          {/* 6. Habits */}
          {habits.total > 0 && (
            <Section id="habits" title={`Habits ${habits.done}/${habits.total}`} action={<More href="/goals">All</More>}>
              <ul className="divide-y divide-[var(--color-line)]">
                {f.habits.map((h) => (
                  <HabitRow key={h.id} h={h} back="/" />
                ))}
              </ul>
            </Section>
          )}
        </div>

        <div className="min-w-0">
          {/* 7. Calendar */}
          <Section id="calendar" title={classes ? `Today · ${classes} ${classes === 1 ? "class" : "classes"}` : "Today"} action={<More href="/classes">Week</More>}>
            <CalendarToday allDay={f.calendar.filter((e) => e.allDay)} rows={calendarRows(f)} />
            <DayStrip days={dayStrip(f)} />
          </Section>

          {/* 8. Upcoming deadlines */}
          <Section title="Next 7 days">
            <DeadlineList items={s.upcoming.slice(0, 10)} />
          </Section>

          {/* 9. Goal progress */}
          <Section title="Goals">
            {s.goals.length ? (
              <ul className="divide-y divide-[var(--color-line)]">
                {s.goals.slice(0, 6).map((g) => (
                  <GoalCard key={g.id} g={g} p={g.progress} risk={g.risk.risk} neglected={g.neglect.neglected} />
                ))}
              </ul>
            ) : (
              <Empty>No goals with a target yet.</Empty>
            )}
            <p className="mt-2 text-sm">
              <More href="/goals">All goals</More>
            </p>
          </Section>

          {/* 10. At risk (always shown) */}
          <Section id="risks" title="At risk">
            {goals.length || f.slipping.length || risks.length ? (
              <>
                <RiskList items={risks} />
                {(goals.length > 0 || f.slipping.length > 0) && <AttentionList goals={goals} habits={f.slipping} back="/" fold />}
              </>
            ) : (
              <Empty>Nothing at risk ✅</Empty>
            )}
          </Section>

          {/* 11. Notifications (read-only) */}
          <Section title={f.unread ? `Notifications · ${f.unread} unread` : "Notifications"}>
            <InboxPreview items={unreadItems} />
            <p className="mt-2 text-sm">
              <More href="/inbox">Open inbox</More>
            </p>
          </Section>

          {/* 12. Projects */}
          {projects.length > 0 && (
            <Section title="Projects" action={<More href="/projects">All</More>}>
              <ul className="divide-y divide-[var(--color-line)]">
                {projects.map((p) => (
                  <ProjectRow key={p.id} p={p} next={p.next} now={now} />
                ))}
              </ul>
            </Section>
          )}
        </div>
      </div>

      {/* 13. LMS changes */}
      <Fold summary="LMS changes (last 3 days)">
        <Suspense fallback={<Empty>Loading…</Empty>}>
          <RecentChanges />
        </Suspense>
      </Fold>
    </main>
  );
}
