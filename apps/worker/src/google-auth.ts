import { createHash, randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { exec } from "node:child_process";
import { loadEnv, repoRoot } from "@jarvis/shared";

// One-time: lets JARVIS add events to your Google Calendar (and nothing else — the calendar.events scope).
// You sign in and approve in your own browser; this script only receives the one-time code on localhost,
// exchanges it, and saves GOOGLE_REFRESH_TOKEN to .env. The token is never printed.
// First put GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET (an OAuth client of type "Desktop app") in .env — see docs/GOOGLE_CALENDAR.md.
//   npm run google:auth

loadEnv();
const id = process.env.GOOGLE_CLIENT_ID;
const secret = process.env.GOOGLE_CLIENT_SECRET;
if (!id || !secret) {
  console.error("Add GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET to .env first (see docs/GOOGLE_CALENDAR.md).");
  process.exit(1);
}

const verifier = randomBytes(32).toString("base64url");
const challenge = createHash("sha256").update(verifier).digest("base64url");
const state = randomBytes(16).toString("hex");

const code = await new Promise<{ code: string; redirect: string }>((resolve, reject) => {
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (url.pathname !== "/") return void res.writeHead(404).end();
    const ok = url.searchParams.get("state") === state && url.searchParams.get("code");
    res.writeHead(ok ? 200 : 400, { "Content-Type": "text/html; charset=utf-8" }).end(ok ? "<h2>JARVIS is connected to your calendar.</h2>You can close this tab." : "<h2>Something went wrong.</h2>Go back to the terminal.");
    server.close();
    if (ok) resolve({ code: url.searchParams.get("code")!, redirect: `http://127.0.0.1:${(server.address() as { port: number } | null)?.port ?? port}` });
    else reject(new Error(url.searchParams.get("error") ?? "sign-in was not completed"));
  });
  let port = 0;
  server.listen(0, "127.0.0.1", () => {
    port = (server.address() as { port: number }).port;
    const auth = new URL("https://accounts.google.com/o/oauth2/v2/auth");
    auth.search = new URLSearchParams({
      client_id: id,
      redirect_uri: `http://127.0.0.1:${port}`,
      response_type: "code",
      scope: "https://www.googleapis.com/auth/calendar.events",
      access_type: "offline",
      prompt: "consent",
      code_challenge: challenge,
      code_challenge_method: "S256",
      state,
    }).toString();
    console.log("Opening your browser to approve calendar access. If it doesn't open, copy this link into it:\n" + auth.toString());
    exec(process.platform === "win32" ? `start "" "${auth.toString()}"` : process.platform === "darwin" ? `open "${auth.toString()}"` : `xdg-open "${auth.toString()}"`);
  });
  setTimeout(() => reject(new Error("timed out after 5 minutes")), 5 * 60_000).unref();
});

const res = await fetch("https://oauth2.googleapis.com/token", {
  method: "POST",
  headers: { "Content-Type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams({ client_id: id, client_secret: secret, code: code.code, code_verifier: verifier, grant_type: "authorization_code", redirect_uri: code.redirect }),
});
const tok = (await res.json().catch(() => ({}))) as { refresh_token?: string; error?: string };
if (!res.ok || !tok.refresh_token) {
  console.error(`Google didn't return a refresh token (${tok.error ?? res.status}). Remove JARVIS at myaccount.google.com/permissions and run this again.`);
  process.exit(1);
}

const envFile = join(repoRoot(), ".env");
const lines = existsSync(envFile) ? readFileSync(envFile, "utf8").split(/\r?\n/).filter((l) => l && !/^GOOGLE_REFRESH_TOKEN=/.test(l)) : [];
lines.push(`GOOGLE_REFRESH_TOKEN=${tok.refresh_token}`);
writeFileSync(envFile, lines.join("\n") + "\n", { mode: 0o600 });
console.log("Saved GOOGLE_REFRESH_TOKEN to .env.");
console.log("Next: `npm run deploy:cloud` (so the Telegram bot can use it) and add the three GOOGLE_* values to Vercel for the web app.");
