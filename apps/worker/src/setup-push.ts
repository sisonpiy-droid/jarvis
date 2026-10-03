import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { generateVapidKeys } from "@jarvis/notify";
import { loadEnv, repoRoot } from "@jarvis/shared";

// Creates the VAPID key pair push notifications are signed with, once, into .env.
// Never regenerates existing keys: every phone's subscription is bound to the public key, so changing it
// silently breaks push on all devices. The private key is never printed.
//   npm run setup:push

loadEnv();
const envFile = join(repoRoot(), ".env");
if (process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY) {
  console.log("VAPID keys already exist in .env — keeping them (devices are bound to them).");
  process.exit(0);
}
const keys = await generateVapidKeys();
const lines = existsSync(envFile) ? readFileSync(envFile, "utf8").split(/\r?\n/).filter((l) => l && !/^VAPID_(PUBLIC|PRIVATE)_KEY=/.test(l)) : [];
lines.push(`VAPID_PUBLIC_KEY=${keys.publicKey}`, `VAPID_PRIVATE_KEY=${keys.privateKey}`);
writeFileSync(envFile, lines.join("\n") + "\n", { mode: 0o600 });
console.log("Saved VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY to .env.");
console.log("Next: `npm run deploy:cloud` (Edge secret) and add VAPID_PUBLIC_KEY to Vercel, then redeploy the dashboard.");
