/**
 * Child runtime supervisor.
 *
 * Replaces the old two-systemd-units topology (gateway.service +
 * cookiedclaw.service): the gateway now spawns and watches the Claude
 * Code launcher itself. Single unit, single supervision tree, fewer
 * moving parts to misconfigure.
 *
 * What it does:
 *   1. Spawn `$COOKIEDCLAW_LAUNCHER` (default ~/.cookiedclaw/launcher.sh)
 *      as a child process. Same script the old cookiedclaw.service
 *      executed — it sources the user's shell rc, exports keys.env, then
 *      `tmux new-session -d 'claude --continue'`.
 *   2. Restart on child exit with exponential backoff (5s → 60s).
 *   3. Watchdog: if no MCP session is live for >disconnectTimeout after
 *      a boot grace, restart the child. This is the actual fix for the
 *      symptom that motivated this whole thing — claude going quietly
 *      MCP-disconnected with the gateway none the wiser.
 *   4. Heartbeat: every heartbeatInterval seconds, ping each live
 *      McpServer with the SDK's Server.ping(). Three consecutive misses
 *      on a server → close its transport, which fires onclose, which
 *      gateway.ts evicts from liveServers; the watchdog then takes over.
 *      Belt-and-suspenders for the case where transport.onclose silently
 *      fails to fire on a dead client.
 *   5. `requestRuntimeRestart()` for the `restart_runtime` MCP tool —
 *      kills the child after a short delay so the tool response can
 *      flush back to claude before claude itself dies.
 *
 * Future multi-bot is just multiple gateway processes (one per
 * workspace). The supervisor is single-child by design: one child per
 * gateway, one gateway per workspace, no shared state between
 * instances. See setup skill / templated unit notes.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { homedir } from "node:os";
import { liveServers } from "./live-servers.ts";

const HOME = homedir();

const LAUNCHER = process.env.COOKIEDCLAW_LAUNCHER ?? `${HOME}/.cookiedclaw/launcher.sh`;
// Boot grace = how long after spawn we wait for claude to open its first
// MCP session before declaring boot failed and restarting. On a fast
// machine claude boots in 5-15s; on a Pi with `--continue` (loading a
// long transcript from disk) + MCP plugin init it can take 2-3 minutes,
// occasionally more. The default is generous on purpose — false-positive
// restart loops kill in-flight tool calls from the user's perspective,
// while a too-long grace just delays recovery in the rare "claude is
// running but never opens a session" case (which is almost always a
// config bug the user should investigate, not race-restart through).
const BOOT_GRACE_MS = (Number(process.env.COOKIEDCLAW_BOOT_GRACE_S) || 600) * 1000;
const DISCONNECT_TIMEOUT_MS =
  (Number(process.env.COOKIEDCLAW_DISCONNECT_TIMEOUT_S) || 60) * 1000;
const HEARTBEAT_INTERVAL_MS =
  (Number(process.env.COOKIEDCLAW_HEARTBEAT_INTERVAL_S) || 30) * 1000;
const HEARTBEAT_TIMEOUT_MS =
  (Number(process.env.COOKIEDCLAW_HEARTBEAT_TIMEOUT_S) || 10) * 1000;
const HEARTBEAT_MISS_LIMIT = 3;

// Backoff schedule (ms) for restart-on-exit. After the last entry we
// stay at the cap. A "stable" run (process up >60s) resets to step 0.
const BACKOFF_SCHEDULE_MS = [5_000, 10_000, 20_000, 30_000, 60_000];
const STABLE_RUN_MS = 60_000;

type SupervisorState =
  | { kind: "off" } // not started yet, or COOKIEDCLAW_LAUNCHER=disabled
  | { kind: "starting"; child: Bun.Subprocess; startedAt: number }
  | { kind: "running"; child: Bun.Subprocess; startedAt: number }
  | { kind: "backoff"; nextSpawnAt: number }
  | { kind: "stopping" };

let state: SupervisorState = { kind: "off" };
let backoffStep = 0;
let totalRestarts = 0;

let bootGraceTimer: Timer | null = null;
let disconnectTimer: Timer | null = null;
let heartbeatTimer: Timer | null = null;
let backoffTimer: Timer | null = null;

const heartbeatMissCounts = new WeakMap<McpServer, number>();

const launcherDisabled =
  LAUNCHER === "disabled" || LAUNCHER === "" || LAUNCHER === "off";

export function supervisorEnabled(): boolean {
  return !launcherDisabled;
}

/**
 * Status snapshot for /health. Numbers are best-effort; the gateway is
 * not the source of truth for "is claude responding to tools" — that's
 * "do tool calls succeed" — but pid + uptime + restarts is enough for
 * an oncall glance.
 */
