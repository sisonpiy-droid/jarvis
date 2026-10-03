"use client";

// Sharing files to JARVIS from the browser: ask the server for a one-time upload URL, PUT the file straight to
// Storage, then have the server store it and read its text. Used by the share page and 📎 in chat.

export interface SharedFile {
  fileId: string;
  name: string;
  textStatus: string;
  chars: number;
}

const json = async <T,>(r: Response): Promise<T> => {
  const j = (await r.json().catch(() => ({}))) as T & { error?: string };
  if (!r.ok) throw new Error(j.error ?? `HTTP ${r.status}`);
  return j;
};

export async function uploadShared(file: File): Promise<SharedFile> {
  const { uploadUrl, path } = await json<{ uploadUrl: string; path: string }>(
    await fetch("/api/files/upload-url", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: file.name, size: file.size }) }),
  );
  const put = await fetch(uploadUrl, { method: "PUT", headers: { "Content-Type": file.type || "application/octet-stream", "x-upsert": "false" }, body: file });
  if (!put.ok) throw new Error(`Upload failed (HTTP ${put.status})`);
  return json<SharedFile>(await fetch("/api/files/ingest", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ path, name: file.name, type: file.type }) }));
}

/** The line a chat message carries for a shared file; the model reads it with read_file_text. */
export const sharedLine = (f: SharedFile) => `📎 Shared file: ${f.name} (file_id: ${f.fileId})${f.textStatus === "done" ? "" : " — no readable text"}`;

/** A chat draft handed from another page (the share page) to the chat box. */
export const CHAT_DRAFT_KEY = "jarvis-chat-draft";
