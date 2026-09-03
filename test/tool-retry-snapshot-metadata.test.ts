import { describe, expect, test } from "bun:test";

import { type SessionFeedItem, sessionSnapshotSchema } from "../src/shared/sessionSnapshot";
import { digestToolInput } from "../src/shared/toolInputDigestHasher";
import { toolRetryTurnAnnotation } from "../src/shared/toolRetry";
import {
  encodeToolRetrySnapshotMetadata,
  hydrateToolRetrySnapshotMetadata,
} from "../src/shared/toolRetrySnapshot";

const digest = digestToolInput("bash", { command: "bun test" });
if (!digest) throw new Error("expected input digest");

function snapshotWithFeed(feed: SessionFeedItem[]) {
  return sessionSnapshotSchema.parse({
    sessionId: "session",
    title: "Retry",
    titleSource: "default",
    titleModel: null,
    provider: "anthropic",
    model: "model",
    sessionKind: "root",
    parentSessionId: null,
    role: null,
    mode: null,
    depth: null,
    nickname: null,
    taskType: null,
    targetPaths: null,
    profile: null,
    requestedModel: null,
    effectiveModel: null,
    requestedReasoningEffort: null,
    effectiveReasoningEffort: null,
    executionState: null,
    lastMessagePreview: null,
    createdAt: "2026-07-10T00:00:00.000Z",
    updatedAt: "2026-07-10T00:00:00.000Z",
    messageCount: 0,
    lastEventSeq: 0,
    feed,
    agents: [],
    todos: [],
    sessionUsage: null,
    lastTurnUsage: null,
    hasPendingAsk: false,
    hasPendingApproval: false,
  });
}

const toolItem = (
  id: string,
  extras: Partial<Extract<SessionFeedItem, { kind: "tool" }>> = {},
): Extract<SessionFeedItem, { kind: "tool" }> => ({
  id,
  kind: "tool",
  ts: "2026-07-10T00:00:00.000Z",
  name: "bash",
  state: "output-error",
  args: { command: "bun test" },
  result: { error: "failed" },
  ...extras,
});

describe("tool-retry snapshot metadata fail-closed", () => {
  test("skips blank item ids, missing lineage, and malformed digests", () => {
    const snapshot = snapshotWithFeed([
      {
        id: "user",
        kind: "message",
        role: "user",
        ts: "2026-07-10T00:00:00.000Z",
        text: "Run tests",
        annotations: [
          {
            type: "cowork.toolRetryMetadata",
            version: 1,
            entries: [
              { itemId: "   ", inputDigest: digest },
              { itemId: "no-lineage" },
              {
                itemId: "bad-digest",
                inputDigest: { ...digest, value: "A".repeat(64) },
              },
              { itemId: "blank-retry", retryOf: "  " },
              { itemId: "good", retryOf: "failure", inputDigest: digest },
            ],
          },
        ],
      },
      toolItem("good"),
      toolItem("no-lineage"),
      toolItem("bad-digest"),
      toolItem("blank-retry"),
    ]);

    const hydrated = hydrateToolRetrySnapshotMetadata(snapshot);
    expect(hydrated.feed.find((item) => item.id === "good")).toMatchObject({
      retryOf: "failure",
      inputDigest: digest,
    });
    expect(hydrated.feed.find((item) => item.id === "no-lineage")).not.toHaveProperty("retryOf");
    expect(hydrated.feed.find((item) => item.id === "no-lineage")).not.toHaveProperty(
      "inputDigest",
    );
    expect(hydrated.feed.find((item) => item.id === "bad-digest")).not.toHaveProperty(
      "inputDigest",
    );
    expect(hydrated.feed.find((item) => item.id === "blank-retry")).not.toHaveProperty("retryOf");
  });

  test("leaves unknown annotation types and versions inert", () => {
    const snapshot = snapshotWithFeed([
      {
        id: "user",
        kind: "message",
        role: "user",
        ts: "2026-07-10T00:00:00.000Z",
        text: "Run tests",
        annotations: [
          {
            type: "cowork.toolRetryMetadata",
            version: 2,
            entries: [{ itemId: "failure", inputDigest: digest }],
          },
          {
            type: "cowork.unrelated",
            version: 1,
            entries: [{ itemId: "failure", retryOf: "older" }],
          },
        ],
      },
      toolItem("failure"),
    ]);

    const hydrated = hydrateToolRetrySnapshotMetadata(snapshot);
    const user = hydrated.feed.find((item) => item.id === "user");
    expect(user && user.kind === "message" ? user.annotations : undefined).toEqual([
      {
        type: "cowork.toolRetryMetadata",
        version: 2,
        entries: [{ itemId: "failure", inputDigest: digest }],
      },
      {
        type: "cowork.unrelated",
        version: 1,
        entries: [{ itemId: "failure", retryOf: "older" }],
      },
    ]);
    expect(hydrated.feed.find((item) => item.id === "failure")).not.toHaveProperty("inputDigest");
    expect(hydrated.feed.find((item) => item.id === "failure")).not.toHaveProperty("retryOf");
  });

  test("strips v1 metadata, drops retry-turn messages, and restores lineage on round-trip", () => {
    const snapshot = snapshotWithFeed([
      {
        id: "user",
        kind: "message",
        role: "user",
        ts: "2026-07-10T00:00:00.000Z",
        text: "Run tests",
      },
      toolItem("failure", { inputDigest: digest }),
      {
        id: "retry-turn",
        kind: "message",
        role: "user",
        ts: "2026-07-10T00:00:00.500Z",
        text: "Retry the failed step.",
        annotations: [
          toolRetryTurnAnnotation({
            targets: [{ itemId: "failure", inputDigest: digest }],
          }),
        ],
      },
      toolItem("replacement", {
        state: "output-available",
        result: { ok: true },
        retryOf: "failure",
        inputDigest: digest,
      }),
    ]);

    const encoded = encodeToolRetrySnapshotMetadata(snapshot);
    expect(encoded.feed.map((item) => item.id)).toEqual(["user", "failure", "replacement"]);
    const encodedTools = encoded.feed.filter((item) => item.kind === "tool");
    expect(encodedTools.every((item) => !("retryOf" in item) && !("inputDigest" in item))).toBe(
      true,
    );
    const lastMessage = [...encoded.feed].reverse().find((item) => item.kind === "message");
    expect(
      lastMessage && lastMessage.kind === "message" ? lastMessage.annotations : undefined,
    ).toEqual([
      {
        type: "cowork.toolRetryMetadata",
        version: 1,
        entries: [
          { itemId: "failure", inputDigest: digest },
          { itemId: "replacement", inputDigest: digest, retryOf: "failure" },
        ],
      },
    ]);

    const hydrated = hydrateToolRetrySnapshotMetadata(encoded);
    expect(hydrated.feed.find((item) => item.id === "user")).toMatchObject({
      id: "user",
    });
    expect(
      hydrated.feed.find((item) => item.id === "user" && item.kind === "message")?.annotations,
    ).toBeUndefined();
    expect(hydrated.feed.find((item) => item.id === "failure")).toMatchObject({
      inputDigest: digest,
    });
    expect(hydrated.feed.find((item) => item.id === "replacement")).toMatchObject({
      retryOf: "failure",
      inputDigest: digest,
    });
  });
});
