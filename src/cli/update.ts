/**
 * `cookiedclaw-gateway update` — self-update from the latest GitHub
 * release. Run by a user externally (not from inside the daemon's own
 * process), so it's safe to `systemctl --user restart` ourselves: the
 * restart targets the service unit, not this invocation.
 *
 * Flow:
 *   1. Detect platform/arch → pick the matching release asset.
 *   2. Query GH API for the latest release tag + asset URLs.
 *   3. Short-circuit if the tag matches `VERSION`.
 *   4. Download binary + .sha256 sidecar into ~/.cookiedclaw/bin/ as
 *      `*.new`, verify the hash before touching the live binary.
 *   5. Atomic-ish swap: rename current → .bak, rename .new → current.
 *      `.bak` retained for one-step manual rollback.
 *   6. If `cookiedclaw-gateway.service` is `is-active`, restart it.
 *      Otherwise just leave the new binary on disk (fresh installs
 *      where setup hasn't started the unit yet should skip restart).
 *
 * Helpers are exported so tests can exercise the pure pieces without
 * hitting the network or filesystem.
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, mkdir, rename, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { VERSION } from "../version.ts";

const REPO = "cookiedclaw/cookiedclaw";
const SERVICE_NAME = "cookiedclaw-gateway";

export type Platform = "darwin" | "linux";
export type Arch = "arm64" | "x64";

/**
 * Map `process.platform` + `process.arch` to the release asset name.
 * Mirrors the matrix in .github/workflows/release.yml.
 */
export function assetName(platform: NodeJS.Platform, arch: string): string {
  const p = platform as Platform;
  const a = arch as Arch;
  if (p === "darwin" && a === "arm64") return "cookiedclaw-gateway-darwin-arm64";
  if (p === "linux" && a === "arm64") return "cookiedclaw-gateway-linux-arm64";
  if (p === "linux" && a === "x64") return "cookiedclaw-gateway-linux-x64";
  throw new Error(
    `unsupported platform: ${platform}-${arch}. Supported: darwin-arm64, linux-arm64, linux-x64.`,
  );
}

/**
 * Numeric semver compare. Returns negative if a<b, 0 if equal, positive
 * if a>b. We only ship X.Y.Z tags — no prereleases — so a 3-segment
 * numeric compare is sufficient. Pre-release suffixes get stripped.
 */
export function compareSemver(a: string, b: string): number {
  const parse = (s: string): number[] =>
    s.replace(/^v/, "").split("-")[0]!.split(".").map((n) => Number.parseInt(n, 10) || 0);
  const pa = parse(a);
  const pb = parse(b);
  for (let i = 0; i < 3; i++) {
    const x = pa[i] ?? 0;
    const y = pb[i] ?? 0;
    if (x !== y) return x - y;
  }
  return 0;
}

/**
 * Extract the hex hash from a `shasum -a 256 <file>` style file. The
 * format is `<64 hex>  <filename>\n`; we tolerate stray whitespace and
 * case but reject anything that doesn't lead with 64 hex chars.
 */
export function parseSha256(content: string): string {
  const m = content.trim().match(/^([0-9a-f]{64})/i);
  // Capture group 1 is guaranteed present when the match succeeds — the
  // regex literally requires it. `m[1]!` is the cleanest assertion in
  // strict mode (noUncheckedIndexedAccess widens RegExpMatchArray slots).
  if (!m) throw new Error(`malformed sha256 file: ${JSON.stringify(content.slice(0, 80))}`);
  return m[1]!.toLowerCase();
}

export type Release = {
  tag: string;
  assets: Map<string, string>;
};

export async function fetchLatestRelease(): Promise<Release> {
  const url = `https://api.github.com/repos/${REPO}/releases/latest`;
  const resp = await fetch(url, {
    headers: {
      Accept: "application/vnd.github+json",
      "User-Agent": `cookiedclaw-gateway/${VERSION}`,
    },
    signal: AbortSignal.timeout(10_000),
  });
  if (!resp.ok) {
    throw new Error(`GitHub API ${resp.status} ${resp.statusText} for ${url}`);
  }
  const data = (await resp.json()) as {
    tag_name: string;
    assets: Array<{ name: string; browser_download_url: string }>;
  };
  const assets = new Map<string, string>();
  for (const a of data.assets) assets.set(a.name, a.browser_download_url);
  return { tag: data.tag_name, assets };
}

async function fileSha256Hex(path: string): Promise<string> {
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(await Bun.file(path).bytes());
  return hasher.digest("hex");
}

/**
 * Download via `curl`, not bun's fetch. Bun-compiled binaries spin or
 * ECONNRESET when streaming a multi-tens-of-MB response to disk (the
 * gateway is ~64 MB compiled). curl is preinstalled on every platform
 * we ship to (macOS ships with it; the install.sh one-liner already
 * depends on it). 5xx and TLS errors surface as non-zero exit; we let
 * curl handle redirects and timeouts so we don't have to reinvent them.
 */
