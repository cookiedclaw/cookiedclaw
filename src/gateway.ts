#!/usr/bin/env bun
/**
 * cookiedclaw-gateway — CLI entry point.
 *
 * Thin dispatcher. Default behaviour (no args) runs the gateway main
 * loop; subcommands handle out-of-band operations like `update` and
 * informational flags like `--version` / `--help`.
 *
 * The main-loop module (`./run-gateway.ts`) is dynamic-imported only on
 * the default path. This is deliberate: importing it eagerly would
 * pull in `env.ts`/`bot.ts` and their module-load side effects (token
 * warnings on stderr, fatal exit if COOKIEDCLAW_GATEWAY_TOKEN is unset),
 * which would make `--version` / `update` unusable on a fresh machine
 * where keys.env doesn't yet exist.
 *
 * Build entry stays `./src/gateway.ts` — see package.json `build:*`
 * scripts and .github/workflows/release.yml.
 */
import { VERSION } from "./version.ts";

function printHelp(): void {
  process.stdout.write(`cookiedclaw-gateway v${VERSION}

Usage:
  cookiedclaw-gateway              Run the gateway (default).
  cookiedclaw-gateway --version    Print version and exit.
  cookiedclaw-gateway --help       Print this help and exit.
  cookiedclaw-gateway update       Fetch the latest release for this
                                   platform, verify sha256, swap the
                                   binary in ~/.cookiedclaw/bin/, and
                                   restart cookiedclaw-gateway.service
                                   if it is active.

Run-gateway environment (consumed only by the default mode):
  COOKIEDCLAW_GATEWAY_TOKEN  required — Bearer token for /mcp
  TELEGRAM_BOT_TOKEN         optional — enables Telegram polling
  TELEGRAM_ALLOWED_USERS     optional — comma list, "*" for any
  GATEWAY_PORT               default 47390
  GATEWAY_HOST               default 127.0.0.1
  COOKIEDCLAW_LAUNCHER       path to launcher.sh (or "disabled")

Repo: https://github.com/cookiedclaw/cookiedclaw
`);
}

const cmd = process.argv[2];

if (cmd === "--version" || cmd === "-v") {
  process.stdout.write(`${VERSION}\n`);
  process.exit(0);
}

if (cmd === "--help" || cmd === "-h") {
  printHelp();
  process.exit(0);
}

if (cmd === "update") {
  const { runUpdate } = await import("./cli/update.ts");
  process.exit(await runUpdate());
}

// Anything that looks like a subcommand but isn't recognized — bail out
// with help rather than silently launching the gateway, because the
// user clearly intended something specific.
if (cmd && !cmd.startsWith("-")) {
  process.stderr.write(`cookiedclaw-gateway: unknown subcommand '${cmd}'\n\n`);
  printHelp();
  process.exit(2);
}

// Default: run the gateway main loop.
const { runGateway } = await import("./run-gateway.ts");
await runGateway();
