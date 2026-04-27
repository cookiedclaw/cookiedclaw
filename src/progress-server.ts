/**
 * Localhost HTTP listener that the Pre/PostToolUse hook script POSTs
 * tool events to. Hooks fire as a fresh subprocess per tool call and
 * have no access to our process state — this endpoint is the bridge.
 *
 * Picks an open port in [47291, 47391), writes it to ~/.cache/cookiedclaw/
 * progress.port (where the hook reads it from), and dispatches every
 * incoming POST body as a `ProgressPayload` into `handleProgress`.
 */
import { dlog, portFile } from "./paths.ts";
import { handleProgress, type ProgressPayload } from "./progress.ts";

const PROGRESS_PORT_BASE = 47291;

export async function startProgressServer(): Promise<void> {
  let progressPort: number | undefined;

  for (let i = 0; i < 100; i++) {
    const port = PROGRESS_PORT_BASE + i;
    try {
      Bun.serve({
        port,
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
      progressPort = port;
      break;
    } catch (err) {
      // Bun's "port in use" error is a stringy "Failed to start server.
      // Is port N in use?" — no EADDRINUSE token in the message. Sniff
      // for any hint of port-in-use and retry; otherwise break out with
      // the real cause.
      const msg = err instanceof Error ? err.message : String(err);
      const portTaken =
        /EADDRINUSE/i.test(msg) ||
        /in use/i.test(msg) ||
        /address already in use/i.test(msg);
      if (!portTaken) {
        console.error(
          `[telegram] failed to bind progress port ${port}: ${msg}`,
        );
        break;
      }
    }
  }

  if (progressPort === undefined) {
    console.error(
      `[telegram] couldn't bind any progress port — tool log will be missing in chat`,
    );
    dlog(`server failed to bind any port`);
    return;
  }

  await Bun.write(portFile, String(progressPort));
  console.error(
    `[telegram] progress endpoint http://127.0.0.1:${progressPort}/ (port written to ${portFile})`,
  );
  dlog(`server up on :${progressPort}, port file ${portFile}`);
}