async function downloadTo(url: string, dest: string): Promise<void> {
  const proc = Bun.spawn([
    "curl",
    "-fsSL",
    "--retry", "3",
    "--retry-delay", "2",
    "--max-time", "300",
    "-A", `cookiedclaw-gateway/${VERSION}`,
    "-o", dest,
    url,
  ], { stderr: "pipe", stdout: "pipe" });
  const code = await proc.exited;
  if (code !== 0) {
    const errOut = await new Response(proc.stderr).text();
    throw new Error(`curl exit ${code}: ${errOut.trim() || url}`);
  }
}

function isSystemdActive(): boolean {
  // Pi/Linux only. On macOS systemctl doesn't exist — spawnSync returns
  // error=ENOENT, status=null, which we treat as "not active" (no
  // restart needed). Users running gateway on darwin manage the
  // process themselves.
  const r = spawnSync("systemctl", ["--user", "is-active", SERVICE_NAME], {
    encoding: "utf8",
  });
  return r.status === 0 && r.stdout.trim() === "active";
}

function systemdRestart(): { ok: boolean; output: string } {
  const r = spawnSync("systemctl", ["--user", "restart", SERVICE_NAME], {
    encoding: "utf8",
  });
  return {
    ok: r.status === 0,
    output: (r.stdout + r.stderr).trim() || `exit=${r.status}`,
  };
}

export type UpdateDeps = {
  /** Override platform — tests set this without spoofing process.platform. */
  platform?: NodeJS.Platform;
  /** Override arch. */
  arch?: string;
  /** Override target dir — tests use tmpdir. */
  binDir?: string;
  /** Skip systemd interaction (tests, and macOS dev runs). */
  skipSystemd?: boolean;
};

export async function runUpdate(deps: UpdateDeps = {}): Promise<number> {
  const platform = deps.platform ?? process.platform;
  const arch = deps.arch ?? process.arch;
  const binDir = deps.binDir ?? join(homedir(), ".cookiedclaw", "bin");

  const log = (msg: string) => process.stderr.write(`[update] ${msg}\n`);

  log(`current version: v${VERSION}`);
  const asset = assetName(platform, arch);
  log(`target: ${platform}-${arch} → ${asset}`);

  log("fetching latest release…");
  const { tag, assets } = await fetchLatestRelease();
  const latest = tag.replace(/^v/, "");
  log(`latest release: ${tag}`);

  // Skip if we're already at or ahead of the latest published tag.
  // The ahead case happens during the gap between a release-bump PR
  // landing on main and the corresponding tag being published — without
  // this guard, a dev build would downgrade itself.
  if (compareSemver(latest, VERSION) <= 0) {
    log(`already up to date (current v${VERSION} >= latest ${tag}).`);
    return 0;
  }

  const binUrl = assets.get(asset);
  const shaUrl = assets.get(`${asset}.sha256`);
  if (!binUrl || !shaUrl) {
    log(
      `release ${tag} is missing one of ${asset} / ${asset}.sha256. ` +
        `Available: ${Array.from(assets.keys()).join(", ")}`,
    );
    return 1;
  }

  await mkdir(binDir, { recursive: true });
  const dest = join(binDir, "cookiedclaw-gateway");
  const newPath = `${dest}.new`;
  const bakPath = `${dest}.bak`;
  const shaPath = `${dest}.sha256`;
  const shaNewPath = `${shaPath}.new`;
  const shaBakPath = `${shaPath}.bak`;

  log(`downloading ${asset}…`);
  await downloadTo(binUrl, newPath);
  await downloadTo(shaUrl, shaNewPath);

  const expected = parseSha256(await Bun.file(shaNewPath).text());
  const actual = await fileSha256Hex(newPath);
  if (expected !== actual) {
    await unlink(newPath).catch(() => {});
    await unlink(shaNewPath).catch(() => {});
    log(`sha256 mismatch: expected ${expected}, got ${actual}. Aborted.`);
    return 1;
  }
  log(`sha256 verified: ${actual.slice(0, 16)}…`);

  await chmod(newPath, 0o755);

  // Swap. rename() is atomic on the same filesystem; `.bak` lets the
  // user roll back manually with `mv cookiedclaw-gateway{.bak,}`.
  if (existsSync(dest)) await rename(dest, bakPath);
  if (existsSync(shaPath)) await rename(shaPath, shaBakPath);
  await rename(newPath, dest);
  await rename(shaNewPath, shaPath);
  log(`installed v${latest} → ${dest}`);

  if (deps.skipSystemd) {
    log("skipSystemd set — leaving service untouched.");
    return 0;
  }

  if (!isSystemdActive()) {
    log(`${SERVICE_NAME}.service not active — binary updated, no restart needed.`);
    return 0;
  }

  log(`${SERVICE_NAME}.service is active — restarting…`);
  const r = systemdRestart();
  if (!r.ok) {
    log(`warning: systemctl restart failed: ${r.output}`);
    log(`binary on disk is v${latest}; restart manually: systemctl --user restart ${SERVICE_NAME}`);
    return 1;
  }
  log("restart done.");
  return 0;
}
