import { describe, expect, test } from "bun:test";

import {
  extractTextFromContent,
  makeExternalItemId,
  normalizeExternalConversation,
  normalizeIsoTimestamp,
  normalizeText,
  safePathBasename,
  shortHash,
  truncateText,
} from "../src/import/conversations/normalize";
import type {
  ExternalConversation,
  ExternalConversationItem,
} from "../src/import/conversations/types";

const FALLBACK_TS = "1970-01-01T00:00:00.000Z";

function conversation(
  overrides: Partial<Omit<ExternalConversation, "fingerprint">> & {
    items?: ExternalConversationItem[];
    fingerprint?: string | null;
  } = {},
) {
  return normalizeExternalConversation({
    source: "claude-code",
    sourceId: "session-1",
    sourcePath: "/tmp/session.jsonl",
    cwd: "/workspace",
    title: "Imported fixture",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:01:00.000Z",
    originalProvider: "anthropic",
    originalModel: "claude-opus-4-7",
    summary: null,
    warnings: [],
    items: [
      {
        kind: "user",
        id: "u1",
        ts: "2026-01-01T00:00:00.000Z",
        text: "Please inspect the project.",
      },
    ],
    ...overrides,
  });
}

describe("import conversation normalizers", () => {
  test("normalizeIsoTimestamp accepts ISO strings and seconds-vs-millis numbers", () => {
    expect(normalizeIsoTimestamp("2026-01-01T00:00:00.000Z")).toBe("2026-01-01T00:00:00.000Z");
    expect(normalizeIsoTimestamp(1_700_000_000)).toBe(new Date(1_700_000_000_000).toISOString());
    expect(normalizeIsoTimestamp(1_700_000_000_001)).toBe(
      new Date(1_700_000_000_001).toISOString(),
    );
    expect(normalizeIsoTimestamp("not-a-date", FALLBACK_TS)).toBe(FALLBACK_TS);
    expect(normalizeIsoTimestamp("   ", FALLBACK_TS)).toBe(FALLBACK_TS);
    expect(normalizeIsoTimestamp(Number.NaN, FALLBACK_TS)).toBe(FALLBACK_TS);
    expect(normalizeIsoTimestamp(undefined, FALLBACK_TS)).toBe(FALLBACK_TS);
  });

  test("normalizeText collapses CRLF and trailing spaces before wrapping", () => {
    expect(normalizeText("  hello  \r\n  world  \t\n")).toBe("hello\n  world");
    expect(normalizeText(12)).toBe("");
  });

  test("truncateText records a warning and keeps a visible suffix", () => {
    const warnings: Array<{ code: string; message: string }> = [];
    expect(truncateText("short", 80_000, warnings)).toBe("short");
    expect(truncateText("x".repeat(12), 8, warnings)).toBe(`${"x".repeat(8)}\n\n[truncated]`);
    expect(warnings).toEqual([
      { code: "truncated", message: "Imported text was truncated to 8 characters." },
    ]);
  });

  test("extractTextFromContent reads string, array, and object payloads", () => {
    expect(extractTextFromContent("  hello  ")).toBe("hello");
    expect(
      extractTextFromContent([
        "one",
        { text: "two" },
        { input_text: "three" },
        { inputText: "four" },
        { content: "five" },
        12,
        null,
      ]),
    ).toBe("one\ntwo\nthree\nfour\nfive");
    expect(extractTextFromContent({ text: " object " })).toBe("object");
    expect(extractTextFromContent({ content: " nested " })).toBe("nested");
    expect(extractTextFromContent({ other: true })).toBe("");
  });

  test("safePathBasename and item ids stay deterministic", () => {
    expect(safePathBasename(null)).toBe("Imported chat");
    expect(safePathBasename("/tmp/session.jsonl")).toBe("session.jsonl");
    expect(
      makeExternalItemId({
        source: "codex",
        sourceId: "s1",
        index: 0,
        kind: "user",
        seed: { text: "hi" },
      }),
    ).toBe(
      `import-codex-${shortHash({
        sourceId: "s1",
        index: 0,
        kind: "user",
        seed: { text: "hi" },
      })}`,
    );
  });

  test("drops empty chat items, keeps empty tool errors, and sorts by timestamp", () => {
    const normalized = conversation({
      title: "   ",
      items: [
        { kind: "assistant", id: "a1", ts: "2026-01-01T00:02:00.000Z", text: "  later  " },
        { kind: "user", id: "empty", ts: "2026-01-01T00:00:00.000Z", text: "   " },
        { kind: "tool", id: "t1", ts: "2026-01-01T00:01:00.000Z", name: "  ", error: "  boom  " },
        { kind: "user", id: "u1", ts: "2026-01-01T00:00:30.000Z", text: "first visible" },
      ],
    });

    expect(normalized.items.map((item) => item.id)).toEqual(["u1", "t1", "a1"]);
    expect(normalized.items[1]).toMatchObject({ kind: "tool", name: "tool", error: "boom" });
    expect(normalized.title).toBe("first visible");
    expect(normalized.createdAt).toBe("2026-01-01T00:00:00.000Z");
    expect(normalized.updatedAt).toBe("2026-01-01T00:01:00.000Z");
  });

  test("emits truncation warnings and keeps fingerprints stable for the same payload", () => {
    const long = "z".repeat(80_001);
    const first = conversation({
      title: "A".repeat(200),
      summary: long,
      items: [{ kind: "user", id: "u1", ts: "2026-01-01T00:00:00.000Z", text: long }],
    });
    const second = conversation({
      title: "A".repeat(200),
      summary: long,
      items: [{ kind: "user", id: "u1", ts: "2026-01-01T00:00:00.000Z", text: long }],
    });

    expect(first.title.endsWith("...")).toBe(true);
    expect(first.title.startsWith("A".repeat(179))).toBe(true);
    expect(first.summary?.endsWith("[truncated]")).toBe(true);
    expect(first.items[0]?.kind === "user" && first.items[0].text.endsWith("[truncated]")).toBe(
      true,
    );
    expect(first.warnings.filter((warning) => warning.code === "truncated")).toHaveLength(2);
    expect(first.fingerprint).toBe(second.fingerprint);
    expect(first.fingerprint).not.toBe("fixture-fingerprint");
  });
});
