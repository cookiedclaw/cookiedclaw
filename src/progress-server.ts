/**
 * Localhost HTTP listener that the Pre/PostToolUse hook script POSTs
 * tool events to. Hooks fire as a fresh subprocess per tool call and
 * have no access to our process state — this endpoint is the bridge.
 *
 * Binds the single well-known port `PROGRESS_PORT` (47291) and writes
 * it to `.cookiedclaw/cache/progress.port` (where the hook reads from).
 * Every incoming POST body is dispatched as a `ProgressPayload` into
 * `handleProgress`.
 *
 * On `EADDRINUSE` we exit fatally instead of falling back to a neighbor
 * port. Neighbor-port fallback is dangerous: a second gateway invoked
 * by accident (manual `cookiedclaw-gateway` from a shell, setup wizard
 * re-running, …) would find :47291 busy, bind :47292, overwrite the
 * shared port file with `47292`, and then die or sit unreachable —
 * leaving the live gateway on :47291 alive but unreachable to hooks
 * because the port file points at the dead twin. Failing loudly when
 * :47291 is already taken forces the operator to kill the duplicate
 * instead of silently corrupting the running install. There's only
 * ever supposed to be one gateway per workspace.
 */
import { dlog, portFile } from "./paths.ts";
import { handleProgress, type ProgressPayload } from "./progress.ts";

export const PROGRESS_PORT = 47291;

export async function startProgressServer(): Promise<void> {
  try {
    Bun.serve({
      port: PROGRESS_PORT,
      hostname: "127.0.0.1",
      async fetch(req) {
        if (req.method !== "POST") {
          return new Response("method", { status: 405 });
        }
        try {
          const body = (await req.json()) as ProgressPayload;
          await handleProgress(body);
          return new Response("ok");
        } catch (err) {
          console.error(
            `[telegram] /progress error: ${err instanceof Error ? err.message : err}`,
          );
          return new Response("error", { status: 500 });
        }
      },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const portTaken =
      /EADDRINUSE/i.test(msg) ||
      /in use/i.test(msg) ||
      /address already in use/i.test(msg);
    if (portTaken) {
      console.error(
        `[gateway] FATAL: progress port ${PROGRESS_PORT} is already in use. Another cookiedclaw-gateway is likely running for this workspace. Find it with \`pgrep -af cookiedclaw-gateway\` and stop the duplicate, or \`systemctl --user restart cookiedclaw-gateway.service\` to reset cleanly.`,
      );
    } else {
      console.error(
        `[gateway] FATAL: failed to bind progress port ${PROGRESS_PORT}: ${msg}`,
      );
    }
    dlog(`server failed to bind :${PROGRESS_PORT}: ${msg}`);
    process.exit(1);
  }

  await Bun.write(portFile, String(PROGRESS_PORT));
  console.error(
    `[telegram] progress endpoint http://127.0.0.1:${PROGRESS_PORT}/ (port written to ${portFile})`,
  );
  dlog(`server up on :${PROGRESS_PORT}, port file ${portFile}`);
}
