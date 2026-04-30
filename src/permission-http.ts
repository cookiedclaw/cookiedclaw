/**
 * HTTP-mediated permission relay (POST /permission-request).
 *
 * Used by adapters that DON'T speak the MCP `permission_request`
 * notification — most notably the cookiedclaw-cursor plugin, which
 * intercepts Cursor's `beforeShellExecution` / `beforeMCPExecution`
 * hooks and inverts the flow so the gateway becomes authoritative on
 * tool approval.
 *
 * Wire-up:
 *   1. Adapter POST /permission-request with { request_id, flavor,
 *      workspace, payload } and Bearer auth.
 *   2. We send a Telegram message with [✓ Allow] [✗ Deny] [❔ Ask Locally]
 *      inline buttons to the active chat.
 *   3. The bot.callbackQuery handler routes the user's tap to a pending
 *      Promise keyed by request_id.
 *   4. We respond with { verdict, user_message?, agent_message? }.
 *      Cursor's hook converts the verdict to its own permission schema.
 *
 * Two key design decisions:
 *   - Internal timeout (DEFAULT_WAIT_MS) is ~9 minutes, deliberately
 *     below Cursor's hook timeout (10m) so we always return SOMETHING
 *     before the hook subprocess gets killed. On timeout we resolve as
 *     `ask` so Cursor falls back to its own permission UI — that beats
 *     blocking the user's session if they aren't watching Telegram.
 *   - The Allow/Deny buttons are gated by `isAllowed` (same allowlist
 *     used elsewhere) — anyone who taps a forwarded button can't
 *     approve a tool run on someone else's session.
 */
import { InlineKeyboard } from "grammy";
import { isAllowed } from "./access.ts";
import { bot } from "./bot.ts";
import { activeChatId } from "./chat-state.ts";
import { senderDisplayName, toTelegramMd } from "./format.ts";
import { dlog } from "./paths.ts";

export type Flavor = "shell" | "mcp";

export type PermissionRequestBody = {
  request_id: string;
  flavor: Flavor;
  workspace?: string;
  payload?: {
    command?: string;
    cwd?: string;
    sandbox?: boolean;
    tool_name?: string;
    tool_input?: string;
    url?: string;
  };
};

export type Verdict = "allow" | "deny" | "ask";

export type PermissionResponse = {
  verdict: Verdict;
  user_message?: string;
  agent_message?: string;
};

type Pending = {
  resolve: (v: PermissionResponse) => void;
  timer: ReturnType<typeof setTimeout>;
  chatId?: number;
  messageId?: number;
};

const pending = new Map<string, Pending>();

/** Wait long enough that interactive users can react, but always come
 * back with a verdict before Cursor's hook timeout (10 min) kills the
 * subprocess. */
const DEFAULT_WAIT_MS = 9 * 60 * 1000;

/** Truncate noisy fields so the inline keyboard message stays under
 * Telegram's 4096-char cap with room for MarkdownV2 escaping. */
function clamp(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n - 1) + "…";
}

function describeRequest(body: PermissionRequestBody): string {
  const p = body.payload ?? {};
  if (body.flavor === "shell") {
    const cmd = clamp(String(p.command ?? "(no command)"), 600);
    const cwd = p.cwd ? `\n\nIn: \`${clamp(p.cwd, 200)}\`` : "";
    return `🔒 Cursor wants to run a **shell** command\n\n\`\`\`\n${cmd}\n\`\`\`${cwd}`;
  }
  // mcp
  const tool = clamp(String(p.tool_name ?? "(unknown tool)"), 120);
  let argsBlock = "";
  if (p.tool_input) {
    let pretty = clamp(p.tool_input, 600);
    try {
      pretty = clamp(JSON.stringify(JSON.parse(p.tool_input), null, 2), 600);
    } catch {
      // not JSON, leave as-is
    }
    argsBlock = `\n\n\`\`\`\n${pretty}\n\`\`\``;
  }
  const target = p.url ? `\n\nURL: \`${clamp(p.url, 200)}\`` : "";
  return `🔒 Cursor wants to call MCP tool **${tool}**${argsBlock}${target}`;
}

/** Validate adapter payload. Defensive — adapter is trusted (Bearer
 * authed) but malformed bodies should still 400 cleanly. */
function isValidBody(b: unknown): b is PermissionRequestBody {
  if (!b || typeof b !== "object") return false;
  const o = b as Partial<PermissionRequestBody>;
  if (typeof o.request_id !== "string" || !o.request_id) return false;
  if (o.flavor !== "shell" && o.flavor !== "mcp") return false;
  return true;
}

/**
 * Entry point called by the gateway's HTTP router for POST
 * /permission-request. Returns the JSON body to send back to the
 * adapter. Does NOT throw — every error path ends in a verdict object
 * so the adapter always gets a deterministic answer.
 */
