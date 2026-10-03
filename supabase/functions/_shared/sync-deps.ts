// Shared by the mesa-sync and jarvis-tick Edge Functions (bundled into each by `npm run edge:build`).

import { GeminiProvider } from "@jarvis/ai";
import { connect, type Sql } from "@jarvis/db";
import { SupabaseStorage } from "@jarvis/files";
import { TelegramChannel } from "@jarvis/notify";
import type { Logger } from "@jarvis/shared";
import type { SyncDeps } from "@jarvis/sync";

declare const Deno: { env: { get(name: string): string | undefined } };

export const env = (k: string) => {
  const v = Deno.env.get(k);
  if (!v) throw new Error(`Missing secret ${k}`);
  return v;
};

/** Length-independent comparison so the secret can't be probed by timing. */
export function safeEqual(a: string, b: string): boolean {
  let diff = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i++) diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  return diff === 0;
}

export const authorized = (req: Request) => safeEqual(req.headers.get("authorization") ?? "", `Bearer ${env("CRON_SECRET")}`);

const opt = (k: string) => Deno.env.get(k) || null;

export function syncDeps(log: Logger): SyncDeps & { sql: Sql } {
  // SUPABASE_DB_URL, SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are provided to every Edge Function by the platform.
  const sql = connect(env("SUPABASE_DB_URL"));
  return {
    sql,
    sessionKey: env("MESA_SESSION_KEY"),
    // Legacy channel, optional: kept for rollback until Phase 11.
    channel: opt("TELEGRAM_BOT_TOKEN") && opt("TELEGRAM_CHAT_ID") ? new TelegramChannel(env("TELEGRAM_BOT_TOKEN"), env("TELEGRAM_CHAT_ID")) : null,
    // The in-app inbox always works; push and email switch on when their secrets are set.
    notify: {
      baseUrl: opt("JARVIS_WEB_URL") ?? "",
      vapid:
        opt("VAPID_PUBLIC_KEY") && opt("VAPID_PRIVATE_KEY")
          ? { publicKey: env("VAPID_PUBLIC_KEY"), privateKey: env("VAPID_PRIVATE_KEY"), subject: opt("VAPID_SUBJECT") ?? (opt("NOTIFY_EMAIL_TO") ? `mailto:${opt("NOTIFY_EMAIL_TO")}` : (opt("JARVIS_WEB_URL") ?? "")) }
          : null,
      email: opt("RESEND_API_KEY") && opt("NOTIFY_EMAIL_TO") ? { apiKey: env("RESEND_API_KEY"), to: env("NOTIFY_EMAIL_TO"), ...(opt("NOTIFY_EMAIL_FROM") ? { from: env("NOTIFY_EMAIL_FROM") } : {}) } : null,
    },
    storage: new SupabaseStorage(env("SUPABASE_URL"), env("SUPABASE_SERVICE_ROLE_KEY")),
    log,
    icsUrl: Deno.env.get("GCAL_ICS_URL") ?? null,
    // The brief's focus note: one 20-second call a day. BRIEF_AI=off (or no key) gives the fixed-template note.
    model:
      opt("GEMINI_API_KEY") && opt("BRIEF_AI") !== "off" ? new GeminiProvider(env("GEMINI_API_KEY"), opt("GEMINI_MODEL") ?? "gemini-3.6-flash", fetch, 20_000) : null,
    // Auto-draft the backlog unless AUTO_DRAFT=off (and only when an AI key is configured).
    ...(Deno.env.get("GEMINI_API_KEY") && Deno.env.get("JARVIS_WEB_URL") && Deno.env.get("AUTO_DRAFT") !== "off"
      ? {
          onNewAssignments: async (ids: string[]) => {
            for (const assignmentId of ids) {
              await fetch(`${env("JARVIS_WEB_URL")}/api/jobs/deliver`, {
                method: "POST",
                headers: { Authorization: `Bearer ${env("CRON_SECRET")}`, "Content-Type": "application/json" },
                body: JSON.stringify({ assignmentId, trigger: "auto" }),
              });
            }
          },
        }
      : {}),
  };
}
