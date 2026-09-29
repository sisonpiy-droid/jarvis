import { buildClassFeed, type FeedEvent } from "@jarvis/calendar";
import { calendarToken } from "@/lib/auth";
import { db } from "@/lib/db";

export const dynamic = "force-dynamic";

const same = (a: string, b: string) => {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
};

/** MESA classes as an iCalendar feed, for subscribing from Google Calendar ("From URL"). */
export async function GET(_req: Request, ctx: { params: Promise<{ token: string; file: string }> }) {
  const { token } = await ctx.params;
  if (!same(token, await calendarToken())) return new Response("Not found", { status: 404 });
  const rows = await db()<{ data: FeedEvent; changed_at: Date }[]>`
    select data, changed_at from jarvis.lms_items
     where kind = 'event' and removed_at is null and sort_at >= now() - interval '60 days'
     order by sort_at`;
  const body = buildClassFeed(rows.map((r) => ({ ...r.data, updatedAt: r.changed_at.toISOString() })));
  return new Response(body, {
    headers: {
      "Content-Type": "text/calendar; charset=utf-8",
      "Content-Disposition": 'inline; filename="mesa-classes.ics"',
      "Cache-Control": "private, max-age=300",
    },
  });
}
