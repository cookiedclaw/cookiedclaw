/**
 * Telegram inbound handlers — text, photo, document — plus the gating
 * (allowlist + pair-flow), forwarding to CC, and the /stop fast-path.
 *
 * Importing this module registers the bot.on handlers as a side effect.
 * No exports needed; channel.ts imports for side effects.
 */
import {
  generatePairCode,
  isAllowed,
  PAIR_TTL_MS,
  pendingPairs,
  reapPending,
} from "./access.ts";
import { downloadTelegramFile } from "./attachments.ts";
import { bot } from "./bot.ts";
import {
  addPending,
  chats,
  setActiveChatId,
  startTyping,
  stopTyping,
} from "./chat-state.ts";
import { sendFormatted, senderDisplayName } from "./format.ts";
import { mcp } from "./mcp.ts";
import { dlog, stopFlag } from "./paths.ts";
import { deleteProgressMessage, schedulePush } from "./progress.ts";
import { unlink } from "node:fs/promises";

/**
 * Placeholder for `/skills` until adapters push their skill catalogs to
 * the gateway via an HTTP API. The old (stdio-era) implementation
 * scanned the local CC's user/project/plugin skill dirs directly; the
 * gateway can't, since it runs separately from any runtime.
 *
 * Adapter→gateway skill push lands in a follow-up; for now /skills
 * tells the user where the list will live.
 */
function formatSkillsListMessage(): string {
  return [
    "*Skills directory*",
    "",
    "Skills are advertised by whichever runtime adapter is connected to this gateway.",
    "Adapter→gateway skill catalog push isn't wired yet — coming soon.",
    "Type a skill command directly if you know it (e.g. `/cookiedclaw_setup`); the adapter will route it.",
  ].join("\n");
}

/**
 * Forward an inbound user message into CC's session as a `<channel>`
 * notification. Sets active chat (for permission-relay routing), adds
 * to pendingChats (for progress fan-out), resets this chat's tool log,
 * and starts the typing indicator.
 *
 * `messageId` is surfaced to CC via meta so the `react` tool can target
 * it (you can't react to a message without knowing its id).
 */
async function forwardToCC(
  chatId: string,
  senderId: string,
  senderLabel: string,
  messageId: number,
  content: string,
  attachmentPath?: string,
  extraMeta?: Record<string, string>,
): Promise<void> {
  setActiveChatId(chatId);
  addPending(chatId);
  // Reset this chat's tool log — it's the start of their turn. Other
  // pending chats keep whatever they had. Mutate the existing state
  // object instead of replacing it: replacing would orphan a typing
  // interval started by an earlier forwardToCC, leaking a setInterval
  // that pings "typing..." forever.
  let state = chats.get(chatId);
  if (state) {
    state.events = [];
    state.progressMessageId = undefined;
  } else {
    state = { events: [] };
    chats.set(chatId, state);
  }
  // New user message = clear any /stop flag from a prior turn so the
  // PreToolUse hook stops blocking non-reply tools.
  unlink(stopFlag).catch(() => {});
  startTyping(chatId);
  // Native-feel feedback: schedule a "🤔 Thinking…" progress message
  // immediately. If the agent calls its first tool within the 200ms
  // debounce window, the same push picks up the tool-event state. If
  // not (e.g. agent thinks for several seconds before any tool), the
  // user sees a Thinking bubble within 200ms instead of staring at the
  // typing indicator alone.
  schedulePush(chatId);
  dlog(
    `inbound: chat=${chatId} sender=${senderId} msg=${messageId}${attachmentPath ? ` attachment=${attachmentPath}` : ""}`,
  );
  const meta: Record<string, string> = {
    chat_id: chatId,
    sender_id: senderId,
    sender: senderLabel,
    message_id: String(messageId),
  };
  if (attachmentPath) meta.attachment = attachmentPath;
  if (extraMeta) Object.assign(meta, extraMeta);
  // Prefix the content with [<sender>]: so the agent reliably knows
  // who's talking. The sender is also in meta, but inline prefixes are
  // harder to overlook than tag attributes — and they matter when
  // multiple paired users share the same bot. Empty content (e.g. a
  // photo with no caption) gets no prefix; meta.sender still carries
  // the attribution.
  const prefixedContent = content.trim()
    ? `[${senderLabel}]: ${content}`
    : content;
  try {
    await mcp.server.notification({
      method: "notifications/claude/channel",
      params: { content: prefixedContent, meta },
    });
  } catch (err) {
    console.error(
      `[telegram] failed to push notification: ${err instanceof Error ? err.message : err}`,
    );
  }
}

