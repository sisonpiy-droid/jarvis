"use client";

import { startRegistration } from "@simplewebauthn/browser";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { deviceLabel } from "@/lib/pwa-client";

export interface PasskeyView {
  id: string;
  name: string;
  createdAt: string;
  lastUsedAt: string | null;
  synced: boolean;
}

const btn = "rounded-lg px-3 py-1.5 text-sm font-medium disabled:opacity-50";
const when = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" }) : "never");

export function Passkeys({ passkeys, codesLeft }: { passkeys: PasskeyView[]; codesLeft: number }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [codes, setCodes] = useState<string[] | null>(null);

  async function add() {
    setBusy(true);
    setError(null);
    try {
      const options = await fetch("/api/auth/passkey/register/options", { method: "POST" }).then((r) => r.json());
      if (options.error) throw new Error(options.error);
      const response = await startRegistration({ optionsJSON: options });
      const r = await fetch("/api/auth/passkey/register/verify", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ response, name: deviceLabel() }) }).then((x) => x.json());
      if (r.error) throw new Error(r.error);
      if (r.recoveryCodes) setCodes(r.recoveryCodes);
      router.refresh();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(/NotAllowedError|cancel|timed out/i.test(msg) ? "Cancelled." : /InvalidStateError|already registered/i.test(msg) ? "This device already has a JARVIS passkey." : msg);
    } finally {
      setBusy(false);
    }
  }

  async function remove(id: string) {
    if (!confirm("Remove this passkey? You won't be able to sign in with it any more.")) return;
    setBusy(true);
    await fetch(`/api/auth/passkey/${encodeURIComponent(id)}`, { method: "DELETE" });
    setBusy(false);
    router.refresh();
  }

  async function regenerate() {
    if (!confirm("Create new recovery codes? The old ones stop working.")) return;
    setBusy(true);
    const r = await fetch("/api/auth/recovery/regenerate", { method: "POST" }).then((x) => x.json());
    setBusy(false);
    if (r.recoveryCodes) setCodes(r.recoveryCodes);
    router.refresh();
  }

  return (
    <div className="space-y-3 text-sm">
      {passkeys.length === 0 ? (
        <p className="text-[var(--color-muted)]">No passkeys yet. Add one on each phone and laptop you use. Then you sign in with Face ID, a fingerprint or your PIN, with no Telegram needed.</p>
      ) : (
        <ul className="divide-y divide-[var(--color-line)]">
          {passkeys.map((p) => (
            <li key={p.id} className="flex flex-wrap items-center gap-2 py-2">
              <span className="font-medium">🔑 {p.name}</span>
              {p.synced && <span className="text-xs text-[var(--color-muted)]">synced</span>}
              <span className="text-[var(--color-muted)]">
                added {when(p.createdAt)} · last used {when(p.lastUsedAt)}
              </span>
              <button onClick={() => void remove(p.id)} disabled={busy} className="ml-auto text-[var(--color-bad)] disabled:opacity-50">
                Remove
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <button onClick={() => void add()} disabled={busy} className={`${btn} bg-[var(--color-accent)] text-white`}>
          Add a passkey on this device
        </button>
        <span className="text-[var(--color-muted)]">
          Recovery codes left: <b>{codesLeft}</b>
        </span>
        <button onClick={() => void regenerate()} disabled={busy} className={`${btn} border border-[var(--color-line)]`}>
          New recovery codes
        </button>
      </div>
      {error && <p className="text-[var(--color-bad)]">{error}</p>}
      {codes && (
        <div className="rounded-lg border border-[var(--color-warn)] p-3">
          <p className="font-medium">Save these recovery codes now. They won&apos;t be shown again.</p>
          <p className="mt-1 text-[var(--color-muted)]">Each one signs you in once if you lose your devices. Keep them somewhere safe (a password manager or a printout), not in chat.</p>
          <pre className="mt-2 grid grid-cols-2 gap-1 font-mono text-sm">{codes.map((c) => <span key={c}>{c}</span>)}</pre>
          <button onClick={() => void navigator.clipboard.writeText(codes.join("\n"))} className={`${btn} mt-2 border border-[var(--color-line)]`}>
            Copy codes
          </button>
        </div>
      )}
    </div>
  );
}
