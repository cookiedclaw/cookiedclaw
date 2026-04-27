<h1 align="center">🍪 cookiedclaw</h1>

<p align="center">
  <i>Universal personal AI agent gateway. MCP-over-HTTP, multi-messenger, multi-runtime.</i>
</p>

<p align="center">
  <a href="https://bun.sh"><img alt="Bun" src="https://img.shields.io/badge/runtime-bun-fbf0df?logo=bun&logoColor=000" /></a>
  <a href="https://modelcontextprotocol.io"><img alt="MCP" src="https://img.shields.io/badge/protocol-MCP%20over%20HTTP-7c3aed" /></a>
  <a href="https://core.telegram.org/bots/api"><img alt="Telegram" src="https://img.shields.io/badge/telegram-bot%20api-26a5e4?logo=telegram&logoColor=fff" /></a>
  <a href="LICENSE"><img alt="MIT" src="https://img.shields.io/badge/license-MIT-22c55e" /></a>
</p>

> [!WARNING]
> **Early development.** Just split out from [`cookiedclaw-claude-code`](https://github.com/cookiedclaw/cookiedclaw-claude-code) (the Claude-Code-specific adapter that ships today). The gateway runs and serves MCP, but adapter-side wiring is in progress — for now use the all-in-one CC adapter directly.

## What this is

A standalone bun process that owns:

- **Messenger transport** — Telegram polling today, Discord / Slack / iMessage / Signal / email later. One bot token, one source of truth for paired-user state.
- **MCP-over-HTTP server** — `StreamableHTTP` transport on `localhost:47390/mcp` with Bearer auth. Any coding-agent runtime that speaks MCP plugs in as a thin adapter.
- **Persistent state** — paired allowlist, pending pairings, per-chat conversation flags survive restarts (`~/.cookiedclaw/access.json`, `~/.cookiedclaw/cache/pending.json`).
- **Tool surface** — `reply`, `react`, `pair`, `revoke_access`, `list_access` exposed via MCP. Adapters call them to talk back to messengers.
- **Localhost progress endpoint** — runtime hooks (CC's Pre/PostToolUse, Codex's equivalents) POST tool events here to drive the live progress message in chat.

Adapters (currently [cookiedclaw-claude-code](https://github.com/cookiedclaw/cookiedclaw-claude-code), planned: `-codex`, `-cursor`, `-opencode`) are config-only plugins for their respective runtimes that connect to this gateway via MCP-over-HTTP.

## Architecture (post-split, target shape)

```
                        ┌──────────────────────────────┐
   Telegram ◄ ─poll─ ─► │   cookiedclaw gateway        │  always-on
   (Discord, Slack,     │   (this repo, bun process)   │  (systemd / launchd)
    iMessage, …)        │                              │
                        │   ┌─ Telegram bot ────────┐  │
                        │   ├─ Paired-user state ───┤  │
                        │   ├─ MCP-over-HTTP server ┤◄ ┤◄── adapter MCP client
                        │   └─ Progress endpoint ───┘  │       (CC plugin /
                        └──────────────────────────────┘        Codex plugin /
                                                                Cursor plugin /
                                                                …)
```

## Run it (development)

```bash
bun install

# ~/.cookiedclaw/keys.env
#   TELEGRAM_BOT_TOKEN=...        # from @BotFather
#   GATEWAY_TOKEN=$(openssl rand -hex 32)
#   GATEWAY_PORT=47390            # optional, default 47390
set -a; . ~/.cookiedclaw/keys.env; set +a

bun run gateway
```

The gateway listens on `127.0.0.1:47390` by default. Adapters set their `.mcp.json` to point at `http://127.0.0.1:47390/mcp` with Bearer `${GATEWAY_TOKEN}`.

## Build a standalone binary

`bun build --compile` produces a single executable per platform:

```bash
bun run build:all   # builds all four
# or just one:
bun run build:linux-arm64
```

Output lands in `dist/`. End users typically don't run this — binaries get attached to GitHub releases automatically (see below).

## Releases

Pushing a version tag (e.g. `v0.1.0`) triggers `.github/workflows/release.yml`, which builds the gateway as a single self-contained executable for each supported platform and attaches all four to a GitHub Release alongside SHA-256 checksums. End users (and the `cookiedclaw-claude-code` adapter's installer) `curl` the binary they need — no Bun install required on the host.

Cutting a release:

```bash
git tag v0.1.0
git push --tags
```

Available platforms (matches `bun build --compile --target=<…>`):

- `cookiedclaw-gateway-linux-x64`
- `cookiedclaw-gateway-linux-arm64`
- `cookiedclaw-gateway-darwin-arm64`
- `cookiedclaw-gateway-darwin-x64`

## Roadmap

- **Adapter→gateway skill catalog push** — runtime adapters tell the gateway what skills are available so `/skills` can render the unified menu (today the gateway shows a placeholder).
- **Permission-relay routing** — adapter forwards CC permission prompts via gateway HTTP API; gateway dispatches `[✓ Allow] / [✗ Deny]` inline buttons.
- **Multi-adapter coordination** — gateway holds a presence map of connected adapters and routes inbound DMs to whichever runtime owns the chat (per-workspace agent identity).
- **Multi-messenger transport plugins** — Discord, Slack, iMessage, Signal, email each as a transport module under the same paired-user/state layer.
- **GitHub Actions release workflow** — `build:all` on tag, attach binaries to release.

## Related

- **[cookiedclaw-claude-code](https://github.com/cookiedclaw/cookiedclaw-claude-code)** — the Claude Code adapter (currently still all-in-one; will become a thin gateway client)
- **[cookiedclaw/landing](https://github.com/cookiedclaw/landing)** — pitch page
- **[cookiedclaw/.github](https://github.com/cookiedclaw/.github)** — org profile

---

<p align="center">
  <sub>made in Bishkek · MIT · 🍪</sub>
</p>
