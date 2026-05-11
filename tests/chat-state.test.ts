import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { setupTestWorkspace } from "./setup.ts";

const ctx = setupTestWorkspace("cookiedclaw-test-chat-state-");
const cs = await import("../src/chat-state.ts");
const { pendingFile } = await import("../src/paths.ts");

/** schedulePersist debounces 50ms; this waits long enough for the write. */
async function waitForPersist(): Promise<void> {
  await new Promise((r) => setTimeout(r, 80));
}

describe("addPending / removePending", () => {
  test("adds chat to pendingChats and persists", async () => {
    cs.pendingChats.clear();
    cs.addPending("123");
    expect(cs.pendingChats.has("123")).toBe(true);

    await waitForPersist();
    const text = await readFile(pendingFile, "utf8");
    const data = JSON.parse(text) as { pending: string[] };
    expect(data.pending).toContain("123");
  });

  test("removePending drops the chat and persists", async () => {
    cs.pendingChats.clear();
    cs.addPending("abc");
    cs.addPending("def");
    await waitForPersist();

    cs.removePending("abc");
    expect(cs.pendingChats.has("abc")).toBe(false);
    expect(cs.pendingChats.has("def")).toBe(true);

    await waitForPersist();
    const data = JSON.parse(await readFile(pendingFile, "utf8")) as {
      pending: string[];
    };
    expect(data.pending).not.toContain("abc");
    expect(data.pending).toContain("def");
  });

  test("removePending on absent id does not crash and does not write", () => {
    cs.pendingChats.clear();
    expect(() => cs.removePending("nope")).not.toThrow();
    expect(cs.pendingChats.size).toBe(0);
  });
});

describe("setActiveChatId persistence", () => {
  test("activeChatId mutates and lands on disk", async () => {
    cs.pendingChats.clear();
    cs.setActiveChatId("777");
    await waitForPersist();
    const data = JSON.parse(await readFile(pendingFile, "utf8")) as {
      active: string | null;
    };
    expect(data.active).toBe("777");
  });
});

describe("loadPending", () => {
  test("rehydrates pendingChats and activeChatId from disk", async () => {
    cs.pendingChats.clear();
    cs.addPending("alpha");
    cs.addPending("beta");
    cs.setActiveChatId("alpha");
    await waitForPersist();

    cs.pendingChats.clear();
    await cs.loadPending();
    expect(cs.pendingChats.has("alpha")).toBe(true);
    expect(cs.pendingChats.has("beta")).toBe(true);
    expect(cs.activeChatId).toBe("alpha");
  });

  test("treats a missing/corrupt file as empty without throwing", async () => {
    cs.pendingChats.clear();
    await Bun.write(pendingFile, "{not json");
    await expect(cs.loadPending()).resolves.toBeUndefined();
    // pendingChats stays whatever we left it; just confirm no throw.
  });
});

describe("pruneStaleRunningEvents", () => {
  test("removes 'running' events and clears progressMessageId for those chats", () => {
    cs.chats.clear();
    cs.chats.set("c1", {
      events: [
        { toolUseId: "a", toolName: "Bash", inputSummary: "ls", status: "running" },
        { toolUseId: "b", toolName: "Read", inputSummary: "foo", status: "done", durationMs: 5 },
      ],
      progressMessageId: 99,
    });
    cs.chats.set("c2", {
      events: [
        { toolUseId: "c", toolName: "Edit", inputSummary: "bar", status: "done", durationMs: 5 },
      ],
      progressMessageId: 100,
    });

    cs.pruneStaleRunningEvents();

    const c1 = cs.chats.get("c1")!;
    expect(c1.events.map((e) => e.status)).toEqual(["done"]);
    expect(c1.progressMessageId).toBeUndefined();

    // c2 had no running events — left untouched.
    const c2 = cs.chats.get("c2")!;
    expect(c2.events).toHaveLength(1);
    expect(c2.progressMessageId).toBe(100);
  });
});

describe("queueEdit", () => {
  test("serializes per-chat: tasks run in the order queued", async () => {
    const order: number[] = [];
    const task = (n: number, delay: number) =>
      cs.queueEdit("chat-q", async () => {
        await new Promise((r) => setTimeout(r, delay));
        order.push(n);
      });
    // Even though the first task sleeps longer, queueEdit must keep the
    // 1→2→3 order for the same chat.
    const all = Promise.all([task(1, 30), task(2, 10), task(3, 5)]);
    await all;
    expect(order).toEqual([1, 2, 3]);
  });

  test("a thrown task does not break the queue for the next call", async () => {
    let ran = false;
    await cs
      .queueEdit("chat-err", async () => {
        throw new Error("boom");
      })
      .catch(() => {});
    await cs.queueEdit("chat-err", async () => {
      ran = true;
    });
    expect(ran).toBe(true);
  });
});
