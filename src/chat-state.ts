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

/**
 * Drop "running" tool events from every chat's state, plus the
 * progress message id those events were rendering into. Called by the
 * supervisor on every MCP session-init.
 *
 * Why this matters: a `running` event is created by `applyEvent` on
 * PreToolUse and cleared on PostToolUse. If claude dies between pre
 * and post (heartbeat force-closed the transport mid-tool, supervisor
 * killed the child, gateway briefly unreachable from the hook script,
 * or the hook subprocess errored on POST), the post never lands and
 * the `running` event sits in the events list. When CC reboots and
 * resumes processing the queued user message WITHOUT a new inbound
 * (so forwardToCC's reset doesn't fire), the next PreToolUse appends
 * to a list that still shows "⏳ Bash: ..." stuck on running, and
 * pushProgress tries to edit a Telegram message that may already be
 * too old to touch.
 *
 * Pruning on every session-open is a coarse cleanup but matches the
 * semantic: a fresh MCP session means whatever was "in flight" before
 * is unreachable. If a tool's PostToolUse DOES still arrive (tool
 * actually completed and the hook reaches us), `applyEvent` falls
 * through to the no-matching-pre branch and pushes a standalone
 * "done" entry — the only loss is the `inputSummary` from the pre
 * event. Acceptable trade-off versus a stuck UX.
 */
export function pruneStaleRunningEvents(): void {
  for (const [chatId, state] of chats) {
    if (!state.events.some((e) => e.status === "running")) continue;
    const before = state.events.length;
    state.events = state.events.filter((e) => e.status !== "running");
    state.progressMessageId = undefined;
    dlog(
      `session-open: pruned ${before - state.events.length} stale running event(s) for chat=${chatId}`,
    );
  }
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

/** Wall-clock window with no PreToolUse / PostToolUse activity after which
 *  we assume the agent died or Stop missed and self-clear typing. Kept
 *  tight (90s) because the Stop hook is normally what stops typing —
 *  this is the safety net, not the primary mechanism. Each tool event
 *  resets it, so long turns don't expire. */
const TYPING_FAILSAFE_MS = 90_000;

/**
 * Start (or refresh) the Telegram "typing…" indicator for a chat.
 *
 * Telegram's `sendChatAction("typing")` signal lasts ~5 seconds, so we
 * refresh it every 4.5s while CC is working. The canonical "agent is
 * actively working" trigger is a `PreToolUse` hook event — see
 * https://code.claude.com/docs/en/hooks. `progress.ts` calls this on
 * every `pre` event for each pending chat:
 *   - first call mints the interval + failsafe
 *   - subsequent calls only reset the failsafe (long turns don't expire)
 *
 * Cleared authoritatively by the `Stop` hook via `stopTyping`. The
 * failsafe is the safety net for cases where Stop doesn't fire
 * (StopFailure on API error, session ending mid-turn, hook subprocess
 * bug, etc. — see hooks docs for the full edge-case list).
 */
export function startTyping(chatId: string): void {
  const state = chats.get(chatId);
  if (!state) return;
  if (!state.typing) {
    const ping = () => {
      bot.api.sendChatAction(Number(chatId), "typing").catch(() => {});
    };
    ping();
    const interval = setInterval(ping, 4500);
    const failsafe = setTimeout(() => stopTyping(chatId), TYPING_FAILSAFE_MS);
    state.typing = { interval, failsafe };
    return;
  }
  // Refresh the failsafe — fresh tool activity proves the agent is
  // alive, so push the watchdog back out by another window.
  clearTimeout(state.typing.failsafe);
  state.typing.failsafe = setTimeout(
    () => stopTyping(chatId),
    TYPING_FAILSAFE_MS,
  );
}

export function stopTyping(chatId: string): void {
  const state = chats.get(chatId);
  if (!state?.typing) return;
  clearInterval(state.typing.interval);
  clearTimeout(state.typing.failsafe);
  state.typing = undefined;
}