/**
 * First gate any inbound message goes through. If sender isn't on the
 * allowlist, issue/refresh a pair code and stop. Returns `{ ok: true,
 * ... }` when the caller should proceed with normal forwarding.
 */
async function gateInbound(ctx: {
  from?: {
    id: number;
    username?: string;
    first_name?: string;
    last_name?: string;
  };
  chat: { id: number };
}): Promise<
  { ok: true; senderId: string; senderLabel: string } | { ok: false }
> {
  const sender = ctx.from;
  if (!sender) return { ok: false };
  const senderId = String(sender.id);
  const senderLabel = senderDisplayName(sender);
  if (isAllowed(sender.id)) return { ok: true, senderId, senderLabel };

  reapPending();
  let pair = [...pendingPairs.values()].find((p) => p.userId === sender.id);
  if (!pair || pair.expiresAt <= Date.now()) {
    pair = {
      code: generatePairCode(),
      userId: sender.id,
      name: senderLabel,
      expiresAt: Date.now() + PAIR_TTL_MS,
    };
    pendingPairs.set(pair.code, pair);
  }
  try {
    await sendFormatted(
      ctx.chat.id,
      `Hi! Your access isn't approved yet.\n\n` +
        `Ask the bot owner to run this in their Claude Code session:\n` +
        `\`pair ${pair.code}\`\n\n` +
        `(code expires in 10 min)`,
    );
  } catch (err) {
    console.error(
      `[telegram] couldn't send pair instructions to ${senderId}: ${err instanceof Error ? err.message : err}`,
    );
  }
  dlog(`pair issued: code=${pair.code} sender=${senderId}`);
  return { ok: false };
}

/**
 * `/stop` (or `/cancel`) — user wants to abort whatever the agent is
 * doing right now. Server-side we kill the typing indicator and drop
 * the progress message immediately so the user gets visual feedback
 * without waiting for the agent to react. Then we push a channel event
 * with `meta.is_stop="true"` so CC's next turn sees the explicit stop
 * signal — its instructions (in CLAUDE.md) tell it to abort and ack.
 */
async function handleStopCommand(
  chatId: string,
  senderId: string,
  senderLabel: string,
  messageId: number,
): Promise<void> {
  stopTyping(chatId);
  await deleteProgressMessage(chatId);
  // Reset events in place; replacing the state object would orphan any
  // typing interval a concurrent forwardToCC might have started.
  let state = chats.get(chatId);
  if (state) {
    state.events = [];
    state.progressMessageId = undefined;
  } else {
    state = { events: [] };
    chats.set(chatId, state);
  }
  // Set the /stop flag so the PreToolUse hook starts blocking non-reply
  // tools immediately. The hook reading this is what gives us a real
  // mid-turn abort — CC's notification queue otherwise lets the agent
  // finish the current tool sequence before noticing the stop.
  await Bun.write(stopFlag, String(Date.now())).catch(() => {});
  setActiveChatId(chatId);
  // /stop ends this chat's turn from the user side — agent will ack
  // shortly and we'll remove from pending then. Until then they're
  // still pending so any final-tool progress goes to them.
  addPending(chatId);
  dlog(`/stop: chat=${chatId} sender=${senderId} msg=${messageId}`);
  try {
    await mcp.server.notification({
      method: "notifications/claude/channel",
      params: {
        content: "/stop",
        meta: {
          chat_id: chatId,
          sender_id: senderId,
          sender: senderLabel,
          message_id: String(messageId),
          is_stop: "true",
        },
      },
    });
  } catch (err) {
    console.error(
      `[telegram] failed to push /stop signal: ${err instanceof Error ? err.message : err}`,
    );
  }
}

/**
 * Pull a friendly origin label off a forwarded Telegram message. Returns
 * undefined if the message wasn't forwarded.
 */
