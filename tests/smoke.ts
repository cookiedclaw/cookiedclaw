#!/usr/bin/env bun
/**
 * End-to-end smoke test.
 *
 * Spawns the gateway in a clean tmp workspace with no Telegram token
 * (polling skipped, MCP-only mode), then exercises:
 *   • /health (unauthenticated)
 *   • /mcp 401 on missing Bearer
 *   • /mcp initialize + tools/list + call list_access / revoke_access
 *   • /permission-request ask-fallback when there's no active chat
 *
 * Exits non-zero on the first failure. Designed to run after edits to
 * gateway.ts / mcp.ts / tools.ts / permission-http.ts as a safety net
 * unit tests can't provide.
 */
import { createServer } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const REPO_ROOT = resolve(import.meta.dir, "..");

// ---------- tiny test harness (no extra deps) ------------------------------

let failed = 0;
const ran: string[] = [];

function ok(name: string): void {
  ran.push(`  ✓ ${name}`);
}

function fail(name: string, msg: string): void {
  failed++;
  ran.push(`  ✗ ${name}\n      ${msg}`);
}

function check(name: string, cond: boolean, msg = "expected true"): void {
  if (cond) ok(name);
  else fail(name, msg);
}

// ---------- helpers --------------------------------------------------------

async function freePort(): Promise<number> {
  return new Promise((resolveP, rejectP) => {
    const srv = createServer();
    srv.once("error", rejectP);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      if (!addr || typeof addr === "string") {
        rejectP(new Error("unexpected address shape"));
        return;
      }
      const port = addr.port;
      srv.close(() => resolveP(port));
    });
  });
}

async function waitForHealth(
  base: string,
  child: Bun.Subprocess,
  timeoutMs = 15_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`gateway exited early with code ${child.exitCode}`);
    }
    try {
      const r = await fetch(`${base}/health`);
      if (r.ok) return;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`gateway did not become healthy within ${timeoutMs}ms`);
}

// ---------- main -----------------------------------------------------------

