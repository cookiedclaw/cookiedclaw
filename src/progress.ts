/**
 * Live tool-progress rendering. Hook events (PreToolUse / PostToolUse,
 * delivered via the localhost endpoint in progress-server.ts) feed
 * `handleProgress`, which fans out to every chat in `pendingChats` so
 * concurrent users all see the bot is working.
 */
import { bot } from "./bot.ts";
import {
  chats,
  pendingChats,
  queueEdit,
  stopTyping,
  type ChatState,
  type ToolEvent,
} from "./chat-state.ts";
import { dlog } from "./paths.ts";

// -----------------------------------------------------------------------------
// Formatting helpers (pure)
// -----------------------------------------------------------------------------

function clamp(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n - 1) + "…";
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60_000)}m${Math.floor((ms % 60_000) / 1000)}s`;
}

/**
 * Strip `mcp__<server>__` and `mcp__plugin_<plugin>_<server>__` prefixes
 * from displayed tool names. The full name is great for filtering /
 * permissions but ugly in chat — `mcp__supermemory__super_search` reads
 * way better as just `super_search`.
 */
export function displayToolName(name: string): string {
  return name.replace(/^mcp__(?:plugin_[^_]+_)?[^_]+__/, "");
}

/**
 * Pick a short, informative summary of a tool's input for the progress
 * line. Knows the most common CC tools and falls back to compact JSON.
 */
export function summarizeToolInput(name: string, input: unknown): string {
  if (input && typeof input === "object") {
    const obj = input as Record<string, unknown>;
    if (name === "Bash" && typeof obj.command === "string") {
      return clamp(obj.command, 90);
    }
    if (
      (name === "Read" ||
        name === "Edit" ||
        name === "Write" ||
        name === "NotebookEdit") &&
      typeof obj.file_path === "string"
    ) {
      return obj.file_path;
    }
    if (name === "Glob" && typeof obj.pattern === "string") return obj.pattern;
    if (name === "Grep" && typeof obj.pattern === "string") return obj.pattern;
    if (name === "WebFetch" && typeof obj.url === "string") return obj.url;
    if (name === "WebSearch" && typeof obj.query === "string") return obj.query;
    // Sub-agents: superpowers/whatever Agent calls show as "<type>: <prompt>".
    if (name === "Agent" && typeof obj.subagent_type === "string") {
      return `${obj.subagent_type}: ${typeof obj.prompt === "string" ? clamp(obj.prompt, 60) : ""}`;
    }
    // Skill invocation (when the agent decides to load a skill).
    if (name === "Skill" && typeof obj.skill === "string") {
      return obj.skill;
    }
    if (name === "ToolSearch" && typeof obj.query === "string") {
      return obj.query;
    }
    if (name === "AskUserQuestion" && typeof obj.question === "string") {
      return clamp(obj.question, 90);
    }
    // TodoWrite — a todos array is most informative as "N todos".
    if (name === "TodoWrite" && Array.isArray(obj.todos)) {
      const t = obj.todos as Array<{ status?: string; content?: string }>;
      const inProgress = t.find((x) => x.status === "in_progress");
      if (inProgress?.content) return clamp(inProgress.content, 80);
      return `${t.length} todo${t.length === 1 ? "" : "s"}`;
    }
    // Generic: show the first short string-valued field, or compact JSON.
    for (const [k, v] of Object.entries(obj)) {
      if (typeof v === "string" && v.length <= 90) return `${k}=${v}`;
    }
  }
  const json = JSON.stringify(input ?? {});
  return clamp(json, 90);
}

/**
 * Skip our `reply` tool from the progress log — it's the final output
 * channel, not "progress". CC namespaces it differently depending on
 * load context: plain `reply` (direct call from main session, rare),
 * `mcp__telegram__reply` (when loaded via .mcp.json), or
 * `mcp__plugin_<plugin>_<server>__reply` (when loaded via --plugin-dir).
 */
export function isReplyTool(name: string): boolean {
  return name === "reply" || /^mcp__.+__reply$/.test(name);
}

/** Telegram message hard limit is 4096; reserve headroom for "(+N more)" line. */
const TELEGRAM_MSG_LIMIT = 3800;

/** Per-tool emoji prefix to make the progress message scannable at a
 * glance. Sub-agents (Agent) and Skill loads get distinct icons so the
 * user can tell "the agent dispatched a sub-agent" vs "the agent ran a
 * Bash". Falls through to the bare status icon for unknown tools. */
function toolPrefix(toolName: string): string {
  if (toolName === "Agent" || toolName === "Task") return "🤖";
  if (toolName === "Skill") return "🧩";
  if (toolName === "Bash") return "⚙️";
  if (toolName === "Read") return "📖";
  if (toolName === "Edit" || toolName === "Write" || toolName === "NotebookEdit")
    return "✏️";
  if (toolName === "Grep" || toolName === "Glob") return "🔍";
  if (toolName === "WebFetch" || toolName === "WebSearch") return "🌐";
  if (toolName === "TodoWrite") return "📝";
  if (toolName === "AskUserQuestion") return "❓";
  return "•";
}

function formatEventLine(e: ToolEvent): string {
  const status =
    e.status === "running" ? "⏳" : e.status === "done" ? "✓" : "✗";
  const display = displayToolName(e.toolName);
  const prefix = toolPrefix(display);
  const dur = e.durationMs ? ` (${formatDuration(e.durationMs)})` : "";
  const errPart = e.errorText ? ` — ${clamp(e.errorText, 80)}` : "";
  return `${status} ${prefix} ${display}: ${e.inputSummary}${dur}${errPart}`;
}

function renderProgress(events: ToolEvent[]): string {
  if (events.length === 0) return "🤔 Thinking…";
  const lines = events.map(formatEventLine);
  const full = lines.join("\n");
  if (full.length <= TELEGRAM_MSG_LIMIT) return full;
  // Long-running turn: keep the first 3 events as context, then "(+N
  // earlier hidden)" marker, then as many tail events as fit. Bias to
  // the tail because that's what's running now. Without this, Telegram
  // rejects editMessageText on overflow and the user sees a stale
  // progress message.
  const head = lines.slice(0, 3);
  const tail: string[] = [];
  let used = head.join("\n").length + "\n(+N earlier hidden)\n".length;
  for (let i = lines.length - 1; i >= 3; i--) {
    const next = lines[i]!;
    if (used + next.length + 1 > TELEGRAM_MSG_LIMIT) break;
    tail.unshift(next);
    used += next.length + 1;
  }
  const hidden = lines.length - head.length - tail.length;
  return [...head, `(+${hidden} earlier hidden)`, ...tail].join("\n");
}

/**
 * Push a chat's current event list to Telegram — either send a fresh
 * progress message (first tool of the turn) or edit the existing one
 * in place. Best-effort: rate limits and "message not modified" errors
 * are logged and swallowed so a flaky network doesn't break the loop.
 */
export async function pushProgress(chatId: string): Promise<void> {
  const state = chats.get(chatId);
  if (!state) return;
  const text = renderProgress(state.events);
  if (!text) return;
  try {
    if (state.progressMessageId !== undefined) {
      await bot.api.editMessageText(
        Number(chatId),
        state.progressMessageId,
        text,
      );
    } else {
      const sent = await bot.api.sendMessage(Number(chatId), text);
      state.progressMessageId = sent.message_id;
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (!msg.includes("message is not modified")) {
      console.error(`[telegram] progress push failed: ${msg}`);
      // Also write to the shared progress.log so the user sees Telegram
      // rejections (rate limit, message-too-long, …) without having to
      // dig through CC's stderr stream.
      dlog(`progress push failed: ${msg}`);
    }
  }
}

/**
 * Drop the in-place progress message for `chatId` if any. Used by
 * `reply` / `react` / `/stop` when the turn's done — the progress log
 * is replaced by the final answer, not left dangling above it.
 */
export async function deleteProgressMessage(chatId: string): Promise<void> {
  await queueEdit(chatId, async () => {
    const state = chats.get(chatId);
    if (state?.progressMessageId === undefined) return;
    try {
      await bot.api.deleteMessage(
        Number(chatId),
        state.progressMessageId,
      );
    } catch (err) {
      console.error(
        `[telegram] couldn't delete progress message: ${err instanceof Error ? err.message : err}`,
      );
    }
    state.progressMessageId = undefined;
  });
}