function describeForward(message: {
  forward_origin?: {
    type: string;
    sender_user?: { first_name?: string; last_name?: string; username?: string };
    sender_user_name?: string;
    sender_chat?: { title?: string; username?: string };
    chat?: { title?: string; username?: string };
    author_signature?: string;
  };
}): { label: string; meta: Record<string, string> } | undefined {
  const o = message.forward_origin;
  if (!o) return undefined;
  switch (o.type) {
    case "user": {
      const u = o.sender_user;
      if (!u) return { label: "(forwarded)", meta: { forward_type: "user" } };
      const parts = [u.first_name, u.last_name].filter(Boolean).join(" ");
      const handle = u.username ? `@${u.username}` : "";
      const name = parts && handle ? `${parts} (${handle})` : parts || handle || "user";
      return {
        label: `forwarded from ${name}`,
        meta: {
          forward_type: "user",
          forward_from: name,
        },
      };
    }
    case "hidden_user":
      return {
        label: `forwarded from ${o.sender_user_name ?? "user"}`,
        meta: {
          forward_type: "hidden_user",
          forward_from: o.sender_user_name ?? "",
        },
      };
    case "chat": {
      const t = o.sender_chat?.title ?? o.sender_chat?.username ?? "group";
      return {
        label: `forwarded from group ${t}`,
        meta: { forward_type: "chat", forward_from: t },
      };
    }
    case "channel": {
      const t = o.chat?.title ?? o.chat?.username ?? "channel";
      const sig = o.author_signature ? ` by ${o.author_signature}` : "";
      return {
        label: `forwarded from channel ${t}${sig}`,
        meta: {
          forward_type: "channel",
          forward_from: t,
          ...(o.author_signature ? { forward_author: o.author_signature } : {}),
        },
      };
    }
    default:
      return { label: "(forwarded)", meta: { forward_type: o.type } };
  }
}

// -----------------------------------------------------------------------------
// Bot handler registrations
// -----------------------------------------------------------------------------

bot.on("message:text", async (ctx) => {
  const gated = await gateInbound(ctx);
  if (!gated.ok) return;
  const text = ctx.message.text.trim();
  // /skills doesn't go to CC — we render the list ourselves so the user
  // doesn't burn an agent turn just to see what's available.
  if (text === "/skills") {
    try {
      const msg = formatSkillsListMessage();
      await sendFormatted(ctx.chat.id, msg);
    } catch (err) {
      console.error(
        `[telegram] /skills failed: ${err instanceof Error ? err.message : err}`,
      );
    }
    return;
  }
  // /stop and /cancel get a special path — we want immediate visual
  // feedback (kill typing, drop progress) before CC's reply lands.
  if (text === "/stop" || text === "/cancel") {
    await handleStopCommand(
      String(ctx.chat.id),
      gated.senderId,
      gated.senderLabel,
      ctx.message.message_id,
    );
    return;
  }
  const fwd = describeForward(ctx.message);
  await forwardToCC(
    String(ctx.chat.id),
    gated.senderId,
    gated.senderLabel,
    ctx.message.message_id,
    fwd ? `[${fwd.label}] ${ctx.message.text}` : ctx.message.text,
    undefined,
    fwd?.meta,
  );
});

bot.on("message:photo", async (ctx) => {
  const gated = await gateInbound(ctx);
  if (!gated.ok) return;
  // Telegram returns thumbnail variants in ascending size order; pick the
  // last one (largest available — usually still under a few MB so fits
  // comfortably in CC's vision context).
  const sizes = ctx.message.photo;
  const largest = sizes[sizes.length - 1];
  if (!largest) return;
  let attachmentPath: string | undefined;
  try {
    attachmentPath = await downloadTelegramFile(
      largest.file_id,
      `photo_${ctx.message.message_id}.jpg`,
    );
  } catch (err) {
    console.error(
      `[telegram] photo download failed: ${err instanceof Error ? err.message : err}`,
    );
  }
  const fwdPhoto = describeForward(ctx.message);
  const photoCaption = ctx.message.caption ?? "";
  await forwardToCC(
    String(ctx.chat.id),
    gated.senderId,
    gated.senderLabel,
    ctx.message.message_id,
    fwdPhoto
      ? `[${fwdPhoto.label}]${photoCaption ? ` ${photoCaption}` : ""}`
      : photoCaption,
    attachmentPath,
    fwdPhoto?.meta,
  );
});

