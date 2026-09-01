import { describe, expect, test } from "bun:test";

import { type SessionFeedItem, sessionSnapshotSchema } from "../src/shared/sessionSnapshot";
import { digestToolInput } from "../src/shared/toolInputDigestHasher";
import { TOOL_RETRY_TURN_ANNOTATION_TYPE } from "../src/shared/toolRetry";
import {
  encodeToolRetrySnapshotMetadata,
  hydrateToolRetrySnapshotMetadata,
} from "../src/shared/toolRetrySnapshot";

const TS = "2026-07-10T00:00:00.000Z";
const METADATA_TYPE = "cowork.toolRetryMetadata";

function snapshotWithFeed(feed: SessionFeedItem[]) {
  return sessionSnapshotSchema.parse({
    sessionId: "session",
    title: "Retry metadata",
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
    createdAt: TS,
    updatedAt: TS,
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

function toolItem(id: string): Extract<SessionFeedItem, { kind: "tool" }> {
  return {
    id,
    kind: "tool",
    ts: TS,
    name: "bash",
    state: "output-error",
    args: { command: "bun test" },
  };
}

describe("tool retry snapshot metadata fail-closed", () => {
  test("skips corrupt annotation entries and still hydrates valid ones", () => {
    const digest = digestToolInput("bash", { command: "bun test" });
    if (!digest) throw new Error("expected digest");

    const snapshot = snapshotWithFeed([
      {
        id: "user",
        kind: "message",
        role: "user",
        ts: TS,
        text: "retry",
        annotations: [
          { type: "unrelated", keep: true },
          {
            type: METADATA_TYPE,
            version: 2,
            entries: [{ itemId: "ignored-by-version", retryOf: "x" }],
          },
          {
            type: "cowork.toolRetryMetadata.v0",
            version: 1,
            entries: [{ itemId: "ignored-by-type", retryOf: "x" }],
          },
          {
            type: METADATA_TYPE,
            version: 1,
            entries: [
              { itemId: "   ", retryOf: "failure" },
              { retryOf: "failure" },
              { itemId: "no-lineage" },
              {
                itemId: "bad-digest",
                inputDigest: { algorithm: "sha256", value: "not-hex", canonicalBytes: 1 },
              },
              {
                itemId: "failure",
                inputDigest: digest,
                retryOf: "  ",
              },
              {
                itemId: "replacement",
                retryOf: "failure",
                inputDigest: digest,
              },
            ],
          },
        ],
      },
      toolItem("failure"),
      toolItem("replacement"),
      toolItem("bad-digest"),
    ]);

    const hydrated = hydrateToolRetrySnapshotMetadata(snapshot);
    const user = hydrated.feed.find((item) => item.id === "user");
    expect(user?.kind === "message" ? user.annotations : undefined).toEqual([
      { type: "unrelated", keep: true },
      {
        type: METADATA_TYPE,
        version: 2,
        entries: [{ itemId: "ignored-by-version", retryOf: "x" }],
      },
      {
        type: "cowork.toolRetryMetadata.v0",
        version: 1,
        entries: [{ itemId: "ignored-by-type", retryOf: "x" }],
      },
    ]);
    expect(hydrated.feed.find((item) => item.id === "failure")).toMatchObject({
      inputDigest: digest,
    });
    expect(hydrated.feed.find((item) => item.id === "replacement")).toMatchObject({
      retryOf: "failure",
      inputDigest: digest,
    });
    expect(hydrated.feed.find((item) => item.id === "bad-digest")).toEqual(toolItem("bad-digest"));
    expect(hydrated.feed.some((item) => item.id === "ignored-by-version")).toBe(false);
  });

  test("strips retry-turn messages and drops empty annotation arrays", () => {
    const snapshot = snapshotWithFeed([
      {
        id: "retry-turn",
        kind: "message",
        role: "user",
        ts: TS,
        text: "retry tools",
        annotations: [
          { type: TOOL_RETRY_TURN_ANNOTATION_TYPE, version: 1, targetItemIds: ["failure"] },
        ],
      },
      {
        id: "user",
        kind: "message",
        role: "user",
        ts: TS,
        text: "hello",
        annotations: [{ type: METADATA_TYPE, version: 1, entries: "not-an-array" }],
      },
      toolItem("failure"),
    ]);

    const hydrated = hydrateToolRetrySnapshotMetadata(snapshot);
    expect(hydrated.feed.map((item) => item.id)).toEqual(["user", "failure"]);
    const user = hydrated.feed.find((item) => item.id === "user");
    expect(user?.kind === "message" ? user.annotations : "missing").toBeUndefined();
  });

  test("encode moves lineage onto the last message and strips it from tools", () => {
    const digest = digestToolInput("bash", { command: "bun test" });
    if (!digest) throw new Error("expected digest");
    const snapshot = snapshotWithFeed([
      {
        id: "user",
        kind: "message",
        role: "user",
        ts: TS,
        text: "hello",
        annotations: [{ type: "keep-me", ok: true }],
      },
      {
        ...toolItem("failure"),
        inputDigest: digest,
      },
      {
        ...toolItem("replacement"),
        retryOf: "failure",
        inputDigest: digest,
        state: "output-available",
      },
    ]);

    const encoded = encodeToolRetrySnapshotMetadata(snapshot);
    expect(encoded.feed.find((item) => item.id === "failure")).toEqual(toolItem("failure"));
    expect(encoded.feed.find((item) => item.id === "replacement")).toEqual({
      ...toolItem("replacement"),
      state: "output-available",
    });
    const user = encoded.feed.find((item) => item.id === "user");
    expect(user?.kind === "message" ? user.annotations : undefined).toEqual([
      { type: "keep-me", ok: true },
      {
        type: METADATA_TYPE,
        version: 1,
        entries: [
          { itemId: "failure", inputDigest: digest },
          { itemId: "replacement", inputDigest: digest, retryOf: "failure" },
        ],
      },
    ]);

    const roundTrip = hydrateToolRetrySnapshotMetadata(encoded);
    expect(roundTrip.feed.find((item) => item.id === "replacement")).toMatchObject({
      retryOf: "failure",
      inputDigest: digest,
    });
  });
});