// -----------------------------------------------------------------------------
// Hook event ingestion
// -----------------------------------------------------------------------------

export type ProgressPayload =
  | {
      phase: "pre" | "post";
      tool_name: string;
      tool_use_id: string;
      tool_input?: unknown;
      duration_ms?: number;
      is_error?: boolean;
      error_text?: string;
    }
  | {
      /** Turn-end signal from the Stop hook. No tool data — we just clear
       * typing + drop the progress message + remove from pendingChats. */
      phase: "stop";
    };

/**
 * Apply a single hook event to one chat's events list, then schedule
 * a progress push. Adds for `pre`, updates the matching `pre` for
 * `post` (or pushes a standalone done/error if there's no match —
 * defensive for chats that joined pending mid-flight).
 */
function applyEvent(
  state: ChatState,
  p: Extract<ProgressPayload, { phase: "pre" | "post" }>,
): void {
  if (p.phase === "pre") {
    state.events.push({
      toolUseId: p.tool_use_id,
      toolName: p.tool_name,
      inputSummary: summarizeToolInput(p.tool_name, p.tool_input),
      status: "running",
    });
    return;
  }
  const ev = state.events.find((e) => e.toolUseId === p.tool_use_id);
  if (ev) {
    ev.status = p.is_error ? "error" : "done";
    ev.durationMs = p.duration_ms;
    if (p.error_text) ev.errorText = p.error_text;
  } else {
    state.events.push({
      toolUseId: p.tool_use_id,
      toolName: p.tool_name,
      inputSummary: summarizeToolInput(p.tool_name, p.tool_input),
      status: p.is_error ? "error" : "done",
      durationMs: p.duration_ms,
      errorText: p.error_text,
    });
  }
}

