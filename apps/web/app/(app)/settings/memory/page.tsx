import Link from "next/link";
import { countMemories, listLegacyMemories, listMemories, memoryScopeLabel, type Memory, type MemoryScope } from "@jarvis/ai";
import { relative } from "@/lib/format";
import { sql } from "@/lib/passkey";
import { Badge, Empty, Section } from "../../ui";
import { FormError, quiet } from "../../tasks/task-ui";
import { forgetMemoryAction, keepOldMemory } from "./actions";

export const dynamic = "force-dynamic";

// Everything JARVIS remembers, by scope, and the one-time review of old goal/project notes. Converting a note
// goes through the normal New goal / New project form (prefilled on the server from the note's id), so the owner
// sets the real target; nothing here changes a note without a tap.

const PER_PAGE = 60;
const SCOPE_TITLE: Record<MemoryScope, string> = { global: "About you", mesa: "MESA", project: "Projects", person: "People" };

function ForgetButton({ id }: { id: number }) {
  return (
    <details className="shrink-0 text-sm">
      <summary className="cursor-pointer text-[var(--color-muted)]">Forget</summary>
      <form action={forgetMemoryAction} className="mt-1">
        <input type="hidden" name="id" value={id} />
        <button className="text-[var(--color-bad)]">Yes, forget #{id}</button>
      </form>
    </details>
  );
}

function OldNote({ m }: { m: Memory }) {
  return (
    <li className="py-3">
      <div className="flex flex-wrap items-baseline gap-2">
        <Badge tone="warn">old {m.kind}</Badge>
        <span className="min-w-0 break-words">{m.content}</span>
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-2 text-sm">
        <Link href={`/goals?from_memory=${m.id}`} className={`${quiet} no-underline`}>
          Make it a goal
        </Link>
        <Link href={`/projects?from_memory=${m.id}`} className={`${quiet} no-underline`}>
          Make it a project
        </Link>
        <form action={keepOldMemory}>
          <input type="hidden" name="id" value={m.id} />
          <button className={quiet}>Keep as note</button>
        </form>
        <form action={forgetMemoryAction}>
          <input type="hidden" name="id" value={m.id} />
          <button className={`${quiet} text-[var(--color-bad)]`}>Forget</button>
        </form>
      </div>
    </li>
  );
}

export default async function MemoryPage({ searchParams }: { searchParams: Promise<{ page?: string; error?: string }> }) {
  const { page, error } = await searchParams;
  const p = Math.max(1, Math.floor(Number(page)) || 1);
  const db = sql();
  const [legacy, mems, counts] = await Promise.all([listLegacyMemories(db), listMemories(db, PER_PAGE, (p - 1) * PER_PAGE), countMemories(db)]);
  const kept = mems.filter((m) => !m.legacy);
  const scopes = (Object.keys(SCOPE_TITLE) as MemoryScope[]).map((s) => [s, kept.filter((m) => m.scope === s)] as const).filter(([, list]) => list.length);
  const pages = Math.max(1, Math.ceil(counts.active / PER_PAGE));

  return (
    <main>
      <p className="text-sm">
        <Link href="/settings" className="no-underline">
          ← Settings
        </Link>
      </p>
      <h1 className="mt-1 text-2xl font-semibold tracking-tight">What JARVIS remembers</h1>
      <p className="mt-1 text-sm text-[var(--color-muted)]">
        Things you told JARVIS in chat. Dates, progress and deadlines live in your tasks, goals and projects, not here. To add one, tell JARVIS in Chat.
      </p>
      <FormError error={error} />

      {legacy.length > 0 && (
        <Section title={`Old notes to review (${legacy.length})`}>
          <p className="-mt-1 mb-2 text-sm text-[var(--color-muted)]">
            These were saved as goals or projects before JARVIS tracked them for real. Make one a goal or project (you set the target), keep it as a note, or forget it.
          </p>
          <ul className="divide-y divide-[var(--color-line)]">
            {legacy.map((m) => (
              <OldNote key={m.id} m={m} />
            ))}
          </ul>
        </Section>
      )}

      {scopes.length === 0 ? (
        <Section title="Memories">
          <Empty>{legacy.length ? "Nothing else yet." : "Nothing yet. Tell JARVIS things like “I prefer short answers” or “my BYOB group is …”."}</Empty>
        </Section>
      ) : (
        scopes.map(([scope, list]) => (
          <Section key={scope} title={`${SCOPE_TITLE[scope]} (${list.length})`}>
            <ul className="divide-y divide-[var(--color-line)]">
              {list.map((m) => (
                <li key={m.id} className="flex items-start justify-between gap-3 py-2">
                  <div className="min-w-0">
                    <div className="break-words">{m.content}</div>
                    <div className="mt-0.5 flex flex-wrap items-center gap-1.5 text-xs text-[var(--color-muted)]">
                      <Badge>{memoryScopeLabel(m) || m.kind}</Badge>
                      {m.learned && <Badge tone="warn">Learned from chat</Badge>}
                      <span>
                        #{m.id} · {m.learned ? "learned" : "saved"} {relative(m.createdAt)}
                        {m.lastUsedAt ? ` · last used ${relative(m.lastUsedAt)}` : ""}
                      </span>
                    </div>
                  </div>
                  <ForgetButton id={m.id} />
                </li>
              ))}
            </ul>
          </Section>
        ))
      )}

      {pages > 1 && (
        <nav aria-label="Pages" className="mt-4 flex items-center justify-between text-sm">
          {p > 1 ? (
            <Link href={`/settings/memory?page=${p - 1}`} className="no-underline">
              ← Previous
            </Link>
          ) : (
            <span />
          )}
          <span className="text-[var(--color-muted)]">
            Page {p} of {pages}
          </span>
          {p < pages ? (
            <Link href={`/settings/memory?page=${p + 1}`} className="no-underline">
              Next →
            </Link>
          ) : (
            <span />
          )}
        </nav>
      )}
    </main>
  );
}
