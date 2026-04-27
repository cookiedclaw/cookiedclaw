/**
 * Bidirectional Telegram attachments.
 *
 * Outbound — `[embed:path]` / `[file:path]` markers in CC's reply text:
 *   - extractEmbeds  : pull markers from text, return cleaned text + list
 *   - resolveEmbed   : turn a path / URL into an InputFile (URLs are
 *                      downloaded ourselves; Telegram's URL fetcher is
 *                      flaky on signed/CDN links)
 *   - sendReply      : send text + attachments with the right shape
 *                      (single embed + short text → caption combo;
 *                      otherwise text first then attachments in order)
 *
 * Inbound — Telegram → local file:
 *   - downloadTelegramFile : pull a file_id down to ./.cookiedclaw/inbox/
 */
import { resolve } from "node:path";
import { InputFile, type InlineKeyboard } from "grammy";
import { bot } from "./bot.ts";
import { token } from "./env.ts";
import { sendFormatted, toTelegramMd } from "./format.ts";
import { dlog, inboxDir, workspaceRoot } from "./paths.ts";

export type Embed = { kind: "auto" | "file"; source: string };

const EMBED_REGEX = /\[(embed|file):([^\]\n]+)\]/g;
const IMAGE_EXT_RE = /\.(png|jpe?g|gif|webp|heic|heif|bmp|tiff?)(\?|$)/i;

function looksLikeImage(source: string, mediaType?: string): boolean {
  if (mediaType?.startsWith("image/")) return true;
  return IMAGE_EXT_RE.test(source);
}

/**
 * Heuristic: does this marker payload actually look like a file path or
 * URL we should attach? Catches cases where the model writes
 * `[embed:path]` or `[file:filename]` as inline syntax explanation
 * (e.g. when describing how the markers work) rather than as a real
 * dispatch instruction.
 *
 * Treat as path-ish if it has any of:
 *   - a directory separator (`/` or `\`)
 *   - a leading `~` (home shorthand)
 *   - an http(s):// prefix
 *   - a file extension (3+ chars after a dot near the end)
 */
function looksLikeAttachmentSource(raw: string): boolean {
  const s = raw.trim();
  if (!s) return false;
  if (s.startsWith("~") || s.includes("/") || s.includes("\\")) return true;
  if (/^https?:\/\//i.test(s)) return true;
  if (/\.[A-Za-z0-9]{1,8}$/.test(s)) return true;
  return false;
}

export function extractEmbeds(text: string): {
  embeds: Embed[];
  cleaned: string;
} {
  const embeds: Embed[] = [];
  // Only consume markers that look real; leave unrecognized ones in the
  // text so the user can still see them (and so we don't accidentally
  // strip an explanatory `[embed:...]` from a doc-style answer).
  const cleaned = text
    .replace(EMBED_REGEX, (full, tag: string, src: string) => {
      const source = src.trim();
      if (!looksLikeAttachmentSource(source)) return full;
      embeds.push({ kind: tag === "file" ? "file" : "auto", source });
      return "";
    })
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/^\s+|\s+$/g, "");
  return { embeds, cleaned };
}

/**
 * Resolve an embed source to a Telegram-uploadable payload. We download
 * URLs ourselves rather than handing them to Telegram, because Telegram's
 * URL fetcher is fragile against signed/CDN URLs (fal.ai, S3 presigned,
 * etc.) and times out on large hosts. Local paths get streamed via
 * InputFile.
 */