/**
 * Coalesces rapid tool events into a single Telegram edit. Without
 * this, a turn that fires Read pre/post + Edit pre/post + Bash pre/post
 * within 200ms produces 6 sequential editMessageText calls — Telegram
 * rate-limits and silently drops most of them, so the user sees only
 * the first one and the progress message looks "stuck on Bash".
 */
const pushDebounce = new Map<string, ReturnType<typeof setTimeout>>();
const PUSH_DEBOUNCE_MS = 200;

/**
 * Coalesce rapid pushProgress calls. Public so forwardToCC can request
 * an initial "🤔 Thinking…" message as soon as an inbound arrives —
 * the user sees instant feedback even before the first tool fires.
 * If a tool DOES fire within the debounce window, the same scheduled
 * push picks up the updated state (events list).
 */
export function schedulePush(chatId: string): void {
  if (pushDebounce.has(chatId)) return;
  const timer = setTimeout(() => {
    pushDebounce.delete(chatId);
    void queueEdit(chatId, () => pushProgress(chatId));
  }, PUSH_DEBOUNCE_MS);
  pushDebounce.set(chatId, timer);
}

/**
 * Top-level hook ingest. Three phases:
 *  - `stop`: CC's main agent finished a response. Stop typing, but
 *    deliberately keep `pendingChats` and the progress message intact.
 *
 *    Per the Stop hook docs (https://code.claude.com/docs/en/hooks-guide
 *    and https://code.claude.com/docs/en/hooks), Stop fires after the
 *    main agentic loop's turn completes — strictly after all
 *    PreToolUse/PostToolUse for that turn resolve. In practice we
 *    routinely see tool events fire seconds after Stop, almost certainly
 *    from one of:
 *      • SubagentStop hooks for in-flight `Agent`/`Task` tool calls
 *        (sub-agent tool events keep firing PreToolUse/PostToolUse via
 *        our handler even though the *main* agent has stopped),
 *      • async post-turn work the agent kicked off (background
 *        edits to identity files, Bash cleanup, supermemory writes),
 *      • PreCompact / context-housekeeping hooks during session idle.
 *
 *    Whatever the cause, those events are still "this turn's work" from
 *    the user's perspective and should appear in their progress message.
 *    Clearing pendingChats on Stop would render them invisible. State
 *    actually resets on the next user inbound (forwardToCC), and the
 *    progress message survives as a chat-history record of what the bot
 *    did.
 *  - `pre` / `post`: tool progress event. Skips our own `reply`/`react`
 *    tools (they're the final output, not progress) and broadcasts to
 *    every chat in `pendingChats`.
 */
export async function handleProgress(p: ProgressPayload): Promise<void> {
  if (p.phase === "stop") {
    dlog(
      `stop hook fired — typing off, keeping pending=[${[...pendingChats].join(",") || "none"}]`,
    );
    for (const chatId of pendingChats) {
      stopTyping(chatId);
    }
    return;
  }
  dlog(
    `progress in: phase=${p.phase} tool=${p.tool_name} id=${p.tool_use_id} pending=[${[...pendingChats].join(",") || "none"}]`,
  );
  if (isReplyTool(p.tool_name)) {
    dlog(`  -> skipped (reply tool)`);
    return;
  }
  if (pendingChats.size === 0) {
    dlog(`  -> skipped (no pending chats)`);
    return;
  }
  for (const chatId of pendingChats) {
    const state = chats.get(chatId) ?? { events: [] };
    chats.set(chatId, state);
    applyEvent(state, p);
    void queueEdit(chatId, () => pushProgress(chatId));
  }
}