export function runtimeStatus(): {
  enabled: boolean;
  state: string;
  pid: number | null;
  uptime_s: number | null;
  restarts: number;
  live_sessions: number;
} {
  let pid: number | null = null;
  let uptime_s: number | null = null;
  if (state.kind === "starting" || state.kind === "running") {
    pid = state.child.pid ?? null;
    uptime_s = Math.floor((Date.now() - state.startedAt) / 1000);
  }
  return {
    enabled: !launcherDisabled,
    state: state.kind,
    pid,
    uptime_s,
    restarts: totalRestarts,
    live_sessions: liveServers.size,
  };
}

/**
 * Start the supervisor — call once from gateway.ts after MCP is wired up.
 * Idempotent: a second call while running is a no-op.
 */
export function startSupervisor(): void {
  if (launcherDisabled) {
    console.error(
      `[supervisor] disabled (COOKIEDCLAW_LAUNCHER=${LAUNCHER}). Run claude separately; gateway will accept MCP connections but won't spawn or restart anything.`,
    );
    return;
  }
  if (state.kind !== "off") return;
  spawnChild();
  startHeartbeat();
}

/**
 * Stop the supervisor cleanly: kill the child (SIGTERM, 10s grace,
 * SIGKILL fallback) and disable respawn. Used on gateway shutdown.
 */
export async function shutdownSupervisor(): Promise<void> {
  clearAllTimers();
  if (state.kind === "starting" || state.kind === "running") {
    const child = state.child;
    state = { kind: "stopping" };
    try {
      child.kill("SIGTERM");
    } catch {
      // already dead, fine
    }
    const timeout = new Promise<"timeout">((resolve) =>
      setTimeout(() => resolve("timeout"), 10_000),
    );
    const exited = child.exited.then(() => "exited" as const);
    if ((await Promise.race([exited, timeout])) === "timeout") {
      console.error("[supervisor] child didn't exit on SIGTERM in 10s, SIGKILL");
      try {
        child.kill("SIGKILL");
      } catch {
        // ignore
      }
    }
  } else {
    state = { kind: "stopping" };
  }
}

/**
 * Trigger a restart from outside. Used by the `restart_runtime` tool.
 * Delays the actual kill so the tool response has time to flush back
 * to the calling claude session.
 */
export function requestRuntimeRestart(reason?: string): void {
  if (launcherDisabled) return;
  console.error(
    `[supervisor] restart requested${reason ? `: ${reason}` : ""} — killing child in 2s`,
  );
  setTimeout(() => {
    if (state.kind === "starting" || state.kind === "running") {
      try {
        state.child.kill("SIGTERM");
      } catch {
        // already dead, the exit handler will respawn
      }
    }
  }, 2_000);
}

/**
 * gateway.ts calls this on every onsessioninitialized. Cancels the
 * disconnect timer (we're connected again) and the boot-grace timer
 * (claude phoned home, we're done waiting).
 */
export function notifySessionOpened(): void {
  if (bootGraceTimer) {
    clearTimeout(bootGraceTimer);
    bootGraceTimer = null;
  }
  if (disconnectTimer) {
    clearTimeout(disconnectTimer);
    disconnectTimer = null;
  }
  if (state.kind === "starting") {
    state = { kind: "running", child: state.child, startedAt: state.startedAt };
  }
}

/**
 * gateway.ts calls this on every transport onclose. If no live sessions
 * remain and we're past boot grace, start the disconnect countdown.
 */
export function notifySessionClosed(): void {
  if (liveServers.size > 0) return;
  if (state.kind !== "running") return;
  if (disconnectTimer) return;
  console.error(
    `[supervisor] no live MCP sessions — restarting child in ${DISCONNECT_TIMEOUT_MS / 1000}s if nothing reconnects`,
  );
  disconnectTimer = setTimeout(() => {
    disconnectTimer = null;
    if (liveServers.size > 0) return; // raced with a reconnect
    if (state.kind !== "running") return;
    console.error(
      `[supervisor] disconnect timeout expired with no MCP session — restarting child`,
    );
    try {
      state.child.kill("SIGTERM");
    } catch {
      // already dead, fine
    }
  }, DISCONNECT_TIMEOUT_MS);
}

// -----------------------------------------------------------------------------
// internals
// -----------------------------------------------------------------------------

