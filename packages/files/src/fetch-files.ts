import type { Sql } from "@jarvis/db";
import type { MesaClient } from "@jarvis/mesa";
import type { Logger } from "@jarvis/shared";
import { extractOfficeText, officeKind } from "./office-text";
import { extractPdfText, isPdf } from "./pdf-text";
import type { BlobStorage } from "./storage";

// Downloads LMS attachments into Storage a few at a time, so each sync stays
// short and the backlog drains in the background. Content-addressed by sha256:
// the same PDF attached to three assignments is stored once.

export interface FetchBudget {
  maxFiles: number;
  maxBytes: number;
  maxMs: number;
  maxFileBytes: number;
}

export const DEFAULT_BUDGET: FetchBudget = { maxFiles: 6, maxBytes: 40 * 2 ** 20, maxMs: 45_000, maxFileBytes: 25 * 2 ** 20 };

export interface FetchDeps {
  sql: Sql;
  client: MesaClient;
  storage: BlobStorage;
  /** Signed URLs seen in this run's snapshot ("<kind>:<itemId>:<attachmentId>"). */
  signedUrls: Record<string, string>;
  log?: Logger;
  fetch?: typeof fetch;
}

export interface FetchResult {
  fetched: number;
  deduped: number;
  failed: number;
  bytes: number;
  pending: number;
}

/** Registers every downloadable attachment we know about. Idempotent. */
export async function registerAttachments(sql: Sql): Promise<void> {
  await sql`
    insert into jarvis.item_files (kind, item_id, attachment_id, title)
    select 'assignment', i.source_id, m ->> 'sourceId', m ->> 'title'
      from jarvis.lms_items i, jsonb_array_elements(i.data -> 'materials') m
     where i.kind = 'assignment' and i.removed_at is null and m ->> 'kind' not in ('link', 'text')
    union all
    select 'material', i.source_id, i.source_id, i.title
      from jarvis.lms_items i
     where i.kind = 'material' and i.removed_at is null and (i.data ->> 'downloadable')::boolean
    union all
    select i.kind, i.source_id, a ->> 'sourceId', coalesce(a ->> 'fileName', a ->> 'title')
      from jarvis.lms_items i, jsonb_array_elements(i.data -> 'attachments') a
     where i.kind in ('announcement', 'event') and i.removed_at is null
    on conflict do nothing`;
}

