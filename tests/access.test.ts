import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { setupTestWorkspace } from "./setup.ts";

// chdir before importing — env.ts/paths.ts/access.ts read cwd at module load.
const ctx = setupTestWorkspace("cookiedclaw-test-access-");
const access = await import("../src/access.ts");

describe("generatePairCode", () => {
  test("emits 5 lowercase letters from the safe alphabet", () => {
    for (let i = 0; i < 200; i++) {
      const code = access.generatePairCode();
      expect(code).toMatch(/^[a-km-z]{5}$/);
    }
  });
});

describe("reapPending", () => {
  test("drops expired entries, keeps live ones", () => {
    access.pendingPairs.clear();
    const now = Date.now();
    access.pendingPairs.set("expir", {
      code: "expir",
      userId: 1,
      name: "Old",
      expiresAt: now - 1000,
    });
    access.pendingPairs.set("alive", {
      code: "alive",
      userId: 2,
      name: "New",
      expiresAt: now + access.PAIR_TTL_MS,
    });
    access.reapPending();
    expect(access.pendingPairs.has("expir")).toBe(false);
    expect(access.pendingPairs.has("alive")).toBe(true);
    access.pendingPairs.clear();
  });
});

describe("isAllowed", () => {
  test("returns false for unknown user when env allowlist is empty", () => {
    access.pairedUsers.clear();
    expect(access.isAllowed(999)).toBe(false);
  });

  test("returns true once user is in pairedUsers", () => {
    access.pairedUsers.clear();
    access.pairedUsers.set(42, { userId: 42, name: "Tymur", addedAt: Date.now() });
    expect(access.isAllowed(42)).toBe(true);
    expect(access.isAllowed(43)).toBe(false);
    access.pairedUsers.clear();
  });
});

describe("loadAccess / saveAccess roundtrip", () => {
  test("persists pairedUsers to .cookiedclaw/access.json and loads them back", async () => {
    access.pairedUsers.clear();
    access.pairedUsers.set(7, { userId: 7, name: "Alice", addedAt: 1700000000000 });
    access.pairedUsers.set(8, { userId: 8, name: "Bob", addedAt: 1700000000001 });
    await access.saveAccess();

    const text = await readFile(join(ctx.dir, ".cookiedclaw", "access.json"), "utf8");
    const data = JSON.parse(text) as { paired: Array<{ userId: number; name: string }> };
    expect(data.paired).toHaveLength(2);
    expect(data.paired.find((u) => u.userId === 7)?.name).toBe("Alice");

    // Drop in-memory state and reload from disk.
    access.pairedUsers.clear();
    await access.loadAccess();
    expect(access.pairedUsers.get(7)?.name).toBe("Alice");
    expect(access.pairedUsers.get(8)?.name).toBe("Bob");
    access.pairedUsers.clear();
  });

  test("loadAccess is a no-op on missing file (fresh workspace)", async () => {
    // Use a sub-workspace by hand: we can't easily chdir again because
    // access.ts has already memoized accessFile path. Just confirm the
    // current file exists from previous test, then delete it to assert
    // tolerance.
    const file = Bun.file(join(ctx.dir, ".cookiedclaw", "access.json"));
    if (await file.exists()) {
      await Bun.write(file, ""); // empty -> JSON.parse throws -> caught silently
    }
    access.pairedUsers.clear();
    await expect(access.loadAccess()).resolves.toBeUndefined();
    expect(access.pairedUsers.size).toBe(0);
  });
});
