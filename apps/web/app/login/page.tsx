import { redirect } from "next/navigation";
import { isSignedIn } from "@/lib/auth";
import { LoginForm } from "./login-form";

export const dynamic = "force-dynamic";

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ e?: string }> }) {
  if (await isSignedIn()) redirect("/");
  const { e } = await searchParams;
  return (
    <main className="mx-auto flex min-h-screen max-w-sm flex-col justify-center px-4">
      <div className="card p-6">
        <h1 className="text-2xl font-semibold tracking-tight">JARVIS</h1>
        <p className="mt-1 text-sm text-[var(--color-muted)]">Your MESA chief of staff.</p>
        {e === "expired" && <p className="mt-4 rounded-lg bg-[color-mix(in_srgb,var(--color-bad)_12%,transparent)] p-3 text-sm text-[var(--color-bad)]">That link has expired or was already used. Request a new one.</p>}
        <LoginForm />
      </div>
    </main>
  );
}
