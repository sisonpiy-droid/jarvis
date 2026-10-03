"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { CHAT_DRAFT_KEY, sharedLine, uploadShared, type SharedFile } from "@/lib/share-client";
import { addSharedTask } from "./actions";

// Reads what the service worker parked from the share sheet (cache "jarvis-share-v1"), or lets the owner paste
// or pick something. Files are uploaded only when an action is chosen; the parked copy is then cleared.

const SHARE_CACHE = "jarvis-share-v1";
type Meta = { title: string; text: string; url: string; files: Array<{ name: string; type: string; size: number }> };

async function readParked(): Promise<{ meta: Meta; files: File[] } | null> {
  if (typeof caches === "undefined") return null;
  const cache = await caches.open(SHARE_CACHE);
  const res = await cache.match("/__share/meta");
  if (!res) return null;
  const meta = (await res.json()) as Meta;
  const files: File[] = [];
  for (const [i, f] of meta.files.entries()) {
    const r = await cache.match(`/__share/file/${i}`);
    if (r) files.push(new File([await r.blob()], f.name, { type: f.type }));
  }
  return { meta, files };
}

async function clearParked() {
  if (typeof caches !== "undefined") await caches.delete(SHARE_CACHE).catch(() => false);
}

/** "Check: Groww Q2 results" — a starting task title from whatever was shared. */
function titleFrom(title: string, text: string, url: string, files: File[]): string {
  const firstLine = text
    .split(/\r?\n/)
    .map((l) => l.replace(/https?:\/\/\S+/g, "").trim())
    .find(Boolean);
  let host = "";
  try {
    host = url ? new URL(url).hostname.replace(/^www\./, "") : "";
  } catch {
    /* not a URL */
  }
  const what = (title.trim() || firstLine || files[0]?.name || host).slice(0, 110);
  if (!what) return "";
  // Already an action ("Check this…", "Read the…"): keep it as it is.
  return /^(check|read|watch|call|reply|submit|review|look|buy|pay|book|send|finish|prepare|fill)\b/i.test(what) ? what : `Check: ${what}`;
}

