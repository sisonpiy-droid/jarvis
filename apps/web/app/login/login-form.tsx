"use client";

import { useActionState } from "react";
import { sendLoginLink, type LoginState } from "./actions";

export function LoginForm() {
  const [state, action, pending] = useActionState<LoginState, FormData>(sendLoginLink, { status: "idle" });
  if (state.status === "sent") {
    return (
      <p className="mt-6 rounded-lg bg-[color-mix(in_srgb,var(--color-good)_12%,transparent)] p-3 text-sm">
        ✅ Sent. Open <b>Telegram</b> and tap the link from your JARVIS bot.
      </p>
    );
  }
  return (
    <form action={action} className="mt-6">
      <button
        type="submit"
        disabled={pending}
        className="w-full rounded-lg bg-[var(--color-accent)] px-4 py-2.5 font-medium text-white disabled:opacity-60"
      >
        {pending ? "Sending…" : "Send me a login link on Telegram"}
      </button>
      {state.status === "error" && <p className="mt-3 text-sm text-[var(--color-bad)]">{state.message}</p>}
    </form>
  );
}
