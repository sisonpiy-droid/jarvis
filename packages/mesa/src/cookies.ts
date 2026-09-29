import type { StoredCookie } from "./session-store";

// Just enough of RFC 6265 for one first-party session cookie: build the Cookie
// header for a request, and fold Set-Cookie responses back into the jar. Lets
// token refresh run anywhere `fetch` exists (Node, Deno/Supabase Edge) with no
// browser.

const nowSec = (now: number) => now / 1000;

function domainMatches(host: string, cookieDomain: string): boolean {
  const d = cookieDomain.replace(/^\./, "").toLowerCase();
  const h = host.toLowerCase();
  return h === d || h.endsWith(`.${d}`);
}

function pathMatches(reqPath: string, cookiePath: string): boolean {
  if (cookiePath === "/" || reqPath === cookiePath) return true;
  const base = cookiePath.endsWith("/") ? cookiePath : `${cookiePath}/`;
  return reqPath.startsWith(base);
}

export function isExpired(c: StoredCookie, now = Date.now()): boolean {
  return c.expires > 0 && c.expires <= nowSec(now);
}

export function cookieHeaderFor(url: string, cookies: StoredCookie[], now = Date.now()): string {
  const u = new URL(url);
  return cookies
    .filter((c) => !isExpired(c, now) && domainMatches(u.hostname, c.domain) && pathMatches(u.pathname, c.path) && (!c.secure || u.protocol === "https:"))
    .map((c) => `${c.name}=${c.value}`)
    .join("; ");
}

export function parseSetCookie(header: string, requestUrl: string, now = Date.now()): StoredCookie | null {
  const [pair, ...attrs] = header.split(";");
  const eq = pair?.indexOf("=") ?? -1;
  if (!pair || eq <= 0) return null;
  const u = new URL(requestUrl);
  const cookie: StoredCookie = {
    name: pair.slice(0, eq).trim(),
    value: pair.slice(eq + 1).trim(),
    domain: u.hostname,
    path: "/",
    expires: -1,
    httpOnly: false,
    secure: false,
    sameSite: "Lax",
  };
  let maxAge: number | null = null;
  for (const raw of attrs) {
    const [k = "", ...rest] = raw.split("=");
    const key = k.trim().toLowerCase();
    const val = rest.join("=").trim();
    if (key === "domain" && val) cookie.domain = `.${val.replace(/^\./, "")}`;
    else if (key === "path" && val.startsWith("/")) cookie.path = val;
    else if (key === "expires") {
      const t = Date.parse(val);
      if (!Number.isNaN(t)) cookie.expires = t / 1000;
    } else if (key === "max-age") maxAge = Number.parseInt(val, 10);
    else if (key === "httponly") cookie.httpOnly = true;
    else if (key === "secure") cookie.secure = true;
    else if (key === "samesite") cookie.sameSite = /^strict$/i.test(val) ? "Strict" : /^none$/i.test(val) ? "None" : "Lax";
  }
  // Max-Age wins over Expires; Max-Age<=0 means delete.
  if (maxAge !== null && Number.isFinite(maxAge)) cookie.expires = maxAge <= 0 ? 1 : nowSec(now) + maxAge;
  return cookie;
}

/** Applies Set-Cookie headers to a jar: replaces same name+domain+path, drops expired. */
export function applySetCookies(jar: StoredCookie[], setCookies: string[], requestUrl: string, now = Date.now()): StoredCookie[] {
  const norm = (d: string) => d.replace(/^\./, "");
  let next = [...jar];
  for (const h of setCookies) {
    const c = parseSetCookie(h, requestUrl, now);
    if (!c) continue;
    next = next.filter((x) => !(x.name === c.name && norm(x.domain) === norm(c.domain) && x.path === c.path));
    if (!isExpired(c, now)) next.push(c);
  }
  return next;
}
