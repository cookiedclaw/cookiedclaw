/**
 * Per-test-file setup helper.
 *
 * The src modules have heavy module-load side effects driven by
 * `process.cwd()` (`paths.ts` mkdir's `.cookiedclaw/`, `env.ts` reads
 * `.cookiedclaw/keys.env`, `access.ts` resolves `access.json`). To keep
 * each test file isolated we chdir into a fresh tmp dir BEFORE importing
 * anything from `src/`, then dynamic-import the module under test.
 *
 * Pattern in each *.test.ts:
 *   import { setupTestWorkspace } from "./setup.ts";
 *   const ctx = setupTestWorkspace();
 *   const mod = await import("../src/<module>.ts");
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export type TestCtx = {
  /** Absolute path to the per-file workspace tmp dir. */
  dir: string;
  /** Restore the previous cwd. Call from afterAll if you care; the tmp
   *  dir is also auto-deleted on process exit. */
  cleanup: () => void;
};

export function setupTestWorkspace(prefix = "cookiedclaw-test-"): TestCtx {
  const prev = process.cwd();
  const dir = mkdtempSync(join(tmpdir(), prefix));
  process.chdir(dir);
  let cleaned = false;
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    try {
      process.chdir(prev);
    } catch {
      // prev may be a deleted worktree; not fatal.
    }
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // best-effort
    }
  };
  process.on("exit", cleanup);
  return { dir, cleanup };
}