const extOf = (name: string | null) => name?.match(/\.([a-z0-9]{1,8})$/i)?.[1]?.toLowerCase() ?? "bin";

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes as Uint8Array<ArrayBuffer>));
  return [...d].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function fetchPendingFiles(deps: FetchDeps, budget: FetchBudget = DEFAULT_BUDGET): Promise<FetchResult> {
  const { sql, log } = deps;
  const fetchImpl = deps.fetch ?? fetch;
  const started = Date.now();
  const res: FetchResult = { fetched: 0, deduped: 0, failed: 0, bytes: 0, pending: 0 };
  await registerAttachments(sql);

  // Assignment briefs first, then class material, newest first.
  const todo = await sql`
    select f.kind, f.item_id, f.attachment_id, f.title, f.attempts, i.data
      from jarvis.item_files f
      join jarvis.lms_items i on i.kind = f.kind and i.source_id = f.item_id
     where f.status = 'pending' or (f.status = 'failed' and f.attempts < 3)
     order by case f.kind when 'assignment' then 0 when 'material' then 1 when 'announcement' then 2 else 3 end,
              i.sort_at desc nulls last
     limit ${budget.maxFiles}`;

  for (const t of todo) {
    if (Date.now() - started > budget.maxMs || res.bytes > budget.maxBytes) break;
    const key = { kind: t.kind as string, item: t.item_id as string, att: t.attachment_id as string };
    const fail = async (msg: string, final = false) => {
      res.failed++;
      await sql`
        update jarvis.item_files set attempts = attempts + 1, last_error = ${msg.slice(0, 300)},
               status = case when ${final} or attempts + 1 >= 3 then 'failed' else 'pending' end
         where kind = ${key.kind} and item_id = ${key.item} and attachment_id = ${key.att}`;
    };
    try {
      // 1. A fresh signed URL: course materials have their own endpoint; others came with this run's data.
      let url: string | undefined;
      if (key.kind === "material") {
        url = (await deps.client.get<{ data?: { url?: string } }>(`/content/materials/${encodeURIComponent(key.att)}/signed-url`)).data?.url;
      } else url = deps.signedUrls[`${key.kind}:${key.item}:${key.att}`];
      if (!url) {
        await fail("no download URL in this run");
        continue;
      }

      // 2. Download (no credentials: the URL itself is the short-lived grant).
      const r = await fetchImpl(url);
      if (!r.ok) {
        await fail(`download HTTP ${r.status}`);
        continue;
      }
      const declared = Number(r.headers.get("content-length") ?? 0);
      if (declared > budget.maxFileBytes) {
        await sql`update jarvis.item_files set status = 'skipped', last_error = ${`too large: ${declared} bytes`} where kind = ${key.kind} and item_id = ${key.item} and attachment_id = ${key.att}`;
        continue;
      }
      const bytes = new Uint8Array(await r.arrayBuffer());
      res.bytes += bytes.length;
      const sha = await sha256Hex(bytes);

      // 3. Store once per distinct content.
      const [known] = await sql`select 1 from jarvis.files where sha256 = ${sha}`;
      if (known) res.deduped++;
      else {
        const data = t.data as Record<string, unknown>;
        const att =
          key.kind === "material"
            ? data
            : ((data[key.kind === "assignment" ? "materials" : "attachments"] as Array<Record<string, unknown>>) ?? []).find((a) => a.sourceId === key.att) ?? {};
        const fileName = (att.fileName as string | null) ?? (t.title as string | null);
        const mime = r.headers.get("content-type") ?? "application/octet-stream";
        const path = `mesa/${sha.slice(0, 2)}/${sha}.${extOf(fileName)}`;
        await deps.storage.upload(path, bytes, mime);
        const office = officeKind(fileName, mime);
        let status: "done" | "original" | "unsupported" | "failed" = office ? "done" : /pdf|image\//i.test(mime) || /\.(pdf|png|jpe?g)$/i.test(fileName ?? "") ? "original" : "unsupported";
        let text: string | null = null;
        if (office) {
          try {
            text = extractOfficeText(bytes, office);
          } catch (e) {
            status = "failed";
            log?.warn("text extraction failed", { file: fileName, error: e });
          }
        } else if (isPdf(fileName, mime)) {
          // A PDF without a text layer (scanned) stays 'original'; a broken one is still stored.
          try {
            text = await extractPdfText(bytes);
            if (text) status = "done";
          } catch (e) {
            log?.warn("pdf text extraction failed", { file: fileName, error: e });
          }
        }
        await sql`
          insert into jarvis.files (sha256, storage_path, mime_type, size_bytes, original_filename, text_status, text_content)
          values (${sha}, ${path}, ${mime}, ${bytes.length}, ${fileName}, ${status}, ${text})
          on conflict (sha256) do nothing`;
        res.fetched++;
      }
      await sql`
        update jarvis.item_files set sha256 = ${sha}, status = 'done', fetched_at = now(), last_error = null
         where kind = ${key.kind} and item_id = ${key.item} and attachment_id = ${key.att}`;
    } catch (err) {
      if ((err as { name?: string }).name === "MesaAuthError") throw err;
      await fail(err instanceof Error ? err.message : String(err));
    }
  }
  const [p] = await sql`select count(*)::int as n from jarvis.item_files where status = 'pending' or (status = 'failed' and attempts < 3)`;
  res.pending = p?.n ?? 0;
  return res;
}
