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
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { loadAccess } from "./access.ts";
import { bot } from "./bot.ts";
import { loadPending } from "./chat-state.ts";
import { allowAll, allowedUsers, hasToken } from "./env.ts";
import {
  broadcastNotification,
  createMcpInstance,
  disposeMcpInstance,
} from "./mcp.ts";
import { startProgressServer } from "./progress-server.ts";

// Side-effect import: bot.callbackQuery handler for permission-relay
// verdict buttons (the per-instance MCP notification handler is wired
// up inside createMcpInstance() in mcp.ts).
import "./permission-relay.ts";
// Side-effect import: bot.on(...) handlers for inbound Telegram traffic.
import "./inbound.ts";

// Bumped per release. Surfaced via `/health` and used by the
// auto-update check on session init to compare against
// github.com/cookiedclaw/cookiedclaw releases/latest.
const SELF_VERSION = "0.1.3";

const GATEWAY_PORT = Number(process.env.GATEWAY_PORT ?? 47390);
const GATEWAY_HOST = process.env.GATEWAY_HOST ?? "127.0.0.1";
// Brand-prefixed name; same one the adapter's .mcp.json and the setup
// wizard write into keys.env. There's no unprefixed legacy form to
// support — gateway has only ever existed with the prefix; the
// inconsistency was a code typo, not historical baggage.
const GATEWAY_TOKEN = process.env.COOKIEDCLAW_GATEWAY_TOKEN;

if (!GATEWAY_TOKEN) {
  console.error(
    "[gateway] FATAL: COOKIEDCLAW_GATEWAY_TOKEN env var is required. This is the Bearer token adapters present to authenticate against the MCP-over-HTTP endpoint. Generate one with `openssl rand -hex 32` and add it to your workspace's `.cookiedclaw/keys.env` (the setup wizard does this automatically).",
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

// Per-session McpServer + Transport pair. Both halves of the SDK are
// single-connection by design — Server (the Protocol underneath
// McpServer) can only be `connect()`-ed to one Transport at a time, and
// StreamableHTTPServerTransport binds to one client after init. So each
// new MCP-over-HTTP session gets its own pair; multiple concurrent
// clients (CC reconnect storms, ad-hoc + daemon, etc.) each isolated.
//
// Inbound notifications (Telegram messages, /stop, permission verdicts)
// fan out to every active McpServer via broadcastNotification.
type Session = {
  transport: StreamableHTTPServerTransport;
  mcp: McpServer;
};
const sessions = new Map<string, Session>();

function isInitializeRequest(body: unknown): boolean {
  if (!body || typeof body !== "object") return false;
  const m = (body as { method?: unknown }).method;
  return m === "initialize";
}

// Auto-update notice — on every session-init we check GitHub releases
// for a newer tag and (if any) emit a single channel notification so
// the agent can mention it to the user. Cached for an hour to avoid
// hammering api.github.com on adapter reconnect storms.
const UPDATE_CHECK_TTL_MS = 60 * 60 * 1000;
let updateCache:
  | { available: false; checkedAt: number }
  | { available: true; latest: string; checkedAt: number }
  | null = null;

async function checkForUpdate(): Promise<void> {
  if (updateCache && Date.now() - updateCache.checkedAt < UPDATE_CHECK_TTL_MS) {
    return;
  }
  try {
    const resp = await fetch(
      "https://api.github.com/repos/cookiedclaw/cookiedclaw/releases/latest",
      {
        headers: { Accept: "application/vnd.github+json" },
        signal: AbortSignal.timeout(5_000),
      },
    );
    if (!resp.ok) {
      // Don't poison the cache on transient errors — leave whatever
      // we had so the next session-init re-tries.
      console.error(`[gateway] update check failed: HTTP ${resp.status}`);
      return;
    }
    const data = (await resp.json()) as { tag_name?: string };
    const latest = (data.tag_name ?? "").replace(/^v/, "");
    if (latest && latest !== SELF_VERSION) {
      updateCache = { available: true, latest, checkedAt: Date.now() };
      console.error(
        `[gateway] update available: v${SELF_VERSION} -> v${latest}`,
      );
    } else {
      updateCache = { available: false, checkedAt: Date.now() };
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[gateway] update check errored: ${msg}`);
  }
}

async function notifyUpdateIfAvailable(): Promise<void> {
  await checkForUpdate();
  if (!updateCache?.available) return;
  await broadcastNotification({
    method: "notifications/claude/channel",
    params: {
      content: `cookiedclaw gateway update available: v${SELF_VERSION} → v${updateCache.latest}. Run \`/cookiedclaw:setup\` to upgrade — wizard re-downloads the latest binary, idempotent on existing config.`,
      meta: {
        kind: "update_available",
        source: "cookiedclaw",
        current: SELF_VERSION,
        latest: updateCache.latest,
      },
    },
  });
}

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
        version: SELF_VERSION,
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
      const sessionHeader = req.headers["mcp-session-id"];
      const sessionId = Array.isArray(sessionHeader)
        ? sessionHeader[0]
        : sessionHeader;

      let transport: StreamableHTTPServerTransport;
      if (sessionId && sessions.has(sessionId)) {
        transport = sessions.get(sessionId)!.transport;
      } else if (!sessionId && req.method === "POST" && isInitializeRequest(body)) {
        // New session: mint a fresh McpServer + Transport pair so this
        // client gets its own Protocol context. mcp.ts's
        // createMcpInstance() registers tools/permission-handler and
        // adds the new instance to activeInstances so broadcast
        // notifications reach it.
        const newMcp = createMcpInstance();
        const newTransport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => crypto.randomUUID(),
          onsessioninitialized: (sid: string) => {
            sessions.set(sid, { transport: newTransport, mcp: newMcp });
            console.error(`[gateway] /mcp session opened: ${sid}`);
            // Tell the new client about an available update, if any.
            // Fire-and-forget — failures are logged in the helper and
            // shouldn't block the session from being usable.
            void notifyUpdateIfAvailable();
          },
        });
        newTransport.onclose = () => {
          // Remove stale entries + dispose mcp instance when transport
          // closes; client must re-initialize on next request.
          for (const [sid, s] of sessions) {
            if (s.transport === newTransport) {
              sessions.delete(sid);
              disposeMcpInstance(s.mcp);
              console.error(`[gateway] /mcp session closed: ${sid}`);
              break;
            }
          }
        };
        await newMcp.connect(newTransport);
        transport = newTransport;
      } else {
        // Missing or stale session ID and not an initialize — tell the
        // client to start over with a fresh init.
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            jsonrpc: "2.0",
            error: {
              code: -32000,
              message: sessionId
                ? `Unknown or expired session: ${sessionId}`
                : "Initialize first (POST /mcp with method=initialize)",
            },
            id: null,
          }),
        );
        return;
      }

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
