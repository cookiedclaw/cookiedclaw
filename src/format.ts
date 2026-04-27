/**
 * Telegram message formatting helpers — MarkdownV2 conversion + send,
 * and sender-display-name composition.
 */
import telegramifyMarkdown from "telegramify-markdown";
import type { InlineKeyboard } from "grammy";
import { bot } from "./bot.ts";

/**
 * Convert CC's CommonMark-flavored output into something Telegram's
 * MarkdownV2 parser will accept. CC writes \`code\`, **bold**, lists,
 * links, code blocks — Telegram renders them all but is strict about
 * escaping (`. ! - + ( )` etc. all need backslashes when not part of
 * formatting). `telegramify-markdown` does that escaping for us.
 */
export function toTelegramMd(text: string): string {
  try {
    return telegramifyMarkdown(text, "escape");
  } catch {
    // If conversion blows up on weird input, fall back to raw text and let
    // the caller's plain-text retry handle it.
    return text;
  }
}

/**
 * Telegram's per-message hard cap is 4096 chars (UTF-16 code units, but
 * approximated here in JS string length, which matches close enough for
 * MarkdownV2 escape-inflated text). We chunk a few hundred chars below
 * the limit so a trailing escape sequence can't push past it.
 */
const MAX_TELEGRAM_MESSAGE = 3800;

/**
 * Split long text on paragraph / line / word boundaries so chunks stay
 * under MAX_TELEGRAM_MESSAGE without slicing inside a word or marker.
 * Last-resort: hard slice at the limit.
 */
function chunkForTelegram(text: string): string[] {
  if (text.length <= MAX_TELEGRAM_MESSAGE) return [text];
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > MAX_TELEGRAM_MESSAGE) {
    const window = remaining.slice(0, MAX_TELEGRAM_MESSAGE);
    // Prefer paragraph break, then line break, then space; fall back to
    // a hard cut at the window edge.
    const cut =
      window.lastIndexOf("\n\n") > MAX_TELEGRAM_MESSAGE * 0.5
        ? window.lastIndexOf("\n\n") + 2
        : window.lastIndexOf("\n") > MAX_TELEGRAM_MESSAGE * 0.5
          ? window.lastIndexOf("\n") + 1
          : window.lastIndexOf(" ") > MAX_TELEGRAM_MESSAGE * 0.5
            ? window.lastIndexOf(" ") + 1
            : MAX_TELEGRAM_MESSAGE;
    chunks.push(remaining.slice(0, cut));
    remaining = remaining.slice(cut);
  }
  if (remaining.length > 0) chunks.push(remaining);
  return chunks;
}

/**
 * Send formatted text with MarkdownV2. Two failure modes worth handling:
 *
 * 1. Markdown parse rejection — retry the same chunk(s) as plain text.
 *    `telegramify-markdown` covers most CommonMark, but Telegram's
 *    parser has edge cases it can't catch ahead of time.
 *
 * 2. Length overflow — Telegram caps a single sendMessage at 4096 chars.
 *    MarkdownV2 escaping inflates length, so a 3500-char input can
 *    exceed the cap after escaping. We chunk pre-emptively and send
 *    each piece sequentially. The `replyMarkup` (inline keyboard) only
 *    rides the FINAL chunk so buttons appear at the bottom of the full
 *    reply, not under the first piece.
 *
 * On every successful sendMessage we log chat/length/message_id so
 * journalctl can prove the bot actually delivered something — silent
 * delivery failures (the agent saw `sent` but the user saw nothing)
 * leave a paper trail to compare against.
 */
export async function sendFormatted(
  chatId: number,
  text: string,
  replyMarkup?: InlineKeyboard,
): Promise<void> {
  const md = toTelegramMd(text);
  const mdChunks = chunkForTelegram(md);
  const plainChunks = chunkForTelegram(text); // mirrors mdChunks for fallback retries

  for (let i = 0; i < mdChunks.length; i++) {
    const mdChunk = mdChunks[i] ?? "";
    const isLast = i === mdChunks.length - 1;
    const opts: Record<string, unknown> = { parse_mode: "MarkdownV2" };
    if (isLast && replyMarkup) opts.reply_markup = replyMarkup;
    const chunkLen = mdChunk.length;

    try {
      const sent = await bot.api.sendMessage(chatId, mdChunk, opts);
      console.error(
        `[telegram] sent chat=${chatId} chunk=${i + 1}/${mdChunks.length} len=${chunkLen} msg_id=${sent.message_id}`,
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (/can't parse|markdown|entities/i.test(msg)) {
        console.error(
          `[telegram] markdown parse error on chunk=${i + 1}/${mdChunks.length} len=${chunkLen}, retrying plain: ${msg}`,
        );
        const plainOpts: Record<string, unknown> = {};
        if (isLast && replyMarkup) plainOpts.reply_markup = replyMarkup;
        const fallback = plainChunks[i] ?? mdChunk;
        const sent = await bot.api.sendMessage(chatId, fallback, plainOpts);
        console.error(
          `[telegram] sent (plain fallback) chat=${chatId} chunk=${i + 1}/${mdChunks.length} len=${fallback.length} msg_id=${sent.message_id}`,
        );
      } else {
        // Anything else — length-after-escape, network, 429, blocked
        // by user — propagates so the caller's try/catch returns
        // isError=true and the agent learns the call didn't land.
        console.error(
          `[telegram] send failed chat=${chatId} chunk=${i + 1}/${mdChunks.length} len=${chunkLen}: ${msg}`,
        );
        throw err;
      }
    }
  }
}

/**
 * Compose the friendliest available label for a Telegram sender.
 *  - `Tymur Turatbekov (@wowtist247)` when both name and username exist
 *  - `Tymur Turatbekov` for name-only senders
 *  - `@wowtist247` for username-only senders
 *  - numeric id as last resort
 *
 * Same label is used both in the inline `[Sender]:` prefix on inbound
 * content AND on the `<channel sender="...">` tag attribute, so the
 * agent always sees the friendliest available form.
 */
export function senderDisplayName(sender: {
  username?: string;
  first_name?: string;
  last_name?: string;
  id: number;
}): string {
  const handle = sender.username ? `@${sender.username}` : undefined;
  const fullName = [sender.first_name, sender.last_name]
    .filter(Boolean)
    .join(" ");
  if (fullName && handle) return `${fullName} (${handle})`;
  if (fullName) return fullName;
  if (handle) return handle;
  return String(sender.id);
}
