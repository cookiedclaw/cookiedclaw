/**
 * Live MCP server registry — owns the set of currently-connected
 * per-session McpServer instances and provides broadcast helpers.
 *
 * Each new /mcp session spawns a fresh McpServer (the SDK's `Server`
 * Protocol class can only be connected to one transport at a time, so
 * a module-level singleton breaks every reconnect with "Already
 * connected to a transport"). gateway.ts owns add/remove; the singleton
 * bot listeners (inbound, permission-relay) call `broadcast(...)` to
 * fan a notification out to every connected adapter.
 *
 * Today there's only ever one CC adapter connecting, so broadcast is
 * effectively a single send — but the shape is correct for future
 * multi-adapter coordination and removes a class of singleton bugs.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

export const liveServers = new Set<McpServer>();

/**
 * Send a notification to every connected MCP server. Failures on any
 * one server are logged and don't stop the others — a wedged transport
 * shouldn't black-hole legitimate inbound for everyone else.
 */
export async function broadcastNotification(notification: {
  method: string;
  params?: Record<string, unknown>;
}): Promise<void> {
  if (liveServers.size === 0) {
    // No adapter is connected. Drop with a debug-style log so we don't
    // spam the journal under normal "between sessions" windows.
    return;
  }
  await Promise.all(
    [...liveServers].map(async (server) => {
      try {
        await server.server.notification(notification);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(
          `[live-servers] notification ${notification.method} failed on one server: ${msg}`,
        );
      }
    }),
  );
}
