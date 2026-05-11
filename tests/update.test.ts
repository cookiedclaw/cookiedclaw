import { describe, expect, test } from "bun:test";
import { setupTestWorkspace } from "./setup.ts";

// No cwd-dependent side effects in cli/update.ts, but staying consistent
// with the rest of the suite — we want a clean per-file workspace if any
// import below grows side effects later.
setupTestWorkspace("cookiedclaw-test-update-");
const { assetName, parseSha256, compareSemver } = await import("../src/cli/update.ts");

describe("assetName", () => {
  test("darwin-arm64 → cookiedclaw-gateway-darwin-arm64", () => {
    expect(assetName("darwin", "arm64")).toBe("cookiedclaw-gateway-darwin-arm64");
  });

  test("linux-arm64 → cookiedclaw-gateway-linux-arm64", () => {
    expect(assetName("linux", "arm64")).toBe("cookiedclaw-gateway-linux-arm64");
  });

  test("linux-x64 → cookiedclaw-gateway-linux-x64", () => {
    expect(assetName("linux", "x64")).toBe("cookiedclaw-gateway-linux-x64");
  });

  test("throws on unsupported combinations", () => {
    expect(() => assetName("darwin", "x64")).toThrow(/unsupported platform/);
    expect(() => assetName("win32", "x64")).toThrow(/unsupported platform/);
    expect(() => assetName("linux", "ia32")).toThrow(/unsupported platform/);
  });

  test("error message lists the supported set so users know what's available", () => {
    try {
      assetName("freebsd", "arm64");
      throw new Error("should have thrown");
    } catch (e) {
      const msg = (e as Error).message;
      expect(msg).toContain("darwin-arm64");
      expect(msg).toContain("linux-arm64");
      expect(msg).toContain("linux-x64");
    }
  });
});

describe("parseSha256", () => {
  test("standard `shasum -a 256 file` format", () => {
    const content =
      "3a7bd3e2360a3d29eea436fcfb7e44c735d117c42d1c1835420b6b9942dd4f1b  cookiedclaw-gateway-linux-arm64\n";
    expect(parseSha256(content)).toBe(
      "3a7bd3e2360a3d29eea436fcfb7e44c735d117c42d1c1835420b6b9942dd4f1b",
    );
  });

  test("trims surrounding whitespace", () => {
    const content =
      "\n  3A7BD3E2360A3D29EEA436FCFB7E44C735D117C42D1C1835420B6B9942DD4F1B  file\n\n";
    expect(parseSha256(content)).toBe(
      "3a7bd3e2360a3d29eea436fcfb7e44c735d117c42d1c1835420b6b9942dd4f1b",
    );
  });

  test("accepts hash-only files (no filename)", () => {
    // Some toolchains emit just the hex digest with no filename column.
    const content = "3a7bd3e2360a3d29eea436fcfb7e44c735d117c42d1c1835420b6b9942dd4f1b\n";
    expect(parseSha256(content)).toBe(
      "3a7bd3e2360a3d29eea436fcfb7e44c735d117c42d1c1835420b6b9942dd4f1b",
    );
  });

  test("rejects short hashes", () => {
    expect(() => parseSha256("deadbeef  file")).toThrow(/malformed sha256/);
  });

  test("rejects empty input", () => {
    expect(() => parseSha256("")).toThrow(/malformed sha256/);
  });

  test("rejects non-hex content", () => {
    expect(() => parseSha256("not-a-hash-zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz  file"))
      .toThrow(/malformed sha256/);
  });
});

describe("compareSemver", () => {
  test("equal versions return 0", () => {
    expect(compareSemver("0.3.0", "0.3.0")).toBe(0);
    expect(compareSemver("v0.3.0", "0.3.0")).toBe(0);
    expect(compareSemver("0.3.0", "v0.3.0")).toBe(0);
  });

  test("strictly newer is positive, older is negative", () => {
    expect(compareSemver("0.3.0", "0.2.4")).toBeGreaterThan(0);
    expect(compareSemver("0.2.4", "0.3.0")).toBeLessThan(0);
    expect(compareSemver("1.0.0", "0.99.99")).toBeGreaterThan(0);
    expect(compareSemver("0.3.1", "0.3.0")).toBeGreaterThan(0);
  });

  test("strips leading v on either side", () => {
    expect(compareSemver("v0.3.0", "v0.2.4")).toBeGreaterThan(0);
  });

  test("treats missing minor/patch as 0", () => {
    expect(compareSemver("1", "1.0.0")).toBe(0);
    expect(compareSemver("1.0", "1.0.0")).toBe(0);
  });

  test("ignores pre-release suffix", () => {
    expect(compareSemver("0.3.0-rc1", "0.3.0")).toBe(0);
  });

  test("downgrade guard: current 0.3.0 vs latest 0.2.4 → no update", () => {
    // Mirrors the runtime check: if compareSemver(latest, VERSION) <= 0,
    // we skip update. This prevents a dev build (newer than tag) from
    // downgrading itself.
    expect(compareSemver("0.2.4", "0.3.0")).toBeLessThan(0);
  });
});
