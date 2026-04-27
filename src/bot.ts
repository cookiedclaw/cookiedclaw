/**
 * Singleton grammy `Bot` instance for the whole process.
 *
 * Constructed even when there's no real token (using a placeholder) so
 * the rest of the codebase — which references `bot.api.*` from many
 * places — doesn't have to guard with `if (bot)` everywhere. We never
 * call `bot.start()` when `hasToken === false`, so the placeholder
 * never hits Telegram. Stray `bot.api.*` calls would 401 — every
 * handler that touches them already wraps in try/catch.
 */
import { Bot } from "grammy";
import { token } from "./env.ts";

export const bot = new Bot(token ?? "0:no-token-yet");

bot.catch((err) => {
  console.error(`[telegram] grammy error: ${err.message}`);
});
