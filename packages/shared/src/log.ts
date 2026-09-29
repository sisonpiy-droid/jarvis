// Minimal structured logger that scrubs anything credential-shaped before it
// reaches stdout. Belt-and-braces: callers should not pass secrets at all.

const SECRET_KEY = /pass(word)?|secret|token|cookie|authorization|session|signature|key/i;
const JWT = /\beyJ[\w-]+\.[\w-]+\.[\w-]+\b/g;
const BEARER = /Bearer\s+[\w.~+/=-]+/gi;
const SIGNED_URL_QUERY = /([?&](?:Signature|X-Goog-Signature|GoogleAccessId|X-Goog-Credential)=)[^&\s"]+/gi;

export function redact(value: unknown, depth = 0): unknown {
  if (typeof value === "string") {
    return value.replace(JWT, "[jwt]").replace(BEARER, "Bearer [redacted]").replace(SIGNED_URL_QUERY, "$1[redacted]");
  }
  if (value === null || typeof value !== "object" || depth > 6) return value;
  if (value instanceof Error) return { name: value.name, message: redact(value.message, depth + 1) };
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([k, v]) => [
      k,
      SECRET_KEY.test(k) ? "[redacted]" : redact(v, depth + 1),
    ]),
  );
}

type Level = "debug" | "info" | "warn" | "error";

export function createLogger(scope: string) {
  const emit = (level: Level, msg: string, fields?: Record<string, unknown>) => {
    if (level === "debug" && !process.env.JARVIS_DEBUG) return;
    const line = { t: new Date().toISOString(), level, scope, msg: redact(msg), ...(fields ? (redact(fields) as object) : {}) };
    (level === "error" || level === "warn" ? console.error : console.log)(JSON.stringify(line));
  };
  return {
    debug: (m: string, f?: Record<string, unknown>) => emit("debug", m, f),
    info: (m: string, f?: Record<string, unknown>) => emit("info", m, f),
    warn: (m: string, f?: Record<string, unknown>) => emit("warn", m, f),
    error: (m: string, f?: Record<string, unknown>) => emit("error", m, f),
  };
}

export type Logger = ReturnType<typeof createLogger>;