export async function handlePermissionRequest(
  rawBody: unknown,
  opts: { waitMs?: number } = {},
): Promise<PermissionResponse> {
  if (!isValidBody(rawBody)) {
    dlog(`[http-perm] rejected malformed body`);
    return {
      verdict: "deny",
      user_message: "Permission request rejected: malformed body",
      agent_message:
        "cookiedclaw gateway rejected your permission request: body was malformed.",
    };
  }
  const body = rawBody;

  // No active chat → nobody can possibly tap a button. Respond `ask`
  // immediately so Cursor falls back to its built-in permission prompt;
  // no point holding the hook open for 9 minutes.
  if (!activeChatId) {
    dlog(
      `[http-perm] no activeChatId; ask-fallback for id=${body.request_id}`,
    );
    return {
      verdict: "ask",
      user_message:
        "No active Telegram chat — falling back to Cursor's local permission prompt.",
    };
  }

  const chatId = Number(activeChatId);
  const kb = new InlineKeyboard()
    .text("✓ Allow", `httpperm_allow:${body.request_id}`)
    .text("✗ Deny", `httpperm_deny:${body.request_id}`)
    .row()
    .text("❔ Ask locally", `httpperm_ask:${body.request_id}`);

  let messageId: number | undefined;
  try {
    const sent = await bot.api.sendMessage(
      chatId,
      toTelegramMd(describeRequest(body)),
      { parse_mode: "MarkdownV2", reply_markup: kb },
    );
    messageId = sent.message_id;
    dlog(
      `[http-perm] prompted chat=${chatId} msg=${messageId} id=${body.request_id} flavor=${body.flavor}`,
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    dlog(`[http-perm] prompt send failed: ${msg}`);
    return {
      verdict: "deny",
      user_message: `Failed to send Telegram permission prompt: ${msg}`,
      agent_message:
        "cookiedclaw could not deliver the permission prompt to Telegram. Aborting this tool call.",
    };
  }

  const waitMs = opts.waitMs ?? DEFAULT_WAIT_MS;
  return new Promise<PermissionResponse>((resolve) => {
    const timer = setTimeout(() => {
      pending.delete(body.request_id);
      // Best-effort: clear the buttons so the chat doesn't keep stale
      // controls. We don't rewrite the body — the prompt is still
      // historically meaningful.
      void bot.api
        .editMessageReplyMarkup(chatId, messageId!, { reply_markup: undefined })
        .catch(() => {});
      dlog(
        `[http-perm] timeout for id=${body.request_id}; ask-fallback after ${waitMs}ms`,
      );
      resolve({
        verdict: "ask",
        user_message:
          "No Telegram decision in time — falling back to Cursor's local permission prompt.",
      });
    }, waitMs);
    pending.set(body.request_id, { resolve, timer, chatId, messageId });
  });
}

bot.callbackQuery(
  /^httpperm_(allow|deny|ask):([0-9a-f-]{8,})$/i,
  async (ctx) => {
    if (!ctx.from || !isAllowed(ctx.from.id)) {
      await ctx.answerCallbackQuery({
        text: "Access denied — your account isn't paired.",
        show_alert: true,
      });
      return;
    }
    const verdict = ctx.match[1] as Verdict;
    const requestId = ctx.match[2]!;
    const entry = pending.get(requestId);
    if (!entry) {
      // Tap landed after timeout / parallel resolution. Acknowledge
      // politely so the spinning button stops.
      await ctx.answerCallbackQuery({ text: "This request already expired." });
      return;
    }
    pending.delete(requestId);
    clearTimeout(entry.timer);

    const senderName = senderDisplayName(ctx.from);
    const verdictLine =
      verdict === "allow"
        ? `✓ Allowed by ${senderName}`
        : verdict === "deny"
          ? `✗ Denied by ${senderName}`
          : `❔ Asked locally by ${senderName}`;
    try {
      await ctx.editMessageText(toTelegramMd(verdictLine), {
        parse_mode: "MarkdownV2",
      });
    } catch {
      // Original message too old / already edited / deleted — fine.
    }

    entry.resolve({
      verdict,
      user_message:
        verdict === "deny"
          ? `Denied by ${senderName} from Telegram.`
          : verdict === "allow"
            ? undefined
            : `${senderName} deferred to local permission prompt.`,
      agent_message:
        verdict === "deny"
          ? `${senderName} denied this tool call from Telegram. Don't retry without explaining; ask the user what to do instead.`
          : undefined,
    });

    await ctx.answerCallbackQuery({
      text:
        verdict === "allow"
          ? "Approved"
          : verdict === "deny"
            ? "Denied"
            : "Deferred",
    });
    dlog(
      `[http-perm] verdict id=${requestId} ${verdict} by ${ctx.from.id}`,
    );
  },
);
