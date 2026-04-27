/**
 * Permission relay: forward CC's Allow/Deny prompts (notifications/
 * claude/channel/permission_request) to Telegram with inline buttons.
 *
 * Importing this module installs the notification handler + the
 * callbackQuery handler as side effects.
 */
import { InlineKeyboard } from "grammy";
import { z } from "zod";
import { isAllowed } from "./access.ts";
import { bot } from "./bot.ts";
import { activeChatId } from "./chat-state.ts";
import { senderDisplayName, toTelegramMd } from "./format.ts";
import { mcp } from "./mcp.ts";
import { dlog } from "./paths.ts";

const PermissionRequestSchema = z.object({
  method: z.literal("notifications/claude/channel/permission_request"),
  params: z.object({
    request_id: z.string(),
    tool_name: z.string(),
    description: z.string(),
    input_preview: z.string(),
  }),
});

/**
 * Maps an open permission request to the Telegram message we sent (so
 * we can edit it after the verdict, removing buttons and showing the
 * outcome). Entries leak across long sessions but each is tiny; cleared
 * on verdict or on the rare "tap stale button after CC moved on" path.
 */
const pendingPermissions = new Map<
  string,
  { chatId: number; messageId: number }
>();

function clamp(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n - 1) + "…";
}

function formatPermissionPrompt(p: {
  tool_name: string;
  description: string;
  input_preview: string;
}): string {
  const preview = p.input_preview
    ? `\n\n\`\`\`\n${clamp(p.input_preview, 200)}\n\`\`\``
    : "";
  return `🔒 Claude wants to run **${p.tool_name}**\n\n${p.description}${preview}`;
}

mcp.server.setNotificationHandler(
  PermissionRequestSchema,
  async ({ params }) => {
    if (!activeChatId) {
      dlog(
        `permission request with no active chat (tool=${params.tool_name}, id=${params.request_id})`,
      );
      return;
    }
    const chatId = Number(activeChatId);
    const kb = new InlineKeyboard()
      .text("✓ Allow", `perm_allow:${params.request_id}`)
      .text("✗ Deny", `perm_deny:${params.request_id}`);
    try {
      const sent = await bot.api.sendMessage(
        chatId,
        toTelegramMd(formatPermissionPrompt(params)),
        { parse_mode: "MarkdownV2", reply_markup: kb },
      );
      pendingPermissions.set(params.request_id, {
        chatId,
        messageId: sent.message_id,
      });
      dlog(
        `permission prompt sent: id=${params.request_id} tool=${params.tool_name}`,
      );
    } catch (err) {
      console.error(
        `[telegram] permission relay send failed: ${err instanceof Error ? err.message : err}`,
      );
    }
  },
);

bot.callbackQuery(/^perm_(allow|deny):([a-km-z]{5})$/, async (ctx) => {
  // Gate by allowlist — anyone who can tap a button in our chat could
  // approve tool use otherwise, which would let an unauthorized viewer
  // (forwarded message, accidental share) compromise the session.
  if (!ctx.from || !isAllowed(ctx.from.id)) {
    await ctx.answerCallbackQuery({
      text: "Access denied — your account isn't paired.",
      show_alert: true,
    });
    return;
  }
  const verdict = ctx.match[1] as "allow" | "deny";
  const requestId = ctx.match[2]!;

  try {
    await mcp.server.notification({
      method: "notifications/claude/channel/permission",
      params: { request_id: requestId, behavior: verdict },
    });
  } catch (err) {
    console.error(
      `[telegram] permission verdict notification failed: ${err instanceof Error ? err.message : err}`,
    );
  }

  // Drop buttons and show the outcome inline so the chat is self-explanatory.
  const senderName = senderDisplayName(ctx.from);
  const verdictLine =
    verdict === "allow"
      ? `✓ Allowed by ${senderName}`
      : `✗ Denied by ${senderName}`;
  try {
    await ctx.editMessageText(toTelegramMd(verdictLine), {
      parse_mode: "MarkdownV2",
    });
  } catch {
    // best-effort — message might be too old to edit, that's fine
  }

  pendingPermissions.delete(requestId);
  await ctx.answerCallbackQuery({
    text: verdict === "allow" ? "Approved" : "Denied",
  });
  dlog(`permission verdict: id=${requestId} ${verdict} by ${ctx.from.id}`);
});
