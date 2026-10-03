import type { Sql } from "./client";

// Passkeys and recovery codes for the single owner. Only public keys and code hashes are stored.

export interface PasskeyRow {
  credentialId: string;
  publicKey: Uint8Array;
  counter: number;
  transports: string[];
  deviceName: string;
  backedUp: boolean;
  createdAt: string;
  lastUsedAt: string | null;
}

const iso = (v: unknown) => (v ? new Date(v as string).toISOString() : null);
const toPasskey = (r: Record<string, unknown>): PasskeyRow => ({
  credentialId: String(r.credential_id),
  publicKey: new Uint8Array(r.public_key as Uint8Array),
  counter: Number(r.counter),
  transports: (r.transports as string[] | null) ?? [],
  deviceName: String(r.device_name),
  backedUp: r.backed_up === true,
  createdAt: iso(r.created_at)!,
  lastUsedAt: iso(r.last_used_at),
});

export async function listPasskeys(sql: Sql): Promise<PasskeyRow[]> {
  return (await sql`select * from jarvis.passkeys order by created_at`).map(toPasskey);
}

export async function getPasskey(sql: Sql, credentialId: string): Promise<PasskeyRow | null> {
  const [r] = await sql`select * from jarvis.passkeys where credential_id = ${credentialId}`;
  return r ? toPasskey(r) : null;
}

export async function savePasskey(sql: Sql, p: { credentialId: string; publicKey: Uint8Array; counter: number; transports: string[]; deviceName: string; backedUp: boolean }): Promise<void> {
  await sql`
    insert into jarvis.passkeys (credential_id, public_key, counter, transports, device_name, backed_up)
    values (${p.credentialId}, ${Buffer.from(p.publicKey)}, ${p.counter}, ${p.transports}, ${p.deviceName.slice(0, 60)}, ${p.backedUp})`;
}

/** Records a successful sign-in; the counter only moves forward (clone detection for authenticators that count). */
export async function touchPasskey(sql: Sql, credentialId: string, newCounter: number): Promise<void> {
  await sql`update jarvis.passkeys set counter = greatest(counter, ${newCounter}), last_used_at = now() where credential_id = ${credentialId}`;
}

export async function renamePasskey(sql: Sql, credentialId: string, name: string): Promise<void> {
  await sql`update jarvis.passkeys set device_name = ${name.slice(0, 60)} where credential_id = ${credentialId}`;
}

export async function deletePasskey(sql: Sql, credentialId: string): Promise<void> {
  await sql`delete from jarvis.passkeys where credential_id = ${credentialId}`;
}

/** Replaces all recovery codes with new ones (hashes only). */
export async function replaceRecoveryCodes(sql: Sql, hashes: string[]): Promise<void> {
  await sql.begin(async (tx) => {
    await tx`delete from jarvis.recovery_codes`;
    for (const h of hashes) await tx`insert into jarvis.recovery_codes (code_hash) values (${h})`;
  });
}

/** Uses up one code. True only the first time a valid code is presented. */
export async function consumeRecoveryCode(sql: Sql, hash: string): Promise<boolean> {
  const rows = await sql`update jarvis.recovery_codes set used_at = now() where code_hash = ${hash} and used_at is null returning code_hash`;
  return rows.length === 1;
}

export async function recoveryCodesLeft(sql: Sql): Promise<number> {
  const [r] = await sql`select count(*)::int as n from jarvis.recovery_codes where used_at is null`;
  return Number(r?.n ?? 0);
}
