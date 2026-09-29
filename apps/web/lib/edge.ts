import "server-only";
import { baseUrl } from "./auth";

/** Starts the deliverables job (doc + filled workbook + slides). The result lands in Telegram and the dashboard. */
export async function requestRevision(assignmentId: string, instruction: string, source: "web" | "chat" = "web"): Promise<void> {
  const secret = process.env.CRON_SECRET;
  if (!secret) throw new Error("Drafting isn't configured on the server");
  const r = await fetch(`${baseUrl()}/api/jobs/deliver`, {
    method: "POST",
    headers: { Authorization: `Bearer ${secret}`, "Content-Type": "application/json" },
    body: JSON.stringify({ assignmentId, trigger: "request", instruction, source }),
  });
  if (!r.ok && r.status !== 202) throw new Error(`Revision request failed (HTTP ${r.status})`);
}

export async function requestDraft(assignmentId: string): Promise<void> {
  const secret = process.env.CRON_SECRET;
  if (!secret) throw new Error("Drafting isn't configured on the server");
  const r = await fetch(`${baseUrl()}/api/jobs/deliver`, {
    method: "POST",
    headers: { Authorization: `Bearer ${secret}`, "Content-Type": "application/json" },
    body: JSON.stringify({ assignmentId, trigger: "request" }),
  });
  if (!r.ok && r.status !== 202) throw new Error(`Draft request failed (HTTP ${r.status})`);
}
