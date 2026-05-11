import { describe, expect, test } from "bun:test";
import { setupTestWorkspace } from "./setup.ts";

setupTestWorkspace("cookiedclaw-test-progress-");
const progress = await import("../src/progress.ts");
const { chats } = await import("../src/chat-state.ts");
type ChatState = import("../src/chat-state.ts").ChatState;

const {
  displayToolName,
  summarizeToolInput,
  isReplyTool,
  renderProgress,
  applyEvent,
} = progress;

describe("displayToolName", () => {
  test("strips mcp__<server>__ prefix", () => {
    expect(displayToolName("mcp__supermemory__super_search")).toBe("super_search");
    expect(displayToolName("mcp__telegram__reply")).toBe("reply");
  });

  test("strips mcp__plugin_<plugin>_<server>__ prefix", () => {
    expect(displayToolName("mcp__plugin_supermemory_supermemory__super_save")).toBe(
      "super_save",
    );
  });

  test("leaves non-MCP names alone", () => {
    expect(displayToolName("Bash")).toBe("Bash");
    expect(displayToolName("TodoWrite")).toBe("TodoWrite");
  });
});

describe("summarizeToolInput", () => {
  test("Bash → command, clamped", () => {
    expect(summarizeToolInput("Bash", { command: "ls -la" })).toBe("ls -la");
    const long = "x".repeat(200);
    const out = summarizeToolInput("Bash", { command: long });
    expect(out.length).toBeLessThanOrEqual(90);
    expect(out.endsWith("…")).toBe(true);
  });

  test("Read/Edit/Write/NotebookEdit → file_path", () => {
    expect(summarizeToolInput("Read", { file_path: "/x/y.ts" })).toBe("/x/y.ts");
    expect(summarizeToolInput("Edit", { file_path: "/x/y.ts" })).toBe("/x/y.ts");
    expect(summarizeToolInput("Write", { file_path: "/a" })).toBe("/a");
    expect(summarizeToolInput("NotebookEdit", { file_path: "/n" })).toBe("/n");
  });

  test("Glob/Grep → pattern; WebFetch/WebSearch → url/query", () => {
    expect(summarizeToolInput("Glob", { pattern: "**/*.ts" })).toBe("**/*.ts");
    expect(summarizeToolInput("Grep", { pattern: "foo" })).toBe("foo");
    expect(summarizeToolInput("WebFetch", { url: "https://x" })).toBe("https://x");
    expect(summarizeToolInput("WebSearch", { query: "claude" })).toBe("claude");
  });

  test("Agent → '<type>: <prompt>'", () => {
    const s = summarizeToolInput("Agent", {
      subagent_type: "explore",
      prompt: "find foo",
    });
    expect(s.startsWith("explore: ")).toBe(true);
    expect(s).toContain("find foo");
  });

  test("Skill → skill name", () => {
    expect(summarizeToolInput("Skill", { skill: "brainstorming" })).toBe(
      "brainstorming",
    );
  });

  test("TodoWrite → in-progress content if any, else 'N todos'", () => {
    expect(
      summarizeToolInput("TodoWrite", {
        todos: [
          { status: "completed", content: "done thing" },
          { status: "in_progress", content: "doing thing" },
          { status: "pending", content: "later" },
        ],
      }),
    ).toBe("doing thing");

    expect(
      summarizeToolInput("TodoWrite", {
        todos: [{ status: "pending", content: "later" }],
      }),
    ).toBe("1 todo");

    expect(
      summarizeToolInput("TodoWrite", {
        todos: [
          { status: "pending", content: "a" },
          { status: "pending", content: "b" },
        ],
      }),
    ).toBe("2 todos");
  });

  test("falls back to first short string field, then JSON", () => {
    expect(summarizeToolInput("Unknown", { name: "abc" })).toBe("name=abc");
    expect(summarizeToolInput("Unknown", {})).toBe("{}");
  });
});

describe("isReplyTool", () => {
  test("matches bare reply and mcp-prefixed variants", () => {
    expect(isReplyTool("reply")).toBe(true);
    expect(isReplyTool("mcp__telegram__reply")).toBe(true);
    expect(isReplyTool("mcp__plugin_cookiedclaw_telegram__reply")).toBe(true);
  });

  test("does not match unrelated tools", () => {
    expect(isReplyTool("react")).toBe(false);
    expect(isReplyTool("mcp__telegram__react")).toBe(false);
    expect(isReplyTool("Reply")).toBe(false); // case-sensitive
  });
});

