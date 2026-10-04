import Link from "next/link";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { fmtIstShort, fmtIstTime, fmtMinutes, loadCheckin, moveOpenToTomorrow } from "@jarvis/db";
import { isSignedIn } from "@/lib/auth";
import { sql } from "@/lib/passkey";
import { Empty, Section } from "../ui";

// The evening check-in (where the 20:30 notification opens): what got done, what's still open from today with one
// button to move it to tomorrow, tomorrow at a glance, tomorrow's top 3 and a nudge. Same facts as the push.

async function moveRest() {
  "use server";
  if (!(await isSignedIn())) redirect("/login");
  const moved = await moveOpenToTomorrow(sql(), new Date());
  revalidatePath("/tasks");
  revalidatePath("/");
  redirect(`/checkin?moved=${moved}`);
}

export default async function CheckinPage({ searchParams }: { searchParams: Promise<{ moved?: string }> }) {
  const { moved } = await searchParams;
  const now = new Date();
  const c = await loadCheckin(sql(), now);
  const t = c.tomorrow;
  const ask = "Plan my day tomorrow: what should I do when, given my classes and free time?";
  return (
    <main>
      <h1 className="text-2xl font-semibold tracking-tight">Evening check-in</h1>
      {moved != null && <p className="mt-2 text-sm text-[var(--color-good)]">Moved {Number(moved) || 0} task{Number(moved) === 1 ? "" : "s"} to tomorrow.</p>}

      <Section title={`Done today (${c.done.length})`}>
        {c.done.length ? (
          <ul className="space-y-1 text-sm">
            {c.done.map((d, i) => (
              <li key={`${d}:${i}`}>✅ {d}</li>
            ))}
          </ul>
        ) : (
          <Empty>Nothing marked done today.</Empty>
        )}
      </Section>

      {(c.stillOpen.length > 0 || c.dueTonight.length > 0) && (
        <Section title="Still open from today">
          <ul className="space-y-1 text-sm">
            {c.dueTonight.map((a) => (
              <li key={a.title} className="text-[var(--color-warn)]">
                ⚠️ {a.title} — not submitted, due {fmtIstTime(a.dueAt)}
              </li>
            ))}
            {c.stillOpen.map((x) => (
              <li key={x.id}>⏳ {x.title}</li>
            ))}
          </ul>
          {c.stillOpen.length > 0 && (
            <form action={moveRest} className="mt-3">
              <button className="min-h-11 rounded-xl bg-[var(--color-accent)] px-4 text-sm font-medium text-white">
                Move {c.stillOpen.length === 1 ? "it" : `these ${c.stillOpen.length}`} to tomorrow
              </button>
            </form>
          )}
        </Section>
      )}

      <Section title={`Tomorrow · ${fmtIstShort(t.day + "T00:00:00+05:30")}`}>
        <ul className="space-y-1 text-sm">
          <li>
            📅 {t.classes.length ? `${t.classes.length} class${t.classes.length > 1 ? "es" : ""}: ${t.classes.map((e) => `${fmtIstTime(e.startAt)} ${(e.course ?? e.title).replace(/\s+with\s+.*$/i, "")}`).join(", ")}` : "No classes"}
          </li>
          <li>🕒 {fmtMinutes(t.freeMin)} free between 8 am and 10 pm</li>
          {t.deadlines.map((d) => (
            <li key={`${d.title}:${d.at}`}>
              ⏰ {d.title} — {fmtIstTime(d.at)}
            </li>
          ))}
          {c.prereads.map((p) => (
            <li key={`${p.course}:${p.session}`}>
              📖 {p.course}
              {p.session != null ? ` · Session ${p.session}` : ""}: {p.titles.length ? p.titles.join(", ") : "no pre-read on the LMS"}
            </li>
          ))}
        </ul>
      </Section>

      <Section title="Tomorrow's top 3">
        {c.top.length ? (
          <ol className="list-decimal space-y-1 pl-5 text-sm">
            {c.top.map((i) => (
              <li key={i.task.id}>
                {i.task.title} <span className="text-[var(--color-muted)]">— {i.reasons.join(", ") || "no due date"}</span>
              </li>
            ))}
          </ol>
        ) : (
          <Empty>Nothing pressing for tomorrow.</Empty>
        )}
        {c.nudge && <p className="mt-3 text-sm">💡 {c.nudge}</p>}
      </Section>

      <div className="mt-4">
        <Link href={`/chat?q=${encodeURIComponent(ask)}`} className="inline-flex min-h-11 items-center rounded-full border border-[var(--color-line)] px-4 text-sm no-underline">
          Plan tomorrow with JARVIS
        </Link>
      </div>
    </main>
  );
}
