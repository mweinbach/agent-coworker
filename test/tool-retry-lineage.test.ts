import { describe, expect, test } from "bun:test";
import { z } from "zod";

import { SESSION_FEED_ITEM_LIMIT } from "../src/shared/feedRetention";
import { type SessionFeedItem, sessionSnapshotSchema } from "../src/shared/sessionSnapshot";
import { sameToolInputDigest } from "../src/shared/toolInputDigest";
import { digestToolInput } from "../src/shared/toolInputDigestHasher";
import {
  isFailedToolOutcome,
  recoveredToolItemIds,
  resolveToolRetryIntent,
  toolRetryTurnAnnotation,
} from "../src/shared/toolRetry";
import { createToolRetryAttemptTracker } from "../src/shared/toolRetryAttempts";
import {
  encodeToolRetrySnapshotMetadata,
  hydrateToolRetrySnapshotMetadata,
} from "../src/shared/toolRetrySnapshot";

const failedTool = (
  id: string,
  name = "bash",
  args: unknown = { command: "bun test" },
): Extract<SessionFeedItem, { kind: "tool" }> => ({
  id,
  kind: "tool",
  ts: "2026-07-10T00:00:00.000Z",
  name,
  state: "output-error",
  args,
  result: { error: "failed" },
  ...(digestToolInput(name, args) ? { inputDigest: digestToolInput(name, args) ?? undefined } : {}),
});

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

