"use client";

// Browser side of voice notes: record with MediaRecorder (webm/opus on Android, mp4/aac on iPhone), then decode
// and re-encode as 16 kHz mono WAV — one format the transcriber always accepts, small enough to upload.

export const VOICE_MAX_MS = 90_000;
const RATE = 16_000;

export const voiceSupported = () =>
  typeof window !== "undefined" && !!navigator.mediaDevices?.getUserMedia && typeof MediaRecorder !== "undefined" && typeof OfflineAudioContext !== "undefined";

export interface Recording {
  /** Stops and returns the WAV (null if nothing was recorded). */
  stop(): Promise<Blob | null>;
  cancel(): void;
}

export async function startRecording(onAutoStop: () => void): Promise<Recording> {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
  const rec = new MediaRecorder(stream);
  const chunks: Blob[] = [];
  rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
  const stopped = new Promise<void>((resolve) => (rec.onstop = () => resolve()));
  rec.start();
  const timer = setTimeout(onAutoStop, VOICE_MAX_MS);
  const release = () => {
    clearTimeout(timer);
    stream.getTracks().forEach((t) => t.stop());
  };
  return {
    async stop() {
      if (rec.state !== "inactive") rec.stop();
      await stopped;
      release();
      if (!chunks.length) return null;
      return toWav(new Blob(chunks, { type: rec.mimeType || chunks[0]!.type }));
    },
    cancel() {
      if (rec.state !== "inactive") rec.stop();
      release();
    },
  };
}

/** Any recorded audio → 16 kHz mono 16-bit PCM WAV. */
export async function toWav(blob: Blob): Promise<Blob> {
  const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
  const ctx = new AC();
  let decoded: AudioBuffer;
  try {
    decoded = await ctx.decodeAudioData(await blob.arrayBuffer());
  } finally {
    void ctx.close();
  }
  const frames = Math.max(1, Math.ceil(decoded.duration * RATE));
  const off = new OfflineAudioContext(1, frames, RATE);
  const src = off.createBufferSource();
  src.buffer = decoded;
  src.connect(off.destination);
  src.start();
  const pcm = (await off.startRendering()).getChannelData(0);
  const out = new DataView(new ArrayBuffer(44 + pcm.length * 2));
  const text = (o: number, s: string) => [...s].forEach((c, i) => out.setUint8(o + i, c.charCodeAt(0)));
  text(0, "RIFF");
  out.setUint32(4, 36 + pcm.length * 2, true);
  text(8, "WAVE");
  text(12, "fmt ");
  out.setUint32(16, 16, true);
  out.setUint16(20, 1, true); // PCM
  out.setUint16(22, 1, true); // mono
  out.setUint32(24, RATE, true);
  out.setUint32(28, RATE * 2, true);
  out.setUint16(32, 2, true);
  out.setUint16(34, 16, true);
  text(36, "data");
  out.setUint32(40, pcm.length * 2, true);
  for (let i = 0; i < pcm.length; i++) out.setInt16(44 + i * 2, Math.max(-1, Math.min(1, pcm[i]!)) * 0x7fff, true);
  return new Blob([out.buffer], { type: "audio/wav" });
}

export async function transcribe(wav: Blob): Promise<string> {
  const r = await fetch("/api/voice", { method: "POST", headers: { "Content-Type": "audio/wav" }, body: wav });
  const j = (await r.json().catch(() => ({}))) as { text?: string; error?: string };
  if (!r.ok || typeof j.text !== "string") throw new Error(j.error ?? "Couldn't transcribe that");
  return j.text;
}

// Read aloud: the browser's own speech (works offline, no upload). One utterance at a time.
export const speechSupported = () => typeof window !== "undefined" && "speechSynthesis" in window;

export function speak(text: string, onEnd: () => void): void {
  const synth = window.speechSynthesis;
  synth.cancel();
  const u = new SpeechSynthesisUtterance(text.slice(0, 4000));
  const voices = synth.getVoices();
  const voice = voices.find((v) => v.lang === "en-IN") ?? voices.find((v) => v.lang.startsWith("en"));
  if (voice) u.voice = voice;
  u.lang = voice?.lang ?? "en-IN";
  u.onend = onEnd;
  u.onerror = onEnd;
  synth.speak(u);
}

export const stopSpeaking = () => speechSupported() && window.speechSynthesis.cancel();
