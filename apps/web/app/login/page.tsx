import { redirect } from "next/navigation";
import { isSignedIn } from "@/lib/auth";
import { LoginForm } from "./login-form";
import { PasskeyLogin, RecoveryLogin } from "./passkey-login";

export const dynamic = "force-dynamic";

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ e?: string }> }) {
  if (await isSignedIn()) redirect("/");
  const { e } = await searchParams;
  const telegram = !!(process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID);
  return (
    <main className="mx-auto flex min-h-screen max-w-sm flex-col justify-center px-4">
      <div className="card p-6">
        <h1 className="text-2xl font-semibold tracking-tight">JARVIS</h1>
        <p className="mt-1 text-sm text-[var(--color-muted)]">Your personal chief of staff.</p>
        {e === "expired" && <p className="mt-4 rounded-lg bg-[color-mix(in_srgb,var(--color-bad)_12%,transparent)] p-3 text-sm text-[var(--color-bad)]">That link has expired or was already used. Request a new one.</p>}
        <PasskeyLogin />
        <details className="mt-5 text-sm">
          <summary className="cursor-pointer text-[var(--color-muted)]">Other ways to sign in</summary>
          <p className="mt-3 font-medium">Recovery code</p>
          <RecoveryLogin />
          {telegram && (
            <>
              <p className="mt-4 font-medium">Telegram link (legacy)</p>
              <LoginForm />
            </>
          )}
          <p className="mt-4 text-[var(--color-muted)]">
            On your laptop you can also run <code>npm run web:login-link</code> for a one-time link.
          </p>
        </details>
      </div>
    </main>
  );
}
