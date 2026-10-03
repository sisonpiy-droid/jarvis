import { after, NextResponse, type NextRequest } from "next/server";
import { GeminiProvider } from "@jarvis/ai";
import { telegramSender } from "@jarvis/assist";
import type { Sql } from "@jarvis/db";
import { deliverAssignment } from "@jarvis/deliver";
import { loadNotificationSettings } from "@jarvis/notify";
import { db } from "@/lib/db";
import { storage } from "@/lib/storage";

// Background job: produce an assignment's deliverables (doc + filled workbook + slides).
// Called with the shared CRON_SECRET by the drafts job, the Telegram bot and the dashboard. The owner hears about the
// result through the notification queue (inbox / push / email); Telegram is optional (legacy "mirror" mode also gets files).
// Answers 202 at once and keeps working after the response (up to maxDuration).

export const runtime = "nodejs";
export const maxDuration = 300;
export const dynamic = "force-dynamic";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function authorized(req: NextRequest): boolean {
  const secret = process.env.CRON_SECRET;
  const got = req.headers.get("authorization") ?? "";
  const want = `Bearer ${secret}`;
  if (!secret || got.length !== want.length) return false;
  let diff = 0;
  for (let i = 0; i < want.length; i++) diff |= got.charCodeAt(i) ^ want.charCodeAt(i);
  return diff === 0;
}

export async function POST(req: NextRequest) {
  if (!authorized(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const body = (await req.json().catch(() => ({}))) as { assignmentId?: string; trigger?: string; instruction?: string; source?: string };
  if (!body.assignmentId || !UUID.test(body.assignmentId)) return NextResponse.json({ error: "assignmentId required" }, { status: 400 });
  const key = process.env.GEMINI_API_KEY;
  if (!key) return NextResponse.json({ error: "not configured" }, { status: 503 });

  const assignmentId = body.assignmentId;
  const instruction = typeof body.instruction === "string" ? body.instruction.trim().slice(0, 4000) : "";
  if (instruction) {
    // Saved before the job runs, so it applies to this draft and every future one.
    await (db() as unknown as Sql)`insert into jarvis.assignment_notes (assignment_id, note, source) values (${assignmentId}, ${instruction}, ${body.source === "web" ? "web" : "chat"})`;
  }
  const trigger = body.trigger === "auto" ? "auto" : "request";
  const model = process.env.GEMINI_DRAFT_MODEL ?? process.env.GEMINI_MODEL ?? "gemini-3.6-flash";
  after(async () => {
    const sql = db() as unknown as Sql;
    const token = process.env.TELEGRAM_BOT_TOKEN;
    const chat = process.env.TELEGRAM_CHAT_ID;
    const mirror = !!token && !!chat && (await loadNotificationSettings(sql)).telegram === "mirror";
    const res = await deliverAssignment(
      {
        sql,
        storage: storage(),
        model: new GeminiProvider(key, model, fetch, 200_000),
        modelName: model,
        ...(mirror ? { sendFile: telegramSender(token, chat).sendFile } : {}),
      },
      assignmentId,
      trigger,
    );
    console.log(JSON.stringify({ msg: "deliver finished", assignmentId, status: res.status, reason: res.reason ?? null }));
  });
  return NextResponse.json({ accepted: true }, { status: 202 });
}