export function ShareInbox({ failed }: { failed: boolean }) {
  const router = useRouter();
  const [loaded, setLoaded] = useState(false);
  const [text, setText] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const [title, setTitle] = useState("");
  const [busy, setBusy] = useState<null | "ask" | "task">(null);
  const [error, setError] = useState<string | null>(failed ? "That share didn't come through. Share it again, or paste it below." : null);
  const picker = useRef<HTMLInputElement>(null);

  useEffect(() => {
    readParked()
      .then((p) => {
        if (!p) return;
        const { meta } = p;
        // Many apps put the link inside the text too; don't show it twice.
        const body = [meta.title && !meta.text.includes(meta.title) ? meta.title : "", meta.text, meta.url && !meta.text.includes(meta.url) ? meta.url : ""].filter(Boolean).join("\n");
        setText(body);
        setFiles(p.files);
        setTitle(titleFrom(meta.title, meta.text, meta.url, p.files));
      })
      .catch(() => setError("Couldn't read what was shared. Share it again, or paste it below."))
      .finally(() => setLoaded(true));
  }, []);

  async function uploadAll(): Promise<SharedFile[]> {
    const out: SharedFile[] = [];
    for (const f of files) out.push(await uploadShared(f));
    return out;
  }

  async function ask() {
    setBusy("ask");
    setError(null);
    try {
      const shared = await uploadAll();
      const draft = [text.trim(), ...shared.map(sharedLine)].filter(Boolean).join("\n");
      try {
        sessionStorage.setItem(CHAT_DRAFT_KEY, draft ? `${draft}\n\n` : "");
      } catch {
        /* storage blocked: the chat opens empty */
      }
      await clearParked();
      router.push("/chat");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Upload failed");
      setBusy(null);
    }
  }

  async function keepAsTask() {
    if (!title.trim()) {
      setError("Give the task a title.");
      return;
    }
    setBusy("task");
    setError(null);
    try {
      const shared = await uploadAll();
      const notes = [text.trim(), ...shared.map((f) => `${f.name}: /files/${f.fileId}`)].filter(Boolean).join("\n");
      const r = await addSharedTask({ title: title.trim(), notes });
      if (!r.ok) throw new Error(r.error);
      await clearParked();
      router.push("/tasks");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't add the task");
      setBusy(null);
    }
  }

  const empty = !text.trim() && !files.length;
  return (
    <div className="card mt-4 space-y-4 p-4 sm:p-5">
      {error && <p className="text-sm text-[var(--color-bad)]">{error}</p>}
      <label className="block text-sm">
        <span className="font-medium">Text or link</span>
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          rows={5}
          maxLength={3500}
          placeholder={loaded ? "Paste a message, a link or notes…" : "Loading what was shared…"}
          className="mt-1 w-full rounded-xl border border-[var(--color-line)] bg-transparent px-3 py-2.5 text-base leading-6 outline-none focus:border-[var(--color-accent)]"
        />
      </label>

      <div className="text-sm">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-medium">Files</span>
          <button type="button" onClick={() => picker.current?.click()} className="min-h-11 rounded-full border border-[var(--color-line)] px-3.5 hover:bg-[var(--color-line)]">
            📎 Add files or photos
          </button>
          <input
            ref={picker}
            type="file"
            multiple
            hidden
            accept="image/*,application/pdf,.pdf,.docx,.pptx,.xlsx,.txt,.csv,.md"
            onChange={(e) => {
              setFiles((f) => [...f, ...Array.from(e.target.files ?? [])].slice(0, 5));
              e.target.value = "";
            }}
          />
        </div>
        {files.length > 0 && (
          <ul className="mt-2 space-y-1">
            {files.map((f, i) => (
              <li key={`${f.name}:${i}`} className="flex items-center gap-2">
                <span className="min-w-0 truncate">📄 {f.name}</span>
                <span className="shrink-0 text-xs text-[var(--color-muted)]">{Math.max(1, Math.round(f.size / 1024))} KB</span>
                <button type="button" aria-label={`Remove ${f.name}`} onClick={() => setFiles((all) => all.filter((_, j) => j !== i))} className="ml-auto inline-flex min-h-9 min-w-9 items-center justify-center rounded-full hover:bg-[var(--color-line)]">
                  ✕
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="flex flex-wrap gap-2 border-t border-[var(--color-line)] pt-4">
        <button type="button" disabled={empty || !!busy} onClick={() => void ask()} className="min-h-11 rounded-xl bg-[var(--color-accent)] px-4 text-sm font-medium text-white disabled:opacity-50">
          {busy === "ask" ? (files.length ? "Uploading…" : "Opening chat…") : "💬 Ask JARVIS"}
        </button>
      </div>

      <div className="space-y-2 border-t border-[var(--color-line)] pt-4">
        <label className="block text-sm">
          <span className="font-medium">Or keep it as a task</span>
          <input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            maxLength={300}
            placeholder="Verb + what, e.g. Read the Groww article"
            className="mt-1 min-h-11 w-full rounded-xl border border-[var(--color-line)] bg-transparent px-3 text-base outline-none focus:border-[var(--color-accent)]"
          />
        </label>
        <button type="button" disabled={empty || !title.trim() || !!busy} onClick={() => void keepAsTask()} className="min-h-11 rounded-xl border border-[var(--color-line)] px-4 text-sm font-medium hover:bg-[var(--color-line)] disabled:opacity-50">
          {busy === "task" ? "Saving…" : "✅ Add as task"}
        </button>
      </div>

      {!empty && !busy && (
        <button
          type="button"
          onClick={() => {
            void clearParked();
            setText("");
            setFiles([]);
            setTitle("");
          }}
          className="text-sm text-[var(--color-muted)] underline"
        >
          Discard
        </button>
      )}
    </div>
  );
}
