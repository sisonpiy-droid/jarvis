import { NextResponse, type NextRequest } from "next/server";
import { GeminiProvider, chat, jarvisTools, markdownToChatHtml, resetConversation } from "@jarvis/ai";
import type { Sql } from "@jarvis/db";
import { isSignedIn } from "@/lib/auth";
import { db } from "@/lib/db";
import { requestDraft, requestRevision } from "@/lib/edge";

export const dynamic = "force-dynamic";
export const maxDuration = 300; // multi-step answers to complex questions (deliver uses 300 too)

const failed = (err: unknown) => NextResponse.json({ error: err instanceof Error ? err.message.slice(0, 200) : "Failed" }, { status: 500 });

// POST {message}         → {html, sources, at, repaired, guarded}: one web chat turn (stored in chat_messages).
// POST {action: "reset"} → {ok, at}: "New conversation", a marker row; the model's context restarts after it.
export async function POST(req: NextRequest) {
  if (!(await isSignedIn())) return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  // `?? {}`: a JSON body of `null` parses fine but has no fields.
  const body = ((await req.json().catch(() => null)) ?? {}) as { message?: unknown; action?: unknown };

  if (body.action === "reset") {
    try {
      await resetConversation(db() as unknown as Sql, "web");
      return NextResponse.json({ ok: true, at: new Date().toISOString() });
    } catch (err) {
      return failed(err);
    }
  }

  const key = process.env.GEMINI_API_KEY;
  if (!key) return NextResponse.json({ error: "Chat isn't configured (no AI key)." }, { status: 503 });
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
    return NextResponse.json({
      html: markdownToChatHtml(res.text),
      sources: res.sources,
      at: new Date().toISOString(),
      repaired: res.guard.repaired,
      // The stored transcript's meaning: the guard fired (a correction was needed, or the footer is shown).
      guarded: res.guard.repaired || !res.guard.ok,
    });
  } catch (err) {
    return failed(err);
  }
}
