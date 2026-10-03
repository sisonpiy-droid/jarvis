import { NextResponse, type NextRequest } from "next/server";
import { SILENCE_RMS, transcribeAudio, wavRms } from "@jarvis/ai";
import { toBase64 } from "@jarvis/files";
import { aiModel } from "@/lib/ai";
import { isSignedIn } from "@/lib/auth";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** 16 kHz mono 16-bit WAV is 32 kB a second: 90 s ≈ 2.9 MB, under the platform's request limit. */
const MAX_BYTES = 4 * 2 ** 20;

// POST <audio/wav bytes> → {text}: a voice note transcribed for the chat box. Nothing is stored; the owner
// reads the text and sends it (or not).
export async function POST(req: NextRequest) {
  if (!(await isSignedIn())) return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  const model = aiModel(45_000);
  if (!model) return NextResponse.json({ error: "Voice isn't configured (no AI key)." }, { status: 503 });
  const type = (req.headers.get("content-type") ?? "").split(";")[0]!.trim();
  if (type !== "audio/wav") return NextResponse.json({ error: "Send audio/wav" }, { status: 415 });
  const bytes = new Uint8Array(await req.arrayBuffer());
  if (bytes.length < 1000) return NextResponse.json({ error: "Too short — hold on a little longer" }, { status: 400 });
  if (bytes.length > MAX_BYTES) return NextResponse.json({ error: "Too long — keep voice notes under 90 seconds" }, { status: 413 });
  if (wavRms(bytes) < SILENCE_RMS) return NextResponse.json({ text: "" }); // silence: nothing to transcribe
  try {
    return NextResponse.json({ text: await transcribeAudio(model, toBase64(bytes), "audio/wav") });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message.slice(0, 200) : "Failed" }, { status: 502 });
  }
}
