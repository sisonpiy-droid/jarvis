import { NextResponse, type NextRequest } from "next/server";
import { GeminiProvider, chat, jarvisTools, markdownToTelegramHtml } from "@jarvis/ai";
import type { Sql } from "@jarvis/db";
import { isSignedIn } from "@/lib/auth";
import { db } from "@/lib/db";
import { requestDraft, requestRevision } from "@/lib/edge";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function POST(req: NextRequest) {
  if (!(await isSignedIn())) return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  const key = process.env.GEMINI_API_KEY;
  if (!key) return NextResponse.json({ error: "Chat isn't configured (no AI key)." }, { status: 503 });
  const body = (await req.json().catch(() => ({}))) as { message?: unknown };
  const message = typeof body.message === "string" ? body.message.trim().slice(0, 4000) : "";
  if (!message) return NextResponse.json({ error: "Empty message" }, { status: 400 });
  try {
    const sql = db() as unknown as Sql;
    const res = await chat(
      {
        sql,
        model: new GeminiProvider(key, process.env.GEMINI_MODEL ?? "gemini-3.6-flash"),
        channel: "web",
        tools: jarvisTools(sql, () => new Date(), { requestDraft, requestRevision: (id, text) => requestRevision(id, text, "chat") }),
      },
      message,
    );
    return NextResponse.json({ html: markdownToTelegramHtml(res.text) });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message.slice(0, 200) : "Failed" }, { status: 500 });
  }
}
