import { NextResponse } from "next/server";
import { SESSION_COOKIE, baseUrl } from "@/lib/auth";

export async function POST() {
  const res = NextResponse.redirect(`${baseUrl()}/login`, { status: 303 });
  res.cookies.delete(SESSION_COOKIE);
  return res;
}
