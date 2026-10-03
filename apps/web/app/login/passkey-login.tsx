"use client";

import { startAuthentication } from "@simplewebauthn/browser";
import { useState } from "react";

const primary = "w-full rounded-lg bg-[var(--color-accent)] px-4 py-2.5 font-medium text-white disabled:opacity-60";

export function PasskeyLogin() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function signIn() {
    setBusy(true);
    setError(null);
    try {
      const options = await fetch("/api/auth/passkey/login/options", { method: "POST" }).then((r) => r.json());
      const response = await startAuthentication({ optionsJSON: options });
      const r = await fetch("/api/auth/passkey/login/verify", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ response }) });
      const body = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(body.error ?? "Sign-in failed.");
      window.location.assign("/");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(/NotAllowedError|cancel|timed out/i.test(msg) ? "Cancelled. Try again." : msg);
      setBusy(false);
    }
  }

  return (
    <div className="mt-6">
      <button onClick={() => void signIn()} disabled={busy} className={primary}>
        {busy ? "Waiting for your passkey…" : "🔑 Sign in with passkey"}
      </button>
      {error && <p className="mt-3 text-sm text-[var(--color-bad)]">{error}</p>}
    </div>
  );
}

export function RecoveryLogin() {
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const r = await fetch("/api/auth/recovery", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ code }) });
    if (r.ok) return window.location.assign("/settings");
    setError(((await r.json().catch(() => ({}))) as { error?: string }).error ?? "That didn't work.");
    setBusy(false);
  }

  return (
    <form onSubmit={(e) => void submit(e)} className="mt-2 flex gap-2">
      <input
        value={code}
        onChange={(e) => setCode(e.target.value)}
        placeholder="XXXX-XXXX-XXXX"
        autoComplete="one-time-code"
        aria-label="Recovery code"
        className="min-w-0 flex-1 rounded-lg border border-[var(--color-line)] bg-transparent px-3 py-2 font-mono text-sm uppercase outline-none focus:border-[var(--color-accent)]"
      />
      <button disabled={busy || code.replace(/[^a-z0-9]/gi, "").length < 12} className="rounded-lg border border-[var(--color-line)] px-3 py-2 text-sm font-medium disabled:opacity-50">
        Use code
      </button>
      {error && <p className="basis-full text-sm text-[var(--color-bad)]">{error}</p>}
    </form>
  );
}
