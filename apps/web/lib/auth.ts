import "server-only";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";

// Passwordless, single-owner login: a one-time link is sent to the owner's
// Telegram chat; clicking it sets a signed, httpOnly session cookie.

export const SESSION_COOKIE = "jarvis_session";
const SESSION_DAYS = 30;

const enc = new TextEncoder();
const b64url = (buf: ArrayBuffer | Uint8Array) =>
  btoa(String.fromCharCode(...new Uint8Array(buf as ArrayBuffer))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

async function hmac(data: string): Promise<string> {
  const secret = process.env.WEB_SESSION_SECRET;
  if (!secret || secret.length < 32) throw new Error("WEB_SESSION_SECRET is not configured");
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return b64url(await crypto.subtle.sign("HMAC", key, enc.encode(data)));
}

export async function sha256(s: string): Promise<string> {
  return b64url(await crypto.subtle.digest("SHA-256", enc.encode(s)));
}

export function randomToken(): string {
  return b64url(crypto.getRandomValues(new Uint8Array(32)));
}

export async function makeSession(): Promise<{ value: string; maxAge: number }> {
  const exp = Math.floor(Date.now() / 1000) + SESSION_DAYS * 86_400;
  return { value: `${exp}.${await hmac(`v1:${exp}`)}`, maxAge: SESSION_DAYS * 86_400 };
}

export async function verifySession(value: string | undefined): Promise<boolean> {
  if (!value) return false;
  const [exp, sig] = value.split(".");
  if (!exp || !sig || !/^\d+$/.test(exp) || Number(exp) < Date.now() / 1000) return false;
  const expected = await hmac(`v1:${exp}`);
  if (expected.length !== sig.length) return false;
  let diff = 0;
  for (let i = 0; i < sig.length; i++) diff |= expected.charCodeAt(i) ^ sig.charCodeAt(i);
  return diff === 0;
}

export async function isSignedIn(): Promise<boolean> {
  return verifySession((await cookies()).get(SESSION_COOKIE)?.value);
}

/** For pages: redirect to /login unless signed in. */
export async function requireSession(): Promise<void> {
  if (!(await isSignedIn())) redirect("/login");
}

/** The trusted public origin for login links — never taken from request headers. */
export function baseUrl(): string {
  if (process.env.WEB_BASE_URL) return process.env.WEB_BASE_URL.replace(/\/+$/, "");
  if (process.env.VERCEL_PROJECT_PRODUCTION_URL) return `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`;
  return "http://localhost:3200";
}

/** Secret path segment for the calendar feed (Google Calendar can't send cookies). Rotates with WEB_SESSION_SECRET. */
export async function calendarToken(): Promise<string> {
  return (await hmac("v1:calendar-feed")).slice(0, 32);
}

export async function calendarFeedUrl(): Promise<string> {
  return `${baseUrl()}/cal/${await calendarToken()}/mesa-classes.ics`;
}
