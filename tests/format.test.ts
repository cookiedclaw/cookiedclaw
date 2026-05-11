import { describe, expect, test } from "bun:test";
import { setupTestWorkspace } from "./setup.ts";

// format.ts pulls in bot.ts via the sendFormatted side; chdir-before-import
// keeps paths.ts's mkdir from polluting the worktree.
setupTestWorkspace("cookiedclaw-test-format-");
const { toTelegramMd, chunkForTelegram, senderDisplayName } = await import(
  "../src/format.ts"
);

describe("toTelegramMd", () => {
  test("escapes MarkdownV2 specials in plain text", () => {
    const out = toTelegramMd("hello (world). 1+2!");
    // `(` `)` `.` `!` `+` all require backslashes in MarkdownV2.
    expect(out).toContain("\\(");
    expect(out).toContain("\\)");
    expect(out).toContain("\\.");
    expect(out).toContain("\\!");
  });

  test("preserves bold / italic / inline code as MarkdownV2 markers", () => {
    const out = toTelegramMd("**bold** *italic* `code`");
    // bold => *...*, italic => _..._, inline code stays in backticks.
    expect(out).toContain("*bold*");
    expect(out).toContain("_italic_");
    expect(out).toContain("`code`");
  });

  test("never throws — falls back to raw text on conversion error", () => {
    // No public way to force telegramify-markdown to throw here, so just
    // assert the function is total over a few odd shapes.
    expect(() => toTelegramMd("")).not.toThrow();
    expect(() => toTelegramMd("\0\u{1F600}\\")).not.toThrow();
  });
});

describe("chunkForTelegram", () => {
  test("returns a single chunk for short input", () => {
    const out = chunkForTelegram("short");
    expect(out).toEqual(["short"]);
  });

  test("each chunk fits under 3800 chars", () => {
    const big = "x".repeat(10_000);
    const chunks = chunkForTelegram(big);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(3800);
    expect(chunks.join("")).toBe(big);
  });

  test("prefers paragraph breaks when available", () => {
    // 2000 chars + \n\n + 2000 chars = 4002, just over the threshold.
    // The first chunk should end exactly at the paragraph break.
    const left = "a".repeat(2000);
    const right = "b".repeat(2000);
    const input = `${left}\n\n${right}`;
    const chunks = chunkForTelegram(input);
    expect(chunks.length).toBe(2);
    expect(chunks[0]!.endsWith("\n\n")).toBe(true);
    expect(chunks[1]!.startsWith("b")).toBe(true);
  });

  test("falls through to hard cut when no whitespace inside window", () => {
    const input = "z".repeat(5000);
    const chunks = chunkForTelegram(input);
    expect(chunks[0]!.length).toBe(3800);
    expect(chunks.join("")).toBe(input);
  });
});

describe("senderDisplayName", () => {
  test("name + username when both present", () => {
    expect(
      senderDisplayName({
        id: 1,
        first_name: "Tymur",
        last_name: "T.",
        username: "wowtist247",
      }),
    ).toBe("Tymur T. (@wowtist247)");
  });

  test("name only when username missing", () => {
    expect(senderDisplayName({ id: 1, first_name: "Tymur" })).toBe("Tymur");
  });

  test("username only when no name parts", () => {
    expect(senderDisplayName({ id: 1, username: "lurker" })).toBe("@lurker");
  });

  test("falls back to numeric id when nothing else is available", () => {
    expect(senderDisplayName({ id: 42 })).toBe("42");
  });
});
