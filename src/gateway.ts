#!/usr/bin/env bun
/**
 * cookiedclaw gateway — entry point.
 *
 * Always-on bun process that:
 *  1. Polls Telegram for inbound messages, attachments, reactions, callbacks
 *  2. Holds paired-user state, pending pairings, per-chat conversation state
 *  3. Exposes an MCP-over-HTTP server (StreamableHTTP transport) so any
 *     coding-agent runtime that speaks MCP can plug in as a thin adapter
 *  4. Continues to host the localhost progress endpoint that runtime hooks
 *     POST to (Pre/PostToolUse → live editing in Telegram)
 *
 * Adapters (cookiedclaw-claude-code, future -codex / -cursor / -opencode)
 * connect to `http://127.0.0.1:${GATEWAY_PORT}/mcp` with a Bearer token.
 * The gateway's MCP server delivers inbound channel events to the adapter
 * (which forwards them into its host runtime as `<channel source="cookiedclaw">`
 * notifications), and the adapter calls back into the gateway's tools
 * (`reply` / `react` / `pair` / `revoke_access` / `list_access`) to talk
 * back to Telegram.
 *
 * Environment (read from process env, typically populated by a systemd
 * EnvironmentFile pointing at ~/.cookiedclaw/keys.env):
 *   TELEGRAM_BOT_TOKEN     — bot token from @BotFather
 *   TELEGRAM_ALLOWED_USERS — optional, comma-separated, "*" for any
 *   GATEWAY_PORT           — HTTP port to bind to (default 47390)
 *   GATEWAY_TOKEN          — required, Bearer token adapters present
 *   GATEWAY_HOST           — bind address (default 127.0.0.1; use
 *                            0.0.0.0 only behind a reverse proxy)
 */
import { createServer, type IncomingMessage } from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { loadAccess } from "./access.ts";
import { bot } from "./bot.ts";
import { loadPending } from "./chat-state.ts";
import { allowAll, allowedUsers, hasToken } from "./env.ts";
import { mcp } from "./mcp.ts";
import { startProgressServer } from "./progress-server.ts";

// Side-effect imports: each registers handlers / tools on `mcp` or `bot`.
import "./tools.ts";
import "./inbound.ts";
import "./permission-relay.ts";

const GATEWAY_PORT = Number(process.env.GATEWAY_PORT ?? 47390);
const GATEWAY_HOST = process.env.GATEWAY_HOST ?? "127.0.0.1";
const GATEWAY_TOKEN = process.env.GATEWAY_TOKEN;

if (!GATEWAY_TOKEN) {
  console.error(
    "[gateway] FATAL: GATEWAY_TOKEN env var is required. This is the Bearer token adapters present to authenticate against the MCP-over-HTTP endpoint. Generate one with `openssl rand -hex 32` and set it in ~/.cookiedclaw/keys.env.",
  );
  process.exit(1);
}

await loadAccess();
// Restore pendingChats + activeChatId from disk BEFORE the MCP server
// connects — otherwise the adapter's resumed session can fire its first
// PreToolUse hook into an empty pending set, and the user sees the
// agent working with no typing/progress until they send a fresh
// inbound. See chat-state.ts for the full rationale.
await loadPending();
await startProgressServer();

// One transport per gateway process. Adapters connect with an arbitrary
// session ID (we generate one on first request via sessionIdGenerator)
// and reuse it for the lifetime of their connection. Reconnects after
// crashes get a fresh session, which is fine — no per-session state we
// need to preserve here.
const transport = new StreamableHTTPServerTransport({
  sessionIdGenerator: () => crypto.randomUUID(),
});

await mcp.connect(transport);

function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk: Buffer) => {
      data += chunk.toString("utf8");
    });
    req.on("end", () => {
      if (!data) {
        resolve(undefined);
        return;
      }
      try {
        resolve(JSON.parse(data));
      } catch (err) {
        reject(err);
      }
    });
    req.on("error", reject);
  });
}

const server = createServer(async (req, res) => {
  const url = req.url ?? "/";

  // Health check is unauthenticated so an outer supervisor can probe
  // liveness without baking the token into its config.
  if (url === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        status: "ok",
        bot_polling: hasToken,
        version: "0.1.0",
      }),
    );
    return;
  }

  // Everything else needs the Bearer token. Reject clearly on the wrong
  // header so adapters see a useful error instead of a generic hang.
  const auth = req.headers.authorization ?? "";
  if (auth !== `Bearer ${GATEWAY_TOKEN}`) {
    res.writeHead(401, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "unauthorized", hint: "set Authorization: Bearer <GATEWAY_TOKEN>" }));
    return;
  }

  if (url === "/mcp" || url.startsWith("/mcp?")) {
    try {
      const body = req.method === "POST" ? await readBody(req) : undefined;
      await transport.handleRequest(req, res, body);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[gateway] /mcp error: ${msg}`);
      if (!res.writableEnded) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: msg }));
      }
    }
    return;
  }

  res.writeHead(404, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: "not found" }));
});

server.listen(GATEWAY_PORT, GATEWAY_HOST, () => {
  console.error(
    `[gateway] MCP-over-HTTP on http://${GATEWAY_HOST}:${GATEWAY_PORT}/mcp`,
  );
});

if (hasToken) {
  console.error("[gateway] starting bot polling...");
  void bot.start({
    drop_pending_updates: true,
    // Telegram only delivers reactions / inline-keyboard callbacks if we
    // explicitly subscribe. The default getUpdates set excludes them.
    allowed_updates: [
      "message",
      "edited_message",
      "callback_query",
      "message_reaction",
    ],
    onStart: (info) => {
      console.error(
        `[gateway] bot @${info.username} ready (allowlist size: ${allowAll ? "ALL" : allowedUsers.size})`,
      );
    },
  });
} else {
  console.error(
    "[gateway] no TELEGRAM_BOT_TOKEN — running in MCP-only mode (tools registered, no inbound messenger).",
  );
}
