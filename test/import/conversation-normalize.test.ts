import { describe, expect, test } from "bun:test";

import {
  extractTextFromContent,
  makeConversationFingerprint,
  makeExternalItemId,
  normalizeExternalConversation,
  normalizeIsoTimestamp,
  normalizeText,
  truncateText,
} from "../../src/import/conversations/normalize";
import type { ExternalConversationItem } from "../../src/import/conversations/types";

const EPOCH = new Date(0).toISOString();
const NEW_YEAR_2026 = "2026-01-01T00:00:00.000Z";
const NEW_YEAR_2026_MS = Date.parse(NEW_YEAR_2026);

describe("conversation import normalize helpers", () => {
  test("normalizeIsoTimestamp accepts ISO strings and unix seconds or millis", () => {
    expect(normalizeIsoTimestamp(NEW_YEAR_2026)).toBe(NEW_YEAR_2026);
    expect(normalizeIsoTimestamp(NEW_YEAR_2026_MS / 1000)).toBe(NEW_YEAR_2026);
    expect(normalizeIsoTimestamp(NEW_YEAR_2026_MS)).toBe(NEW_YEAR_2026);
    // Date parsing uses the raw string, so padded ISO is treated as invalid.
    expect(normalizeIsoTimestamp(` ${NEW_YEAR_2026} `)).toBe(EPOCH);
  });

  test("normalizeIsoTimestamp fails closed to the fallback", () => {
    expect(normalizeIsoTimestamp("not-a-date")).toBe(EPOCH);
    expect(normalizeIsoTimestamp("   ")).toBe(EPOCH);
    expect(normalizeIsoTimestamp(Number.NaN, "2024-01-01T00:00:00.000Z")).toBe(
      "2024-01-01T00:00:00.000Z",
    );
    expect(normalizeIsoTimestamp(Number.POSITIVE_INFINITY)).toBe(EPOCH);
    expect(normalizeIsoTimestamp(null)).toBe(EPOCH);
  });

  test("extractTextFromContent joins provider text aliases and ignores empty parts", () => {
    expect(extractTextFromContent("  hello \r\n world  ")).toBe("hello\n world");
    expect(
      extractTextFromContent([
        "alpha",
        { text: "bravo" },
        { input_text: "charlie" },
        { inputText: "delta" },
        { content: "echo" },
        { ignored: true },
        42,
      ]),
    ).toBe("alpha\nbravo\ncharlie\ndelta\necho");
    expect(extractTextFromContent({ text: "  from-object  " })).toBe("from-object");
    expect(extractTextFromContent({ content: "nested-string" })).toBe("nested-string");
    expect(extractTextFromContent({ content: { text: "not-unwrapped" } })).toBe("");
    expect(extractTextFromContent(null)).toBe("");
  });

  test("truncateText records a truncated warning and keeps a visible marker", () => {
    const warnings: Array<{ code: string; message: string }> = [];
    expect(truncateText("short", 16, warnings)).toBe("short");
    expect(warnings).toEqual([]);

    const truncated = truncateText("abcdefghij", 4, warnings);
    expect(truncated).toBe("abcd\n\n[truncated]");
    expect(warnings).toEqual([
      {
        code: "truncated",
        message: "Imported text was truncated to 4 characters.",
      },
    ]);
  });

  test("normalizeExternalConversation drops empty chat rows, keeps empty tools, and sorts by time", () => {
    const conversation = normalizeExternalConversation({
      source: "codex",
      sourceId: "src-1",
      sourcePath: "/tmp/export.jsonl",
      cwd: null,
      title: "",
      createdAt: "not-a-date",
      updatedAt: NEW_YEAR_2026_MS / 1000,
      originalProvider: "openai",
      originalModel: "gpt-5.4",
      summary: "  keep me  ",
      warnings: [],
      items: [
        {
          kind: "assistant",
          id: "",
          ts: "2026-01-01T00:00:02.000Z",
          text: " later answer ",
        },
        {
          kind: "user",
          id: "user-empty",
          ts: "2026-01-01T00:00:00.000Z",
          text: "   ",
        },
        {
          kind: "user",
          id: "user-1",
          ts: "2026-01-01T00:00:01.000Z",
          text: "first question",
        },
        {
          kind: "tool",
          id: "",
          ts: "2026-01-01T00:00:00.500Z",
          name: "  ",
        },
      ],
    });

    expect(conversation.items.map((item) => item.kind)).toEqual(["tool", "user", "assistant"]);
    expect(conversation.items[0]).toMatchObject({
      kind: "tool",
      name: "tool",
      ts: "2026-01-01T00:00:00.500Z",
    });
    expect(conversation.items[0]?.id.startsWith("import-codex-")).toBe(true);
    expect(conversation.title).toBe("first question");
    expect(conversation.createdAt).toBe("2026-01-01T00:00:00.500Z");
    expect(conversation.updatedAt).toBe(NEW_YEAR_2026);
    expect(conversation.summary).toBe("keep me");
    expect(conversation.fingerprint).toHaveLength(64);
  });

  test("conversation fingerprints stay stable after item reordering", () => {
    const earlier: ExternalConversationItem = {
      kind: "user",
      id: "u1",
      ts: "2026-01-01T00:00:00.000Z",
      text: "hello",
    };
    const later: ExternalConversationItem = {
      kind: "assistant",
      id: "a1",
      ts: "2026-01-01T00:00:01.000Z",
      text: "world",
    };
    const first = normalizeExternalConversation({
      source: "claude-code",
      sourceId: "conv-1",
      sourcePath: null,
      cwd: null,
      title: "Imported",
      createdAt: NEW_YEAR_2026,
      updatedAt: NEW_YEAR_2026,
      originalProvider: null,
      originalModel: null,
      summary: null,
      warnings: [],
      items: [later, earlier],
    });
    const second = normalizeExternalConversation({
      source: "claude-code",
      sourceId: "conv-1",
      sourcePath: null,
      cwd: null,
      title: "Imported",
      createdAt: NEW_YEAR_2026,
      updatedAt: NEW_YEAR_2026,
      originalProvider: null,
      originalModel: null,
      summary: null,
      warnings: [],
      items: [earlier, later],
    });

    expect(first.fingerprint).toBe(second.fingerprint);
    expect(first.fingerprint).toBe(
      makeConversationFingerprint({
        source: first.source,
        sourceId: first.sourceId,
        sourcePath: first.sourcePath,
        createdAt: first.createdAt,
        updatedAt: first.updatedAt,
        items: first.items,
      }),
    );
  });

  test("generated item ids stay stable for the same source seed", () => {
    expect(
      makeExternalItemId({
        source: "cowork",
        sourceId: "thread-1",
        index: 3,
        kind: "user",
        seed: { text: "same" },
      }),
    ).toBe(
      makeExternalItemId({
        source: "cowork",
        sourceId: "thread-1",
        index: 3,
        kind: "user",
        seed: { text: "same" },
      }),
    );
    expect(
      makeExternalItemId({
        source: "cowork",
        sourceId: "thread-1",
        index: 3,
        kind: "user",
        seed: { text: "same" },
      }),
    ).not.toBe(
      makeExternalItemId({
        source: "cowork",
        sourceId: "thread-1",
        index: 4,
        kind: "user",
        seed: { text: "same" },
      }),
    );
  });

  test("normalizeText strips trailing spaces before newlines", () => {
    expect(normalizeText("line  \nnext\t \n")).toBe("line\nnext");
  });
});
