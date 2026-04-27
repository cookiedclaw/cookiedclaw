/**
 * Filesystem paths cookiedclaw uses, plus the shared diagnostic log.
 *
 * Per-workspace philosophy: everything lives under the user's working
 * directory (the dir CC was launched from), not in $HOME. That way each
 * workspace is a self-contained agent — its own bot token, identity,
 * pairing list, attachments — and the workspace CLAUDE.md gets injected
 * by CC as the agent's system prompt automatically.
 *
 *   ./CLAUDE.md, BOOTSTRAP.md, IDENTITY.md, USER.md, SOUL.md  ← agent-visible
 *   ./.cookiedclaw/keys.env, access.json                       ← hidden state
 *   ./.cookiedclaw/inbox/<files>                                ← inbound attachments
 *   ./.cookiedclaw/cache/progress.{port,log}                    ← runtime cache
 *
 * Cache + inbox dirs are created lazily so a fresh workspace doesn't
 * crash the channel.
 */
import { appendFile, mkdirSync } from "node:fs";
import { resolve } from "node:path";

/** Workspace root — whatever directory CC was launched from. */
export const workspaceRoot = process.cwd();

/** Hidden state directory. Holds keys, access.json, inbox, cache. */
export const dotCookiedclaw = resolve(workspaceRoot, ".cookiedclaw");

/** Runtime cache — port file, debug log. */
export const cacheDir = resolve(dotCookiedclaw, "cache");

/** Where we stash inbound Telegram photos / documents for CC to Read. */
export const inboxDir = resolve(dotCookiedclaw, "inbox");

/** Channel server writes its progress-server port here at startup; hooks read it. */
export const portFile = resolve(cacheDir, "progress.port");

/**
 * `/stop` flag. The channel server writes a Date.now() string when a
 * user presses /stop; the PreToolUse hook reads it and blocks
 * non-reply/react tools so CC physically can't keep working. Cleared
 * by the next user inbound (forwardToCC).
 */
export const stopFlag = resolve(cacheDir, "stop.flag");

/**
 * Pending-chat / active-chat snapshot. Written every time `pendingChats`
 * or `activeChatId` mutates, read on startup. Lets the channel survive
 * its own restart (daemon kick, MCP stdio respawn, plain crash + CC
 * `--resume`) without dropping the in-flight chat — without this, every
 * tool event after a restart logs `pending=[none]` and the user sees no
 * typing/progress until they send a fresh inbound. See `chat-state.ts`.
 */
export const pendingFile = resolve(cacheDir, "pending.json");

/**
 * Append-only diagnostic log shared between the channel server and the
 * Pre/PostToolUse hook script. Lets us debug "why didn't the typing
 * indicator update" without flipping CC's debug-log toggle.
 */
export const debugLog = resolve(cacheDir, "progress.log");

mkdirSync(dotCookiedclaw, { recursive: true });
mkdirSync(cacheDir, { recursive: true });
mkdirSync(inboxDir, { recursive: true });

/** Append a tagged line to {@link debugLog}. Best-effort, never throws. */
export function dlog(line: string): void {
  appendFile(
    debugLog,
    `[${new Date().toISOString()}] [server] ${line}\n`,
    () => {},
  );
}