describe("explicit tool retry lineage", () => {
  test("classifies structured, denied, and legacy skill failures consistently", () => {
    expect(isFailedToolOutcome("bash", "output-available", { ok: false })).toBe(true);
    expect(isFailedToolOutcome("bash", "output-available", { error: "failed" })).toBe(true);
    expect(isFailedToolOutcome("bash", "output-available", { denied: true })).toBe(true);
    expect(isFailedToolOutcome("skill", "output-available", "Skill not found: missing")).toBe(true);
    expect(isFailedToolOutcome("skill", "output-available", "Loaded skill: documents")).toBe(false);
  });

  test("confirms only explicit targets with a complete exact digest without consuming at start", () => {
    const intent = resolveToolRetryIntent([failedTool("failure")], {
      toolItemIds: ["failure"],
    });
    const tracker = createToolRetryAttemptTracker(intent);

    expect(tracker.finalize("wrong-tool", "read", { command: "bun test" })).not.toHaveProperty(
      "retryOf",
    );
    expect(
      tracker.finalize("wrong-args", "bash", { command: "bun test --watch" }),
    ).not.toHaveProperty("retryOf");
    expect(tracker.finalize("first-match", "bash", { command: "bun test" })).toMatchObject({
      retryOf: "failure",
    });
    expect(tracker.finalize("second-match", "bash", { command: "bun test" })).toMatchObject({
      retryOf: "failure",
    });
  });

  test("hashes complete canonical input so large shared prefixes cannot falsely match", () => {
    const sharedPrefix = "x".repeat(64_000);
    const first = digestToolInput("write", { content: `${sharedPrefix}a`, path: "a.ts" });
    const second = digestToolInput("write", { content: `${sharedPrefix}b`, path: "a.ts" });
    const reordered = digestToolInput("write", { path: "a.ts", content: `${sharedPrefix}a` });

    expect(first).not.toBeNull();
    expect(first?.canonicalBytes).toBeGreaterThan(64_000);
    expect(first).toEqual(reordered);
    expect(first?.value).not.toBe(second?.value);
  });

  test("requires both digest bytes and canonical size when comparing collision metadata", () => {
    const digest = digestToolInput("write", { path: "a.ts", content: "complete" });
    if (!digest) throw new Error("expected input digest");

    expect(
      sameToolInputDigest(digest, {
        ...digest,
        canonicalBytes: digest.canonicalBytes + 1,
      }),
    ).toBe(false);
    expect(digestToolInput("read", { path: "a.ts" })).not.toEqual(
      digestToolInput("write", { path: "a.ts" }),
    );
  });

  test("keeps a target available after a failed attempt and consumes it only after success", () => {
    const intent = resolveToolRetryIntent([failedTool("failure")], {
      toolItemIds: ["failure"],
    });
    const tracker = createToolRetryAttemptTracker(intent);

    expect(tracker.finalize("attempt-1", "bash", { command: "bun test" })).toMatchObject({
      retryOf: "failure",
    });
    tracker.complete("attempt-1", false);
    expect(tracker.finalize("attempt-2", "bash", { command: "bun test" })).toMatchObject({
      retryOf: "failure",
    });
    tracker.complete("attempt-2", true);
    expect(tracker.finalize("attempt-3", "bash", { command: "bun test" })).not.toHaveProperty(
      "retryOf",
    );
  });

  test("assembles streaming arguments deterministically before exact matching", () => {
    const intent = resolveToolRetryIntent(
      [failedTool("failure", "write", { path: "a.ts", content: "complete" })],
      { toolItemIds: ["failure"] },
    );
    const tracker = createToolRetryAttemptTracker(intent);
    tracker.start("streamed", "write");
    tracker.appendInput("streamed", '{"path":"a.ts","content":"com');
    tracker.appendInput("streamed", 'plete"}');

    expect(tracker.finalizeBuffered("streamed", "write")).toMatchObject({
      retryOf: "failure",
      inputDigest: digestToolInput("write", { path: "a.ts", content: "complete" }),
    });
  });

  test("resolves transitive ancestors only through a successful descendant", () => {
    const original = failedTool("original");
    const failedChild = { ...failedTool("failed-child"), retryOf: "original" };
    const successfulGrandchild: Extract<SessionFeedItem, { kind: "tool" }> = {
      ...failedTool("successful-grandchild"),
      state: "output-available",
      result: { ok: true },
      retryOf: "failed-child",
    };
    const recovered = recoveredToolItemIds([original, failedChild, successfulGrandchild]);

    expect(recovered).toEqual(new Set(["failed-child", "original"]));
    expect(() =>
      resolveToolRetryIntent([original, failedChild, successfulGrandchild], {
        toolItemIds: ["original"],
      }),
    ).toThrow("already recovered");
    expect(
      resolveToolRetryIntent([original, failedChild], {
        toolItemIds: ["failed-child"],
      }).targets[0]?.itemId,
    ).toBe("failed-child");
  });

  test("a later successful sibling recovers prior failed attempts in the same explicit chain", () => {
    const original = failedTool("original");
    const failedAttempt = { ...failedTool("failed-attempt"), retryOf: "original" };
    const successfulAttempt: Extract<SessionFeedItem, { kind: "tool" }> = {
      ...failedTool("successful-attempt"),
      state: "output-available",
      result: { ok: true },
      retryOf: "original",
    };

    expect(recoveredToolItemIds([original, failedAttempt])).toEqual(new Set());
    expect(recoveredToolItemIds([original, failedAttempt, successfulAttempt])).toEqual(
      new Set(["original", "failed-attempt"]),
    );
  });

  test("rejects legacy, successful, recovered, and unsafe retry targets", () => {
    expect(() => resolveToolRetryIntent([], { toolItemIds: ["missing"] })).toThrow(
      "not an unresolved failed tool",
    );
    expect(() =>
      resolveToolRetryIntent(
        [{ ...failedTool("success"), state: "output-available", result: { ok: true } }],
        { toolItemIds: ["success"] },
      ),
    ).toThrow("not an unresolved failed tool");
    expect(() =>
      resolveToolRetryIntent(
        [
          failedTool("recovered"),
          {
            id: "retry",
            kind: "tool",
            ts: "2026-07-10T00:00:01.000Z",
            name: "bash",
            state: "output-available",
            args: { command: "bun test" },
            retryOf: "recovered",
            inputDigest: digestToolInput("bash", { command: "bun test" }) ?? undefined,
          },
        ],
        { toolItemIds: ["recovered"] },
      ),
    ).toThrow("already recovered");
    expect(() =>
      resolveToolRetryIntent(
        [
          {
            ...failedTool("no-args"),
            args: undefined,
            inputDigest: undefined,
          },
        ],
        {
          toolItemIds: ["no-args"],
        },
      ),
    ).toThrow("complete input digest metadata");
    expect(() =>
      resolveToolRetryIntent(
        [
          {
            ...failedTool("legacy-skill", "skill", { name: "missing" }),
            state: "output-available",
            result: "Skill not found: missing",
            inputDigest: undefined,
          },
        ],
        { toolItemIds: ["legacy-skill"] },
      ),
    ).toThrow("complete input digest metadata");
  });

  test("uses a rollback-safe annotation sidecar that survives an old strict read-write", () => {
    const inputDigest = digestToolInput("bash", { command: "bun test" });
    if (!inputDigest) throw new Error("expected input digest");
    const snapshot = snapshotWithFeed([
      {
        id: "user",
        kind: "message",
        role: "user",
        ts: "2026-07-10T00:00:00.000Z",
        text: "Run tests",
      },
      failedTool("failure"),
      {
        id: "retry-turn",
        kind: "message",
        role: "user",
        ts: "2026-07-10T00:00:00.500Z",
        text: "Retry the failed step.",
        annotations: [
          toolRetryTurnAnnotation({
            targets: [{ itemId: "failure", inputDigest }],
          }),
        ],
      },
      {
        id: "replacement",
        kind: "tool",
        ts: "2026-07-10T00:00:01.000Z",
        name: "bash",
        state: "output-available",
        args: { command: "bun test" },
        retryOf: "failure",
        inputDigest,
      },
    ]);
    const encoded = encodeToolRetrySnapshotMetadata(snapshot);
    const encodedTools = encoded.feed.filter((item) => item.kind === "tool");
    expect(encodedTools.every((item) => !("retryOf" in item) && !("inputDigest" in item))).toBe(
      true,
    );

    const legacyToolSchema = z
      .object({
        id: z.string(),
        kind: z.literal("tool"),
        ts: z.string(),
        name: z.string(),
        state: z.string(),
        args: z.unknown().optional(),
        result: z.unknown().optional(),
        completedAt: z.string().optional(),
        approval: z.unknown().optional(),
      })
      .strict();
    const legacyMessageSchema = z
      .object({
        id: z.string(),
        kind: z.literal("message"),
        role: z.enum(["user", "assistant"]),
        ts: z.string(),
        text: z.string(),
        annotations: z.array(z.record(z.string(), z.unknown())).optional(),
      })
      .strict();
    const legacyFeedSchema = z.array(
      z.discriminatedUnion("kind", [legacyToolSchema, legacyMessageSchema]),
    );
    const oldBinaryFeed = legacyFeedSchema.parse(encoded.feed);
    expect(oldBinaryFeed.map((item) => item.id)).toEqual(["user", "failure", "replacement"]);

    const oldBinaryWrite = JSON.parse(
      JSON.stringify({
        ...encoded,
        feed: oldBinaryFeed,
      }),
    ) as typeof encoded;
    const hydrated = hydrateToolRetrySnapshotMetadata(sessionSnapshotSchema.parse(oldBinaryWrite));
    expect(hydrated.feed.find((item) => item.id === "failure")).toMatchObject({
      inputDigest,
    });
    expect(hydrated.feed.find((item) => item.id === "replacement")).toMatchObject({
      retryOf: "failure",
      inputDigest,
    });
    expect(hydrated.feed.some((item) => item.id === "retry-turn")).toBe(false);
  });

  test("preserves recovered lineage across restart through the retained 2,000-item feed", () => {
    const inputDigest = digestToolInput("bash", { command: "bun test" });
    if (!inputDigest) throw new Error("expected input digest");
    const laterCalls: SessionFeedItem[] = Array.from(
      { length: SESSION_FEED_ITEM_LIMIT - 3 },
      (_, index) => ({
        id: `later-${index}`,
        kind: "tool",
        ts: "2026-07-10T00:00:02.000Z",
        name: "bash",
        state: "output-available",
        args: { command: `echo ${index}` },
        inputDigest: digestToolInput("bash", { command: `echo ${index}` }) ?? undefined,
      }),
    );
    const snapshot = snapshotWithFeed([
      {
        id: "user",
        kind: "message",
        role: "user",
        ts: "2026-07-10T00:00:00.000Z",
        text: "Run tests",
      },
      failedTool("failure"),
      {
        id: "replacement",
        kind: "tool",
        ts: "2026-07-10T00:00:01.000Z",
        name: "bash",
        state: "output-available",
        args: { command: "bun test" },
        retryOf: "failure",
        inputDigest,
      },
      ...laterCalls,
    ]);

    const restarted = hydrateToolRetrySnapshotMetadata(
      sessionSnapshotSchema.parse(
        JSON.parse(JSON.stringify(encodeToolRetrySnapshotMetadata(snapshot))),
      ),
    );

    expect(restarted.feed.find((item) => item.id === "replacement")).toMatchObject({
      retryOf: "failure",
      inputDigest,
    });
    expect(recoveredToolItemIds(restarted.feed)).toContain("failure");
  });
});
