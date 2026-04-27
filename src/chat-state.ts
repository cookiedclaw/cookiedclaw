/**
 * Per-chat runtime state: tool-event log, progress message id, typing
 * timers, plus the `pendingChats` set and an edit-serializing queue.
 *
 * Tool-progress hooks fire without chat correlation, so we BROADCAST
 * to every chat in `pendingChats`. Each chat keeps its own copy of
 * the events list — when one gets a reply and its events reset, the
 * others aren't disturbed.
 *
 * `pendingChats` and `activeChatId` are also persisted to disk
 * (`pendingFile`) so the channel survives its own restart without
 * losing the in-flight chat. Without persistence, a daemon kick / MCP
 * respawn / crash + CC `--resume` produces tool events with no chat
 * to fan them out to.
 */
import { readFile, writeFile } from "node:fs/promises";
import { bot } from "./bot.ts";
import { dlog, pendingFile } from "./paths.ts";

export type ToolEvent = {
  toolUseId: string;
  toolName: string;
  inputSummary: string;
  status: "running" | "done" | "error";
  durationMs?: number;
  errorText?: string;
};

export type ChatState = {
  /** Telegram message_id of the live progress block (we edit this in place). */
  progressMessageId?: number;
  events: ToolEvent[];
  /** Active "typing…" indicator handles, cleared on reply or failsafe. */
  typing?: {
    interval: ReturnType<typeof setInterval>;
    failsafe: ReturnType<typeof setTimeout>;
  };
};

export const chats = new Map<string, ChatState>();

/**
 * Every chat with an unanswered message lives here. Hook events fan
 * out to all of them so users with queued messages see "the bot is
 * working" instead of silently waiting. A chat leaves the set when
 * CC calls `reply` or `react` for it.
 */
export const pendingChats = new Set<string>();

/**
 * Last-inbound chat id, used ONLY for routing permission relay prompts
 * (we have to send the Allow/Deny buttons SOMEWHERE, and the most
 * recently inbound chat is the closest proxy for "whose turn CC is
 * processing"). Progress / typing use the broader pendingChats set.
 */
export let activeChatId: string | undefined;
export function setActiveChatId(chatId: string): void {
  activeChatId = chatId;
  schedulePersist();
}

/**
 * Add a chat to `pendingChats` and persist. Use this instead of
 * `pendingChats.add` directly so a server restart doesn't lose the
 * in-flight set — see file header.
 */
export function addPending(chatId: string): void {
  pendingChats.add(chatId);
  schedulePersist();
}

/**
 * Remove a chat from `pendingChats` and persist. Currently unused (the
 * Stop hook deliberately keeps chats pending so post-stop tool events
 * still fan out — see progress.ts). Exposed for symmetry and future
 * use.
 */
export function removePending(chatId: string): void {
  if (pendingChats.delete(chatId)) schedulePersist();
}

// -----------------------------------------------------------------------------
// Disk persistence (pendingChats + activeChatId)
// -----------------------------------------------------------------------------

let persistTimer: ReturnType<typeof setTimeout> | undefined;
const PERSIST_DEBOUNCE_MS = 50;

/**
 * Coalesce rapid mutations into one write — a burst of `addPending`
 * calls on a multi-attachment inbound shouldn't trigger 5 fsyncs.
 */
function schedulePersist(): void {
  if (persistTimer) return;
  persistTimer = setTimeout(() => {
    persistTimer = undefined;
    void persistNow();
  }, PERSIST_DEBOUNCE_MS);
}

async function persistNow(): Promise<void> {
  try {
    await writeFile(
      pendingFile,
      JSON.stringify({
        pending: [...pendingChats],
        active: activeChatId ?? null,
      }),
    );
  } catch (err) {
    // Disk full / read-only mount / etc. Don't crash the channel — the
    // worst-case fallback is "lose pending state on next restart",
    // which is what we already have today.
    dlog(
      `pending persist failed: ${err instanceof Error ? err.message : err}`,
    );
  }
}

/**
 * Read `pendingFile` back into `pendingChats` + `activeChatId`. Call
 * once at startup, before MCP/bot init, so the very first tool event
 * after a restart sees the right state. Idempotent and tolerant of a
 * missing/corrupt file (treats it as an empty starting point).
 */
export async function loadPending(): Promise<void> {
  try {
    const raw = await readFile(pendingFile, "utf8");
    const data = JSON.parse(raw) as {
      pending?: unknown;
      active?: unknown;
    };
    if (Array.isArray(data.pending)) {
      for (const id of data.pending) {
        if (typeof id === "string") pendingChats.add(id);
      }
    }
    if (typeof data.active === "string") {
      activeChatId = data.active;
    }
    dlog(
      `pending state loaded: pending=[${[...pendingChats].join(",") || "none"}] active=${activeChatId ?? "none"}`,
    );
  } catch (err) {
    if (
      err instanceof Error &&
      "code" in err &&
      (err as NodeJS.ErrnoException).code === "ENOENT"
    ) {
      // First run for this workspace, nothing to load.
      return;
    }
    dlog(
      `pending state load failed (treating as empty): ${err instanceof Error ? err.message : err}`,
    );
  }
}

// -----------------------------------------------------------------------------
// Edit serialization
// -----------------------------------------------------------------------------

const editQueues = new Map<string, Promise<unknown>>();

/**
 * Serialize Telegram edits per chat so concurrent hook events don't race
 * the API and produce out-of-order updates.
 */
export function queueEdit<T>(
  chatId: string,
  fn: () => Promise<T>,
): Promise<T> {
  const prev = editQueues.get(chatId) ?? Promise.resolve();
  const next = prev.catch(() => {}).then(fn);
  editQueues.set(
    chatId,
    next.catch(() => {}),
  );
  return next;
}

// -----------------------------------------------------------------------------
// Typing indicator (per-chat lifetime, refreshed every 4.5s)
// -----------------------------------------------------------------------------

/**
 * Telegram's `sendChatAction("typing")` signal lasts ~5 seconds, so we
 * refresh it every 4.5s while CC is working. Started on inbound and
 * cleared by `reply`/`react`/`/stop` (or by a 5-minute failsafe if
 * none of those fire).
 */
export function startTyping(chatId: string): void {
  const state = chats.get(chatId);
  if (!state || state.typing) return;
  const ping = () => {
    bot.api.sendChatAction(Number(chatId), "typing").catch(() => {});
  };
  ping();
  const interval = setInterval(ping, 4500);
  const failsafe = setTimeout(() => stopTyping(chatId), 5 * 60 * 1000);
  state.typing = { interval, failsafe };
}

export function stopTyping(chatId: string): void {
  const state = chats.get(chatId);
  if (!state?.typing) return;
  clearInterval(state.typing.interval);
  clearTimeout(state.typing.failsafe);
  state.typing = undefined;
}
