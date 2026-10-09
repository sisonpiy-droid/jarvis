import { NextResponse, type NextRequest } from "next/server";
import { GeminiProvider, googleCalendarFromEnv, meterTo, chat, jarvisTools, markdownToChatHtml, resetConversation } from "@jarvis/ai";
import type { Sql } from "@jarvis/db";
import { isSignedIn } from "@/lib/auth";
import { db } from "@/lib/db";
import { requestDraft, requestRevision } from "@/lib/edge";
import { storage } from "@/lib/storage";

export const dynamic = "force-dynamic";
export const maxDuration = 300; // multi-step answers to complex questions (deliver uses 300 too)

const DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

/** A document made in chat: stored like any file and served by the signed-in /files/<sha> route. */
async function saveChatFile(sql: Sql, origin: string, bytes: Uint8Array, name: string, mime = DOCX): Promise<string> {
  const sha = Buffer.from(await crypto.subtle.digest("SHA-256", bytes as Uint8Array<ArrayBuffer>)).toString("hex");
  const path = `chat/${sha}${/\.[a-z0-9]{1,8}$/i.exec(name)?.[0].toLowerCase() ?? ""}`;
  await storage().upload(path, bytes, mime);
  await sql`insert into jarvis.files (sha256, storage_path, mime_type, size_bytes, original_filename, text_status)
    values (${sha}, ${path}, ${mime}, ${bytes.length}, ${name}, 'unsupported') on conflict (sha256) do nothing`;
  return `Download link (put it in the reply as a Markdown link): ${origin}/files/${sha}`;
}

/** A stored file read back for clean_data (shared uploads, files from chat). */
async function readStoredFile(sql: Sql, fileId: string): Promise<{ bytes: Uint8Array; name: string } | null> {
  const [f] = await sql`select storage_path, original_filename from jarvis.files where sha256 = ${fileId}`;
  return f ? { bytes: await storage().download(String(f.storage_path)), name: String(f.original_filename ?? "file") } : null;
}

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
        model: new GeminiProvider(key, process.env.GEMINI_MODEL ?? "gemini-3.6-flash", fetch, 60_000, meterTo(sql)),
        channel: "web",
        tools: jarvisTools(sql, () => new Date(), { requestDraft, requestRevision: (id, text) => requestRevision(id, text, "chat"), sendFile: (bytes, name, _caption, mime) => saveChatFile(sql, req.nextUrl.origin, bytes, name, mime), readFile: (id) => readStoredFile(sql, id), calendar: googleCalendarFromEnv(process.env) }),
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
