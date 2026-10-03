// Email through Resend's REST API (free tier: sends to the account's own address without a custom domain).
// Plain fetch — no SDK, runs in Edge and Node.

export interface EmailConfig {
  apiKey: string;
  to: string;
  /** Default works without a verified domain (delivers only to the Resend account owner). */
  from?: string;
}

export interface EmailMessage {
  subject: string;
  html: string;
  text: string;
}

export async function sendEmail(cfg: EmailConfig, msg: EmailMessage, fetchImpl: typeof fetch = fetch): Promise<string> {
  const res = await fetchImpl("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${cfg.apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from: cfg.from || "JARVIS <onboarding@resend.dev>", to: [cfg.to], subject: msg.subject.slice(0, 200), html: msg.html, text: msg.text }),
  });
  const body = (await res.json().catch(() => ({}))) as { id?: string; message?: string; name?: string };
  // Never echo request headers: they hold the API key.
  if (!res.ok) throw new Error(`Email failed: HTTP ${res.status} ${body.message ?? body.name ?? ""}`.trim());
  return body.id ?? "";
}

/** A minimal, client-safe HTML email around already-sanitised content. */
export function emailHtml(title: string, bodyHtml: string, link: string | null): string {
  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  return [
    `<div style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;font-size:15px;line-height:1.5;color:#111;max-width:560px">`,
    `<p style="margin:0 0 4px;font-size:12px;color:#666">JARVIS</p>`,
    `<div>${bodyHtml}</div>`,
    link ? `<p style="margin:20px 0 0"><a href="${esc(link)}" style="color:#2563eb">Open in JARVIS →</a></p>` : "",
    `<p style="margin:24px 0 0;font-size:12px;color:#888">${esc(title)} · change what reaches your inbox in JARVIS → Settings.</p>`,
    `</div>`,
  ].join("");
}
