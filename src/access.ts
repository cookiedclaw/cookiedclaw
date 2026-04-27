/**
 * Access control: env-based static allowlist + persistent paired users
 * + transient pairing requests with TTL.
 *
 * State lives at `~/.cookiedclaw/access.json`. The pair / revoke_access
 * / list_access MCP tools (in tools.ts) mutate this; the bot's inbound
 * handlers (in inbound.ts) consult `isAllowed` before forwarding.
 */
import { resolve } from "node:path";
import { allowAll, allowedUsers } from "./env.ts";
import { dotCookiedclaw } from "./paths.ts";

export type PairedUser = { userId: number; name: string; addedAt: number };
export type PendingPair = {
  code: string;
  userId: number;
  name: string;
  expiresAt: number;
};

const accessFile = resolve(dotCookiedclaw, "access.json");

export const pairedUsers = new Map<number, PairedUser>();

/** Pending pair requests keyed by code (lowercased). */
export const pendingPairs = new Map<string, PendingPair>();

export const PAIR_TTL_MS = 10 * 60 * 1000;

/**
 * 5 lowercase letters from a-z minus 'l'. Same alphabet as CC's
 * permission-relay codes — never reads as '1'/'I' on a phone screen.
 * ~12M possibilities; collision odds for the few pending requests we'll
 * ever have are effectively zero.
 */
export function generatePairCode(): string {
  const alphabet = "abcdefghijkmnopqrstuvwxyz";
  let code = "";
  for (let i = 0; i < 5; i++) {
    code += alphabet[Math.floor(Math.random() * alphabet.length)];
  }
  return code;
}

/** Drop expired pending pair requests from the map. Best-effort, sync. */
export function reapPending(): void {
  const now = Date.now();
  for (const [code, p] of pendingPairs) {
    if (p.expiresAt < now) pendingPairs.delete(code);
  }
}

export async function loadAccess(): Promise<void> {
  try {
    const text = await Bun.file(accessFile).text();
    const data = JSON.parse(text) as { paired?: PairedUser[] };
    for (const u of data.paired ?? []) pairedUsers.set(u.userId, u);
    console.error(
      `[telegram] loaded ${pairedUsers.size} paired user(s) from ${accessFile}`,
    );
  } catch {
    // file doesn't exist yet — fine, fresh install
  }
}

export async function saveAccess(): Promise<void> {
  await Bun.write(
    accessFile,
    JSON.stringify({ paired: [...pairedUsers.values()] }, null, 2),
  );
}

/** Three-way decision: env wildcard, env list, or persistent paired set. */
export function isAllowed(userId: number): boolean {
  if (allowAll) return true;
  if (allowedUsers.has(String(userId))) return true; // env bypass for owner
  return pairedUsers.has(userId);
}
