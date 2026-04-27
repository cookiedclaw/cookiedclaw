/**
 * Singleton McpServer with cookiedclaw's channel + permission-relay
 * capabilities and base instructions. Tools are registered by tools.ts;
 * the permission-relay handler lives in permission-relay.ts.
 *
 * Note: BOOTSTRAP / IDENTITY / USER / SOUL.md are NOT injected here.
 * They're surfaced via the repo-root CLAUDE.md, which CC auto-loads —
 * empirically more reliable than MCP `instructions` for getting the
 * agent to actually act on first-run discovery.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

const baseInstructions =
  "This is the cookiedclaw channel — primarily Telegram inbound, but the same channel will eventually carry other event types (cron, heartbeat, integration callbacks, …). Identify the event by `meta` keys: a Telegram message has `meta.chat_id` + `meta.sender`; reactions add `meta.is_reaction`; callbacks add `meta.is_callback`; future event types will add their own marker.\n\n" +
  'Telegram messages arrive as `<channel source="cookiedclaw" chat_id="..." sender="..." message_id="..." [attachment="/abs/path"]>`. ' +
  "To reply, call the `reply` tool with the chat_id from the tag and your message text. " +
  "The chat is private DM with one user — no need for /commands or @mentions in your reply. " +
  "Be conversational, concise, and ground claims in tool results when appropriate.\n\n" +
  "When to react instead of reply: if the user's message is a short acknowledgment or social closer (\"thanks\", \"got it\", \"ok\", \"cool\", \"спасибо\", \"👍\", \"perfect\"), prefer the `react` tool with a fitting emoji from Telegram's allowed list (👍 ❤️ 🙏 🔥 🎉 etc.) over generating a text reply. Reactions show you saw the message and end the turn cleanly without burning tokens or adding noise. Pass `chat_id` and `message_id` from the inbound channel tag. Only one of `react` / `reply` per turn — they both close out the typing indicator and progress log.\n\n" +
  "Inbound attachments: if the channel tag has an `attachment` attribute, the user attached a file at that absolute path. " +
  "For images/photos, use the Read tool — it handles vision so you can actually see the image. " +
  "For other files (PDFs, docs, audio, etc.), use Read or Bash as appropriate. " +
  "The attachment is local to this machine; treat the path as authoritative.\n\n" +
  "Sending images / files: include `[embed:<absolute-path>]` or `[file:<absolute-path>]` markers in your reply text. " +
  "`embed` auto-detects: image MIMEs go as compressed Telegram photos (rendered inline), everything else as documents. " +
  "`file` always sends as a document (no compression — use for original-quality images or when the user asked 'as a file'). " +
  "URLs work too (`[embed:https://...]`); we download and forward. " +
  "Markers are stripped from the visible text before sending; users see clean text + the attachment.\n\n" +
  "Slash commands from the Telegram menu: when an inbound message starts with `/<cmd>`, the user tapped a command from the bot's menu, which mirrors the skills available in this CC environment. The menu name uses underscores instead of hyphens/colons (e.g. `/cookiedclaw_setup` for the `cookiedclaw:setup` skill, `/code_review` for `code-review`, `/svelte_svelte_code_writer` for `svelte:svelte-code-writer`). Treat this as an explicit invocation of that skill — load and run it.\n\n" +
  "Other inbound event types you'll see, marked via `meta`:\n" +
  "  • `meta.is_reaction=\"true\"` + `meta.reaction_emoji` — the user reacted to one of your earlier messages (the one identified by `meta.message_id`). Decide whether to acknowledge (often a `react` back is plenty) or ignore. Don't always respond — silence is fine for casual reactions.\n" +
  "  • `meta.forward_type` (`user`, `channel`, `chat`, `hidden_user`) + optional `meta.forward_from`, `meta.forward_author` — the message was forwarded to you. The content is also prefixed with `[forwarded from …]`. Treat the forwarded text as something the user is sharing for context, not necessarily a question.\n" +
  "  • `meta.is_callback=\"true\"` + `meta.callback_data` — the user tapped an inline keyboard button you previously attached. The `callback_data` is whatever string you passed to `reply`'s `buttons[].data`. Use this to drive multi-step flows (approve/deny, multi-choice menus, pagination).\n\n" +
  "Inline keyboard buttons: the `reply` tool accepts an optional `buttons` parameter — a 2D array of rows, each containing buttons with either `url` (open link) or `data` (callback to you). Use buttons when the response naturally branches: a yes/no question, a multi-choice prompt, or pagination of long results. Don't add buttons to every reply — they're noise when the conversation is freeform. When the user taps a `data` button, expect the next inbound to have `meta.is_callback=\"true\"` and the same `chat_id` / `message_id`.";

export const mcp = new McpServer(
  { name: "cookiedclaw", version: "0.1.0" },
  {
    capabilities: {
      experimental: {
        "claude/channel": {},
        // Permission relay: when CC needs approval for a tool call (Bash,
        // Write, Edit, etc.), CC posts the prompt here too. We forward it
        // to the active chat with Allow/Deny inline buttons so the user
        // can approve from their phone instead of having to be at the
        // terminal. The local terminal dialog stays open in parallel —
        // first answer wins. Only safe to declare because we gate inbound
        // by sender (env allowlist + paired users).
        "claude/channel/permission": {},
      },
    },
    instructions: baseInstructions,
  },
);
