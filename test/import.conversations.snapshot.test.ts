import { describe, expect, test } from "bun:test";

import {
  conversationToSessionFeed,
  countVisibleMessages,
  previewText,
} from "../src/import/conversations/snapshot";
import type { ExternalConversation } from "../src/import/conversations/types";

const IMPORTED_AT = "2026-02-02T03:04:05.000Z";

function conversation(overrides: Partial<ExternalConversation> = {}): ExternalConversation {
  return {
    source: "codex",
    sourceId: "session-1",
    sourcePath: "/tmp/session.jsonl",
    fingerprint: "fp-1",
    cwd: "/workspace",
    title: "Imported fixture",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:02:00.000Z",
    originalProvider: "openai",
    originalModel: "gpt-5.4",
    summary: null,
    warnings: [],
    items: [
      { kind: "user", id: "u1", ts: "2026-01-01T00:00:00.000Z", text: "Inspect the project." },
      {
        kind: "tool",
        id: "t-ok",
        ts: "2026-01-01T00:00:30.000Z",
        name: "Read",
        args: { path: "package.json" },
        result: "ok",
      },
      {
        kind: "tool",
        id: "t-err",
        ts: "2026-01-01T00:00:45.000Z",
        name: "Edit",
        error: "permission denied",
      },
      {
        kind: "reasoning",
        id: "r1",
        ts: "2026-01-01T00:01:00.000Z",
        mode: "summary",
        text: "checked files",
      },
      { kind: "system", id: "s1", ts: "2026-01-01T00:01:10.000Z", text: "note" },
      { kind: "assistant", id: "a1", ts: "2026-01-01T00:02:00.000Z", text: "Uses Bun." },
    ],
    ...overrides,
  };
}

describe("imported conversation snapshots", () => {
  test("maps items into a sanitized feed with a stable banner", () => {
    const feed = conversationToSessionFeed(conversation(), { importedAt: IMPORTED_AT });

    expect(feed[0]).toMatchObject({
      kind: "system",
      ts: IMPORTED_AT,
    });
    expect(feed[0]?.kind === "system" ? feed[0].line : "").toContain("Imported from codex");
    expect(feed[0]?.kind === "system" ? feed[0].line : "").toContain("Original model: gpt-5.4");
    expect(feed[0]?.kind === "system" ? feed[0].line : "").toContain(
      "sanitized summarized context, not the original provider continuation state",
    );

    expect(feed.map((item) => item.kind)).toEqual([
      "system",
      "message",
      "tool",
      "tool",
      "reasoning",
      "system",
      "message",
    ]);
    expect(feed[2]).toMatchObject({
      kind: "tool",
      name: "Read",
      state: "output-available",
      args: { path: "package.json" },
      result: "ok",
    });
    expect(feed[3]).toMatchObject({
      kind: "tool",
      name: "Edit",
      state: "output-error",
      result: "permission denied",
    });
    expect(
      conversationToSessionFeed(conversation(), { importedAt: IMPORTED_AT }).map((item) => item.id),
    ).toEqual(feed.map((item) => item.id));
  });

  test("counts only user and assistant messages and previews the latest visible text", () => {
    const imported = conversation();
    expect(countVisibleMessages(imported)).toBe(2);
    expect(previewText(imported)).toBe("Uses Bun.");
    expect(
      previewText(
        conversation({
          items: [{ kind: "tool", id: "t1", ts: "2026-01-01T00:00:00.000Z", name: "Read" }],
        }),
      ),
    ).toBeNull();
  });
});
