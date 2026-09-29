import { chromium } from "playwright-core";
import { MESA_LOGIN_URL, MESA_WEB_ORIGIN } from "./config";
import { MesaAuthError } from "./auth";
import { filterMesaCookies, type SessionState, type StoredCookie } from "./session-store";

// Node-only: needs a real browser. Not exported from ./index so the Edge
// bundle never pulls in Playwright. Import from "@jarvis/mesa/login".

export interface InteractiveLoginOptions {
  channel?: string;
  timeoutMs?: number;
  onStatus?: (msg: string) => void;
}

/**
 * Opens a real, visible browser on the MESA login page and waits for the user
 * to sign in themselves (including any OTP). JARVIS never types or reads the
 * password; it only captures the resulting cookies once the student area loads.
 */
export async function interactiveLogin(opts: InteractiveLoginOptions = {}): Promise<SessionState> {
  const timeoutMs = opts.timeoutMs ?? 10 * 60_000;
  const channel = opts.channel && opts.channel !== "chromium" ? opts.channel : undefined;
  const browser = await chromium.launch({ headless: false, ...(channel ? { channel } : {}) });
  try {
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto(MESA_LOGIN_URL);
    opts.onStatus?.("Sign in to MESA in the browser window that just opened. Waiting…");
    try {
      await page.waitForURL((u) => u.origin === MESA_WEB_ORIGIN && u.pathname.startsWith("/student"), { timeout: timeoutMs });
    } catch {
      throw new MesaAuthError("Timed out waiting for sign-in to finish", "LOGIN_TIMEOUT");
    }
    const state = await context.storageState();
    const cookies = filterMesaCookies(state.cookies as StoredCookie[]);
    if (!cookies.length) throw new MesaAuthError("Signed in, but no MESA session cookie was set", "NO_SESSION");
    return { cookies, origins: [], savedAt: new Date().toISOString() };
  } finally {
    await browser.close();
  }
}