function spawnChild(): void {
  totalRestarts += 1;
  const startedAt = Date.now();
  console.error(`[supervisor] spawning child: ${LAUNCHER}`);
  let child: Bun.Subprocess;
  try {
    child = Bun.spawn(["bash", LAUNCHER], {
      stdio: ["ignore", "inherit", "inherit"],
      env: process.env,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[supervisor] spawn failed: ${msg} — backing off`);
    scheduleBackoffRestart();
    return;
  }
  state = { kind: "starting", child, startedAt };

  // Boot grace: if claude doesn't open an MCP session within this
  // window, the watchdog kicks in to declare the boot dead and restart.
  bootGraceTimer = setTimeout(() => {
    bootGraceTimer = null;
    if (state.kind !== "starting") return;
    if (liveServers.size > 0) {
      // Session opened during boot grace; notifySessionOpened should
      // have flipped us to running and cleared this timer. Belt-and-
      // suspenders: do the flip here too.
      state = { kind: "running", child: state.child, startedAt: state.startedAt };
      return;
    }
    console.error(
      `[supervisor] boot grace expired with no MCP session — restarting child`,
    );
    try {
      state.child.kill("SIGTERM");
    } catch {
      // already dead, exit handler will respawn
    }
  }, BOOT_GRACE_MS);

  // Track exit. On exit, decide: respawn (with backoff if it died fast)
  // or stay down (if we're shutting down).
  void child.exited.then((code) => {
    const ranFor = Date.now() - startedAt;
    console.error(
      `[supervisor] child exited code=${code} after ${Math.floor(ranFor / 1000)}s`,
    );
    if (bootGraceTimer) {
      clearTimeout(bootGraceTimer);
      bootGraceTimer = null;
    }
    if (disconnectTimer) {
      clearTimeout(disconnectTimer);
      disconnectTimer = null;
    }
    if (state.kind === "stopping") return;
    if (ranFor >= STABLE_RUN_MS) backoffStep = 0;
    scheduleBackoffRestart();
  });
}

function scheduleBackoffRestart(): void {
  const idx = Math.min(backoffStep, BACKOFF_SCHEDULE_MS.length - 1);
  const delay = BACKOFF_SCHEDULE_MS[idx]!;
  backoffStep += 1;
  const nextSpawnAt = Date.now() + delay;
  state = { kind: "backoff", nextSpawnAt };
  console.error(`[supervisor] respawning in ${delay / 1000}s (backoff step ${idx})`);
  backoffTimer = setTimeout(() => {
    backoffTimer = null;
    if (state.kind === "stopping") return;
    spawnChild();
  }, delay);
}

function startHeartbeat(): void {
  if (HEARTBEAT_INTERVAL_MS <= 0) return;
  if (heartbeatTimer) return;
  heartbeatTimer = setInterval(() => {
    void runHeartbeatRound();
  }, HEARTBEAT_INTERVAL_MS);
}

async function runHeartbeatRound(): Promise<void> {
  if (liveServers.size === 0) return;
  await Promise.all(
    [...liveServers].map((server) => pingOne(server)),
  );
}

async function pingOne(server: McpServer): Promise<void> {
  const timeout = new Promise<"timeout">((resolve) =>
    setTimeout(() => resolve("timeout"), HEARTBEAT_TIMEOUT_MS),
  );
  try {
    const result = await Promise.race([
      server.server.ping().then(() => "ok" as const),
      timeout,
    ]);
    if (result === "ok") {
      heartbeatMissCounts.delete(server);
      return;
    }
    // timed out
    const misses = (heartbeatMissCounts.get(server) ?? 0) + 1;
    heartbeatMissCounts.set(server, misses);
    if (misses >= HEARTBEAT_MISS_LIMIT) {
      console.error(
        `[supervisor] heartbeat: ${HEARTBEAT_MISS_LIMIT} consecutive misses, closing transport`,
      );
      heartbeatMissCounts.delete(server);
      try {
        await server.close();
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[supervisor] forced server close errored: ${msg}`);
      }
    } else {
      console.error(`[supervisor] heartbeat miss ${misses}/${HEARTBEAT_MISS_LIMIT}`);
    }
  } catch (err) {
    // ping threw (transport closed mid-flight, e.g.) — count as miss
    const misses = (heartbeatMissCounts.get(server) ?? 0) + 1;
    heartbeatMissCounts.set(server, misses);
    const msg = err instanceof Error ? err.message : String(err);
    if (misses >= HEARTBEAT_MISS_LIMIT) {
      console.error(
        `[supervisor] heartbeat: ${HEARTBEAT_MISS_LIMIT} consecutive errors (${msg}), closing transport`,
      );
      heartbeatMissCounts.delete(server);
      try {
        await server.close();
      } catch {
        // ignore
      }
    }
  }
}

function clearAllTimers(): void {
  if (bootGraceTimer) {
    clearTimeout(bootGraceTimer);
    bootGraceTimer = null;
  }
  if (disconnectTimer) {
    clearTimeout(disconnectTimer);
    disconnectTimer = null;
  }
  if (backoffTimer) {
    clearTimeout(backoffTimer);
    backoffTimer = null;
  }
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
}
