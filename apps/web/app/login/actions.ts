"use server";

import { db } from "@/lib/db";
import { baseUrl, randomToken, sha256 } from "@/lib/auth";

export type LoginState = { status: "idle" | "sent" | "error"; message?: string };

/** Sends a one-time login link to the owner's Telegram. Anyone can press the button; only the owner receives the link. */
export async function sendLoginLink(_prev: LoginState): Promise<LoginState> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chat = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chat) return { status: "error", message: "Telegram isn't configured on the server." };
  const sql = db();
  const [recent] = await sql`select count(*)::int as n from jarvis.login_tokens where created_at > now() - interval '10 minutes'`;
  if ((recent?.n ?? 0) >= 5) return { status: "error", message: "Too many login links requested. Try again in a few minutes." };

  const t = randomToken();
  await sql`insert into jarvis.login_tokens (token_hash, expires_at) values (${await sha256(t)}, now() + interval '10 minutes')`;
  const link = `${baseUrl()}/auth?t=${encodeURIComponent(t)}`;
  const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chat,
      parse_mode: "HTML",
      link_preview_options: { is_disabled: true },
      text: `🔐 <b>JARVIS dashboard sign-in</b>\n\n<a href="${link}">Tap here to sign in</a> (valid for 10 minutes, works once).\n\nIf you didn't request this, ignore it — nobody else can use it.`,
    }),
  });
  if (!res.ok) return { status: "error", message: "Couldn't reach Telegram. Try again." };
  return { status: "sent" };
}
