import { existsSync } from "node:fs";
import { join } from "node:path";
import type { NextConfig } from "next";

// Local dev reads the repo-root .env (on Vercel, env vars come from the project settings).
const rootEnv = join(process.cwd(), "..", "..", ".env");
if (!process.env.VERCEL && existsSync(rootEnv)) process.loadEnvFile(rootEnv);

const config: NextConfig = {
  // Workspace packages ship TypeScript source.
  transpilePackages: ["@jarvis/ai", "@jarvis/assist", "@jarvis/calendar", "@jarvis/notify", "@jarvis/deliver", "@jarvis/db", "@jarvis/files", "@jarvis/shared"],
  poweredByHeader: false,
  // Loaded at runtime from node_modules rather than bundled.
  serverExternalPackages: ["postgres"],
  async headers() {
    return [
      {
        // The service worker must always be fresh, and may control the whole app.
        source: "/sw.js",
        headers: [
          { key: "Cache-Control", value: "no-cache, no-store, must-revalidate" },
          { key: "Content-Type", value: "application/javascript; charset=utf-8" },
          { key: "Service-Worker-Allowed", value: "/" },
        ],
      },
      {
        source: "/(.*)",
        headers: [
          { key: "X-Frame-Options", value: "DENY" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "no-referrer" },
          { key: "Permissions-Policy", value: "camera=(), microphone=(self), geolocation=()" },
        ],
      },
    ];
  },
};

export default config;
