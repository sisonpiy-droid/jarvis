import "server-only";

/** Asks the assignment-draft Edge Function to draft (fire-and-forget; the result lands in Telegram and the dashboard). */
export async function requestDraft(assignmentId: string): Promise<void> {
  const base = process.env.SUPABASE_URL;
  const secret = process.env.CRON_SECRET;
  if (!base || !secret) throw new Error("Drafting isn't configured on the server");
  const r = await fetch(`${base}/functions/v1/assignment-draft`, {
    method: "POST",
    headers: { Authorization: `Bearer ${secret}`, "Content-Type": "application/json" },
    body: JSON.stringify({ assignmentId, trigger: "request" }),
  });
  if (!r.ok && r.status !== 202) throw new Error(`Draft request failed (HTTP ${r.status})`);
}
