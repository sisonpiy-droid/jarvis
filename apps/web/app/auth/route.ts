import { NextResponse, type NextRequest } from "next/server";
import { db } from "@/lib/db";
import { SESSION_COOKIE, baseUrl, makeSession, sha256 } from "@/lib/auth";

export const dynamic = "force-dynamic";

/** Consumes a one-time login token (single use, 10-minute expiry) and sets the session cookie. */
export async function GET(req: NextRequest) {
  const t = req.nextUrl.searchParams.get("t") ?? "";
  if (t.length < 20) return NextResponse.redirect(`${baseUrl()}/login?e=expired`);
  const rows = await db()`
    update jarvis.login_tokens set used_at = now()
     where token_hash = ${await sha256(t)} and used_at is null and expires_at > now()
    returning token_hash`;
  if (!rows.length) return NextResponse.redirect(`${baseUrl()}/login?e=expired`);
  const s = await makeSession();
  const res = NextResponse.redirect(`${baseUrl()}/`);
  res.cookies.set(SESSION_COOKIE, s.value, { httpOnly: true, secure: baseUrl().startsWith("https"), sameSite: "lax", path: "/", maxAge: s.maxAge });
  return res;
}
