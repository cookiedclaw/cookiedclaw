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
 * Send formatted text with MarkdownV2; if Telegram rejects the markdown
 * (rare edge cases telegramify doesn't catch), retry as plain text so
 * we never silently drop a message just because of escape ambiguity.
 */
export async function sendFormatted(
  chatId: number,
  text: string,
  replyMarkup?: InlineKeyboard,
): Promise<void> {
  const md = toTelegramMd(text);
  const opts: Record<string, unknown> = { parse_mode: "MarkdownV2" };
  if (replyMarkup) opts.reply_markup = replyMarkup;
  try {
    await bot.api.sendMessage(chatId, md, opts);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/can't parse|markdown|entities/i.test(msg)) {
      console.error(
        `[telegram] markdown parse error, retrying plain: ${msg}`,
      );
      const plainOpts = replyMarkup
        ? { reply_markup: replyMarkup }
        : undefined;
      await bot.api.sendMessage(chatId, text, plainOpts);
    } else {
      throw err;
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