async function main(): Promise<number> {
  const workspace = mkdtempSync(join(tmpdir(), "cookiedclaw-smoke-"));
  const gatewayToken = crypto.randomUUID().replace(/-/g, "");
  const gatewayPort = await freePort();
  const base = `http://127.0.0.1:${gatewayPort}`;

  console.log(`[smoke] workspace=${workspace}`);
  console.log(`[smoke] gateway port=${gatewayPort}`);

  // Build a clean env: drop Telegram tokens (so polling stays off and
  // we never accidentally hit the user's real bot), drop the user's own
  // COOKIEDCLAW_GATEWAY_TOKEN so we only authenticate with our minted
  // one, then layer the test-specific config on top.
  const childEnv: Record<string, string> = { ...process.env } as Record<
    string,
    string
  >;
  delete childEnv.TELEGRAM_BOT_TOKEN;
  delete childEnv.TELEGRAM_API_TOKEN;
  delete childEnv.TELEGRAM_ALLOWED_USERS;
  delete childEnv.COOKIEDCLAW_GATEWAY_TOKEN;
  childEnv.COOKIEDCLAW_LAUNCHER = "disabled";
  childEnv.GATEWAY_PORT = String(gatewayPort);
  childEnv.GATEWAY_HOST = "127.0.0.1";
  childEnv.COOKIEDCLAW_GATEWAY_TOKEN = gatewayToken;

  const child = Bun.spawn(
    ["bun", join(REPO_ROOT, "src", "gateway.ts")],
    {
      cwd: workspace,
      env: childEnv,
      stdout: "inherit",
      stderr: "inherit",
    },
  );

  let exitCode = 1;
  try {
    await waitForHealth(base, child);

    // --- /health ---------------------------------------------------------
    {
      const r = await fetch(`${base}/health`);
      const body = (await r.json()) as Record<string, unknown>;
      check("/health 200", r.status === 200, `got ${r.status}`);
      check(
        "/health status=ok",
        body.status === "ok",
        `got ${JSON.stringify(body)}`,
      );
      check(
        "/health bot_polling=false (no token)",
        body.bot_polling === false,
        `got ${body.bot_polling}`,
      );
      check(
        "/health version is a non-empty string",
        typeof body.version === "string" && (body.version as string).length > 0,
        `got ${body.version}`,
      );
    }

    // --- /mcp without auth -> 401 ---------------------------------------
    {
      const r = await fetch(`${base}/mcp`, { method: "POST", body: "{}" });
      check("GET /mcp without Bearer → 401", r.status === 401, `got ${r.status}`);
    }

    // --- MCP session via SDK client --------------------------------------
    {
      const transport = new StreamableHTTPClientTransport(
        new URL(`${base}/mcp`),
        {
          requestInit: {
            headers: { Authorization: `Bearer ${gatewayToken}` },
          },
        },
      );
      const client = new Client(
        { name: "cookiedclaw-smoke", version: "0" },
        { capabilities: {} },
      );
      await client.connect(transport);

      const tools = await client.listTools();
      const names = tools.tools.map((t) => t.name).sort();
      const expected = [
        "list_access",
        "pair",
        "react",
        "reply",
        "restart_runtime",
        "revoke_access",
      ];
      for (const exp of expected) {
        check(`tools/list contains ${exp}`, names.includes(exp), `got ${names.join(",")}`);
      }

      // list_access on a fresh workspace → "Static (env): (none — pairing-only mode)"
      // and "Paired: (none)"
      const listed = await client.callTool({ name: "list_access", arguments: {} });
      const listedText =
        Array.isArray(listed.content) &&
        listed.content[0] &&
        typeof (listed.content[0] as { text?: unknown }).text === "string"
          ? ((listed.content[0] as { text: string }).text)
          : "";
      check(
        "list_access mentions pairing-only mode",
        listedText.includes("pairing-only mode"),
        `body: ${listedText}`,
      );
      check(
        "list_access mentions Paired: (none)",
        listedText.includes("Paired: (none)"),
        `body: ${listedText}`,
      );

      // revoke_access of an unknown numeric id → "wasn't on the paired list"
      const revoked = await client.callTool({
        name: "revoke_access",
        arguments: { user_id: "424242" },
      });
      const revokedText =
        Array.isArray(revoked.content) &&
        revoked.content[0] &&
        typeof (revoked.content[0] as { text?: unknown }).text === "string"
          ? ((revoked.content[0] as { text: string }).text)
          : "";
      check(
        "revoke_access on unknown id reports not-paired",
        revokedText.includes("wasn't on the paired list"),
        `body: ${revokedText}`,
      );

      // revoke_access with non-numeric input → isError
      const bad = await client.callTool({
        name: "revoke_access",
        arguments: { user_id: "not-a-number" },
      });
      check(
        "revoke_access on garbage input is isError",
        bad.isError === true,
        `got isError=${bad.isError}`,
      );

      // pair with bogus code → isError, mentions expiration hint
      const paired = await client.callTool({
        name: "pair",
        arguments: { code: "nope1" },
      });
      check(
        "pair with bogus code is isError",
        paired.isError === true,
        `got isError=${paired.isError}`,
      );

      // restart_runtime when supervisor is disabled → isError
      const restart = await client.callTool({
        name: "restart_runtime",
        arguments: {},
      });
      check(
        "restart_runtime is isError when supervisor disabled",
        restart.isError === true,
        `got isError=${restart.isError}`,
      );

      await client.close();
    }

    // --- /permission-request --------------------------------------------
    {
      // Malformed body → verdict deny
      const r1 = await fetch(`${base}/permission-request`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${gatewayToken}`,
        },
        body: JSON.stringify({ wrong: true }),
      });
      const b1 = (await r1.json()) as { verdict?: string };
      check(
        "/permission-request malformed body → deny",
        r1.status === 200 && b1.verdict === "deny",
        `status=${r1.status} verdict=${b1.verdict}`,
      );

      // Valid body but no active chat → verdict ask (fast fallback)
      const r2 = await fetch(`${base}/permission-request`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${gatewayToken}`,
        },
        body: JSON.stringify({
          request_id: crypto.randomUUID(),
          flavor: "shell",
          payload: { command: "ls", cwd: "/tmp" },
        }),
      });
      const b2 = (await r2.json()) as { verdict?: string };
      check(
        "/permission-request no active chat → ask",
        r2.status === 200 && b2.verdict === "ask",
        `status=${r2.status} verdict=${b2.verdict}`,
      );

      // Bad auth → 401
      const r3 = await fetch(`${base}/permission-request`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer wrong" },
        body: "{}",
      });
      check(
        "/permission-request bad bearer → 401",
        r3.status === 401,
        `got ${r3.status}`,
      );
    }

    exitCode = failed === 0 ? 0 : 1;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    fail("harness", msg);
    exitCode = 2;
  } finally {
    try {
      child.kill();
      await child.exited;
    } catch {
      // ignore
    }
    try {
      rmSync(workspace, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }

  console.log("\n[smoke] results:");
  for (const line of ran) console.log(line);
  console.log(
    `\n[smoke] ${ran.length - failed}/${ran.length} passed${failed === 0 ? "" : ` (${failed} failed)`}`,
  );

  return exitCode;
}

const code = await main();
process.exit(code);