bot.on("message:document", async (ctx) => {
  const gated = await gateInbound(ctx);
  if (!gated.ok) return;
  const doc = ctx.message.document;
  let attachmentPath: string | undefined;
  try {
    attachmentPath = await downloadTelegramFile(
      doc.file_id,
      doc.file_name ?? `file_${ctx.message.message_id}`,
    );
  } catch (err) {
    console.error(
      `[telegram] document download failed: ${err instanceof Error ? err.message : err}`,
    );
  }
  const fwdDoc = describeForward(ctx.message);
  const docCaption = ctx.message.caption ?? "";
  await forwardToCC(
    String(ctx.chat.id),
    gated.senderId,
    gated.senderLabel,
    ctx.message.message_id,
    fwdDoc ? `[${fwdDoc.label}]${docCaption ? ` ${docCaption}` : ""}` : docCaption,
    attachmentPath,
    fwdDoc?.meta,
  );
});

/**
 * User reacted to a message with an emoji. We forward this to CC as a
 * channel notification so the agent can ack ("oh, they 👍'd my reply"
 * → maybe react back with 🙏, or use it as feedback signal). Requires
 * `message_reaction` in `allowed_updates` (set in channel.ts).
 *
 * In private chats reactions only fire for the bot if `disable_notification`
 * isn't set on the source message — Telegram hides reactions on muted
 * messages. That's a Telegram quirk we don't try to work around.
 */
/**
 * Inline-button taps from buttons the agent attached to a previous
 * reply via the `reply` tool's `buttons` parameter. Tapping forwards
 * the agent-supplied `data` payload back as a `<channel>` notification
 * with `meta.callback_data` and `meta.is_callback="true"`. The agent
 * decides what to do (typically reply / react / start a task).
 *
 * URL buttons don't hit this — Telegram opens the link directly.
 */
bot.callbackQuery(/^cb:(.+)$/, async (ctx) => {
  if (!ctx.from || !isAllowed(ctx.from.id)) {
    await ctx.answerCallbackQuery({
      text: "Access denied — your account isn't paired.",
      show_alert: true,
    });
    return;
  }
  const data = ctx.match[1]!;
  const senderId = String(ctx.from.id);
  const senderLabel = senderDisplayName(ctx.from);
  const chatId = ctx.callbackQuery.message?.chat.id;
  const messageId = ctx.callbackQuery.message?.message_id;
  if (!chatId || !messageId) {
    await ctx.answerCallbackQuery({ text: "Stale button (no chat/msg)." });
    return;
  }
  // Acknowledge fast so Telegram dismisses the loading spinner. We
  // don't show alert text — the agent's reply is the user-visible ack.
  await ctx.answerCallbackQuery();
  await forwardToCC(
    String(chatId),
    senderId,
    senderLabel,
    messageId,
    `(tapped: ${data})`,
    undefined,
    {
      callback_data: data,
      is_callback: "true",
    },
  );
});

bot.on("message_reaction", async (ctx) => {
  const update = ctx.messageReaction;
  if (!update) return;
  // We only care about reactions made BY users, not by the bot itself.
  // Bot-reactions echo back as message_reaction updates with our bot's
  // user id; ignore them.
  const sender = update.user;
  if (!sender) return;
  const gated = await gateInbound({
    from: sender,
    chat: { id: Number(update.chat.id) },
  });
  if (!gated.ok) return;
  const emojiOf = (r: { type: string; emoji?: string }): string | undefined =>
    r.type === "emoji" ? r.emoji : undefined;
  const newReactions = update.new_reaction
    .map(emojiOf)
    .filter((e): e is string => Boolean(e));
  const oldReactions = update.old_reaction
    .map(emojiOf)
    .filter((e): e is string => Boolean(e));
  // Only signal added reactions (the typical case). Removals get
  // squelched — the agent rarely cares "user retracted their 👍".
  const added = newReactions.filter((e) => !oldReactions.includes(e));
  if (added.length === 0) return;
  const emoji = added.join(" ");
  await forwardToCC(
    String(update.chat.id),
    gated.senderId,
    gated.senderLabel,
    update.message_id,
    `(reacted ${emoji})`,
    undefined,
    {
      reaction_emoji: emoji,
      is_reaction: "true",
    },
  );
});