async function resolveEmbed(
  source: string,
): Promise<{ file: InputFile; isImage: boolean; sizeBytes?: number }> {
  if (/^https?:\/\//i.test(source)) {
    const res = await fetch(source);
    if (!res.ok) throw new Error(`fetch ${source}: HTTP ${res.status}`);
    const mediaType = res.headers.get("content-type") ?? undefined;
    const bytes = new Uint8Array(await res.arrayBuffer());
    const filename = source.split(/[?#]/)[0]?.split("/").pop() || "download";
    return {
      file: new InputFile(bytes, filename),
      isImage: looksLikeImage(source, mediaType),
      sizeBytes: bytes.byteLength,
    };
  }
  const abs = source.startsWith("/") ? source : resolve(workspaceRoot, source);
  const file = Bun.file(abs);
  if (!(await file.exists())) throw new Error(`file not found: ${abs}`);
  return {
    file: new InputFile(abs),
    isImage: looksLikeImage(abs, file.type || undefined),
    sizeBytes: file.size,
  };
}

/** Telegram caption max length (per Bot API). */
const TELEGRAM_CAPTION_LIMIT = 1024;

/**
 * Send the reply text + any extracted attachments. UX strategy:
 *  - One attachment + short text → single sendPhoto/Document with caption
 *    (text appears under the media, no two-message split).
 *  - Anything else → text first, then attachments in order.
 *
 * Failures dispatching individual attachments are logged but never abort
 * the whole reply — the user always at least sees the text answer.
 */
export async function sendReply(
  chatId: number,
  text: string,
  embeds: Embed[],
  replyMarkup?: InlineKeyboard,
): Promise<void> {
  // Fast path: single embed + caption-able text → combined.
  if (embeds.length === 1 && text.length <= TELEGRAM_CAPTION_LIMIT) {
    const embed = embeds[0]!;
    try {
      const { file, isImage } = await resolveEmbed(embed.source);
      const sendAsPhoto = embed.kind === "auto" && isImage;
      const caption = text ? toTelegramMd(text) : undefined;
      const opts: Record<string, unknown> = {};
      if (caption !== undefined) {
        opts.caption = caption;
        opts.parse_mode = "MarkdownV2";
      }
      if (replyMarkup) opts.reply_markup = replyMarkup;
      if (sendAsPhoto) await bot.api.sendPhoto(chatId, file, opts);
      else await bot.api.sendDocument(chatId, file, opts);
      return;
    } catch (err) {
      console.error(
        `[telegram] combined send failed (${embed.source}): ${err instanceof Error ? err.message : err} — falling back to split`,
      );
      // fall through to split path
    }
  }

  if (text) await sendFormatted(chatId, text, replyMarkup);

  for (const embed of embeds) {
    try {
      const { file, isImage } = await resolveEmbed(embed.source);
      // If we're in the split path and there's no text, attach the
      // keyboard to the LAST embed so it's still tappable.
      const opts =
        !text && embed === embeds[embeds.length - 1] && replyMarkup
          ? { reply_markup: replyMarkup }
          : undefined;
      if (embed.kind === "auto" && isImage) {
        await bot.api.sendPhoto(chatId, file, opts);
      } else {
        await bot.api.sendDocument(chatId, file, opts);
      }
    } catch (err) {
      // Internal failure — log for our own debugging but DON'T pollute
      // the chat with "(couldn't attach...)" notices. If the model wrote
      // a bogus marker, the user shouldn't have to see our plumbing
      // complain about it.
      console.error(
        `[telegram] embed dispatch failed (${embed.source}): ${err instanceof Error ? err.message : err}`,
      );
      dlog(`embed failed: ${embed.source}`);
    }
  }
}

/**
 * Pull a Telegram-hosted file down to ./.cookiedclaw/inbox/. CC's
 * Read tool then has a normal local path it can vision-process (for
 * images) or read text from (for everything else). Filenames are
 * timestamp-prefixed so a chatty user sending many files doesn't collide.
 */
export async function downloadTelegramFile(
  fileId: string,
  filename: string,
): Promise<string> {
  const file = await bot.api.getFile(fileId);
  if (!file.file_path) throw new Error("getFile returned no file_path");
  const url = `https://api.telegram.org/file/bot${token}/${file.file_path}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`download ${url}: HTTP ${res.status}`);
  const bytes = new Uint8Array(await res.arrayBuffer());
  // Sanitize filename — Telegram lets users name files arbitrarily and
  // we don't want to be on the wrong side of any path-traversal cleverness.
  const safe = filename.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 80);
  const target = resolve(inboxDir, `${Date.now()}_${safe}`);
  await Bun.write(target, bytes);
  return target;
}