describe("renderProgress", () => {
  test("empty events → 'Thinking…'", () => {
    expect(renderProgress([])).toBe("🤔 Thinking…");
  });

  test("renders running / done / error markers", () => {
    const lines = renderProgress([
      { toolUseId: "1", toolName: "Bash", inputSummary: "ls", status: "running" },
      {
        toolUseId: "2",
        toolName: "Read",
        inputSummary: "/x.ts",
        status: "done",
        durationMs: 12,
      },
      {
        toolUseId: "3",
        toolName: "Edit",
        inputSummary: "/y.ts",
        status: "error",
        durationMs: 8,
        errorText: "boom",
      },
    ]).split("\n");
    expect(lines).toHaveLength(3);
    expect(lines[0]).toMatch(/^⏳/);
    expect(lines[1]).toMatch(/^✓/);
    expect(lines[2]).toMatch(/^✗/);
    expect(lines[1]).toContain("(12ms)");
    expect(lines[2]).toContain("— boom");
  });

  test("clips long event lists with '(+N earlier hidden)'", () => {
    const many = Array.from({ length: 200 }, (_, i) => ({
      toolUseId: String(i),
      toolName: "Bash",
      inputSummary: "x".repeat(120), // each line ~125 chars; 200 lines = ~25k > 3800
      status: "done" as const,
      durationMs: 10,
    }));
    const out = renderProgress(many);
    expect(out.length).toBeLessThanOrEqual(3800);
    expect(out).toMatch(/\(\+\d+ earlier hidden\)/);
    const lines = out.split("\n");
    // First 3 lines are the head, the next line is the marker.
    expect(lines[3]).toMatch(/^\(\+\d+ earlier hidden\)$/);
  });
});

describe("applyEvent", () => {
  test("pre appends a running event", () => {
    const state: ChatState = { events: [] };
    applyEvent(state, {
      phase: "pre",
      tool_name: "Bash",
      tool_use_id: "u1",
      tool_input: { command: "ls" },
    });
    expect(state.events).toHaveLength(1);
    expect(state.events[0]!.status).toBe("running");
    expect(state.events[0]!.inputSummary).toBe("ls");
  });

  test("post updates the matching pre", () => {
    const state: ChatState = {
      events: [
        {
          toolUseId: "u1",
          toolName: "Bash",
          inputSummary: "ls",
          status: "running",
        },
      ],
    };
    applyEvent(state, {
      phase: "post",
      tool_name: "Bash",
      tool_use_id: "u1",
      duration_ms: 42,
    });
    expect(state.events[0]!.status).toBe("done");
    expect(state.events[0]!.durationMs).toBe(42);
  });

  test("post with is_error marks the event as error and captures error_text", () => {
    const state: ChatState = {
      events: [
        {
          toolUseId: "u2",
          toolName: "Edit",
          inputSummary: "/x",
          status: "running",
        },
      ],
    };
    applyEvent(state, {
      phase: "post",
      tool_name: "Edit",
      tool_use_id: "u2",
      duration_ms: 9,
      is_error: true,
      error_text: "permission denied",
    });
    expect(state.events[0]!.status).toBe("error");
    expect(state.events[0]!.errorText).toBe("permission denied");
  });

  test("orphan post (no matching pre) is appended as a standalone done/error", () => {
    const state: ChatState = { events: [] };
    applyEvent(state, {
      phase: "post",
      tool_name: "Bash",
      tool_use_id: "orphan",
      tool_input: { command: "pwd" },
      duration_ms: 3,
    });
    expect(state.events).toHaveLength(1);
    expect(state.events[0]!.status).toBe("done");
    expect(state.events[0]!.inputSummary).toBe("pwd");
  });
});

describe("handleProgress (state-machine integration)", () => {
  test("with no pending chats, does not touch state", async () => {
    chats.clear();
    await progress.handleProgress({
      phase: "pre",
      tool_name: "Bash",
      tool_use_id: "x",
      tool_input: { command: "ls" },
    });
    expect(chats.size).toBe(0);
  });

  test("a pre/post pair against a pending chat populates events", async () => {
    chats.clear();
    const { pendingChats } = await import("../src/chat-state.ts");
    pendingChats.clear();
    pendingChats.add("c1");

    await progress.handleProgress({
      phase: "pre",
      tool_name: "Bash",
      tool_use_id: "t1",
      tool_input: { command: "ls" },
    });
    await progress.handleProgress({
      phase: "post",
      tool_name: "Bash",
      tool_use_id: "t1",
      duration_ms: 11,
    });

    const state = chats.get("c1")!;
    expect(state.events).toHaveLength(1);
    expect(state.events[0]!.status).toBe("done");
    expect(state.events[0]!.durationMs).toBe(11);

    pendingChats.clear();
    chats.clear();
  });

  test("reply.pre on a chat with prior events resets events + progressMessageId (split-bubble)", async () => {
    chats.clear();
    const { pendingChats } = await import("../src/chat-state.ts");
    pendingChats.clear();
    pendingChats.add("c2");
    chats.set("c2", {
      events: [
        { toolUseId: "old", toolName: "Bash", inputSummary: "ls", status: "done", durationMs: 5 },
      ],
      progressMessageId: 555,
    });

    await progress.handleProgress({
      phase: "pre",
      tool_name: "mcp__telegram__reply",
      tool_use_id: "r1",
      tool_input: { chat_id: "c2", text: "ok" },
    });

    const state = chats.get("c2")!;
    expect(state.events).toEqual([]);
    expect(state.progressMessageId).toBeUndefined();

    pendingChats.clear();
    chats.clear();
  });
});
