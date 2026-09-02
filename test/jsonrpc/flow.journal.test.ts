import { describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import path from "node:path";
import { jsonRpcThreadTurnRequestSchemas } from "../../src/server/jsonrpc/schema.threadTurn";
import { startAgentServer } from "../../src/server/startServer";
import {
  MAX_ATTACHMENT_BASE64_SIZE,
  MAX_TURN_ATTACHMENT_COUNT,
  MAX_TURN_ATTACHMENT_TOTAL_BASE64_SIZE,
} from "../../src/shared/attachments";
import { makeTmpProject, serverOpts, stopTestServer } from "../helpers/wsHarness";
import {
  connectJsonRpc,
  JSONRPC_REPLAY_TEST_TIMEOUT_MS,
  JSONRPC_REPLAY_WAIT_TIMEOUT_MS,
} from "./flow.harness";

describe("server JSON-RPC flows", () => {
  test("thread/start is idempotent for a stable clientThreadId", {
    timeout: JSONRPC_REPLAY_TEST_TIMEOUT_MS,
  }, async () => {
    const tmpDir = await makeTmpProject();
    const { server, url } = await startAgentServer(serverOpts(tmpDir));

    try {
      const rpc = await connectJsonRpc(url);
      const first = await rpc.sendRequest(
        "thread/start",
        {
          cwd: tmpDir,
          clientThreadId: "desktop-draft-1",
        },
        JSONRPC_REPLAY_WAIT_TIMEOUT_MS,
      );
      const second = await rpc.sendRequest(
        "thread/start",
        {
          cwd: tmpDir,
          clientThreadId: "desktop-draft-1",
        },
        JSONRPC_REPLAY_WAIT_TIMEOUT_MS,
      );

      expect(second.result.thread.id).toBe(first.result.thread.id);
      await rpc.sendRequest("thread/read", {
        threadId: first.result.thread.id,
        includeTurns: true,
      });
      rpc.close();
    } finally {
      await stopTestServer(server);
    }
  });

  test("thread/start idempotency survives a server restart", async () => {
    const tmpDir = await makeTmpProject();
    let threadId = "";

    {
      const { server, url } = await startAgentServer(serverOpts(tmpDir));
      try {
        const rpc = await connectJsonRpc(url);
        const first = await rpc.sendRequest("thread/start", {
          cwd: tmpDir,
          clientThreadId: "desktop-draft-after-restart",
        });
        threadId = first.result.thread.id;
        await rpc.sendRequest("thread/read", { threadId });
        rpc.close();
      } finally {
        await stopTestServer(server);
      }
    }

    const { server, url } = await startAgentServer(serverOpts(tmpDir));
    try {
      const rpc = await connectJsonRpc(url);
      const replayed = await rpc.sendRequest("thread/start", {
        cwd: tmpDir,
        clientThreadId: "desktop-draft-after-restart",
      });

      expect(replayed.result.thread.id).toBe(threadId);
      rpc.close();
    } finally {
      await stopTestServer(server);
    }
  });

  test("thread/resume reports a replay gap when afterSeq is beyond the journal tail", async () => {
    const tmpDir = await makeTmpProject();
    const { server, url } = await startAgentServer(serverOpts(tmpDir));

    try {
      const rpc = await connectJsonRpc(url);
      const started = await rpc.sendRequest("thread/start", { cwd: tmpDir });
      await rpc.waitFor((message) => message.method === "thread/started");
      const resumed = await rpc.sendRequest("thread/resume", {
        threadId: started.result.thread.id,
        afterSeq: 999_999,
      });

      expect(resumed.result.replayHealth).toMatchObject({
        trusted: false,
        snapshotRequired: true,
        reason: "after_seq_beyond_tail",
      });
      rpc.close();
    } finally {
      await stopTestServer(server);
    }
  });

  test("runtime diagnostics exposes send queue, journal, and DB lock counters", async () => {
    const tmpDir = await makeTmpProject();
    const { server, url } = await startAgentServer(serverOpts(tmpDir));

    try {
      const rpc = await connectJsonRpc(url);
      const result = await rpc.sendRequest("cowork/runtime/diagnostics/read");

      expect(result.result.diagnostics).toMatchObject({
        sendQueue: {
          queuedSends: expect.any(Number),
          droppedDeltas: expect.any(Number),
          droppedImportant: expect.any(Number),
        },
        journal: {
          untrustedThreadCount: expect.any(Number),
          failedWriteCount: expect.any(Number),
          droppedEventCount: expect.any(Number),
        },
        dbLocks: {
          waitCount: expect.any(Number),
          timeoutCount: expect.any(Number),
          sqliteLockErrorCount: expect.any(Number),
        },
      });
      rpc.close();
    } finally {
      await stopTestServer(server);
    }
  });

  test("thread/resume does not duplicate a pending user input request when afterSeq also replays it", async () => {
    const tmpDir = await makeTmpProject();
    const { server, url } = await startAgentServer(
      serverOpts(tmpDir, {
        runTurnImpl: (async (params: any) => {
          const answer = await params.askUser("Pick one", ["a", "b"]);
          return {
            text: `answer:${answer}`,
            responseMessages: [],
          };
        }) as any,
      }),
    );

    try {
      const rpc = await connectJsonRpc(url);
      const started = await rpc.sendRequest("thread/start", { cwd: tmpDir });
      await rpc.waitFor((message) => message.method === "thread/started");
      const beforeTurnRead = await rpc.sendRequest("thread/read", {
        threadId: started.result.thread.id,
        includeTurns: true,
      });

      await rpc.sendRequest("turn/start", {
        threadId: started.result.thread.id,
        input: [{ type: "text", text: "start ask replay dedupe flow" }],
      });

      const request = await rpc.waitFor(
        (message) => message.method === "item/tool/requestUserInput",
      );
      expect(beforeTurnRead.result.journalTailSeq).toBeGreaterThan(0);
      rpc.close();

      const replayRpc = await connectJsonRpc(url);
      const resumeResponse = replayRpc.sendRequest("thread/resume", {
        threadId: started.result.thread.id,
        afterSeq: beforeTurnRead.result.journalTailSeq,
      });
      const replayedRequest = await replayRpc.waitFor(
        (message) => message.method === "item/tool/requestUserInput",
      );
      const replayedThreadStarted = await replayRpc.waitFor(
        (message) => message.method === "thread/started",
      );
      const resumed = await resumeResponse;

      expect(resumed.result.thread.id).toBe(started.result.thread.id);
      expect(replayedThreadStarted.params.thread.id).toBe(started.result.thread.id);
      expect(replayedRequest.id).toBe(request.id);
      expect(replayedRequest.params.requestId).toBe(request.params.requestId);
      await expect(
        replayRpc.waitFor(
          (message) =>
            message.method === "item/tool/requestUserInput" &&
            message.params.requestId === request.params.requestId,
          250,
        ),
      ).rejects.toThrow(/Timed out waiting for JSON-RPC message/);

      replayRpc.sendResponse(replayedRequest.id, { answer: "a" });
      const resolved = await replayRpc.waitFor(
        (message) => message.method === "serverRequest/resolved",
      );
      const agentCompleted = await replayRpc.waitFor(
        (message) =>
          message.method === "item/completed" && message.params.item.type === "agentMessage",
      );
      expect(resolved.params.requestId).toBe(request.params.requestId);
      expect(agentCompleted.params.item.text).toBe("answer:a");
      replayRpc.close();
    } finally {
      await stopTestServer(server);
    }
  });

  test("thread/read can include journal-projected turns and thread/resume can replay from a journal cursor", {
    timeout: JSONRPC_REPLAY_TEST_TIMEOUT_MS,
  }, async () => {
    const tmpDir = await makeTmpProject();
    const { server, url } = await startAgentServer(
      serverOpts(tmpDir, {
        runTurnImpl: (async (params: any) => {
          await params.onModelStreamPart?.({ type: "start" });
          await params.onModelStreamPart?.({
            type: "reasoning-start",
            id: "rs_journal",
            mode: "summary",
          });
          await params.onModelStreamPart?.({
            type: "reasoning-delta",
            id: "rs_journal",
            text: "Inspecting the reports.",
          });
          await params.onModelStreamPart?.({
            type: "reasoning-end",
            id: "rs_journal",
            mode: "summary",
          });
          await params.onModelStreamPart?.({
            type: "text-delta",
            id: "txt_journal",
            text: "journal reply",
          });
          await params.onModelStreamPart?.({ type: "finish", finishReason: "stop" });
          return {
            text: "journal reply",
            reasoningText: "Inspecting the reports.",
            responseMessages: [],
          };
        }) as any,
      }),
    );

    try {
      const rpc = await connectJsonRpc(url);
      const started = await rpc.sendRequest("thread/start", { cwd: tmpDir });
      await rpc.waitFor((message) => message.method === "thread/started");
      await rpc.sendRequest("turn/start", {
        threadId: started.result.thread.id,
        clientMessageId: "journal-msg-1",
        input: [{ type: "text", text: "build the journal" }],
      });
      await rpc.waitFor((message) => message.method === "turn/completed");

      const read = await rpc.sendRequest("thread/read", {
        threadId: started.result.thread.id,
        includeTurns: true,
      });
      expect(read.result.thread.turns).toHaveLength(1);
      expect(read.result.thread.turns[0].items).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ type: "userMessage", clientMessageId: "journal-msg-1" }),
          expect.objectContaining({
            type: "reasoning",
            mode: "reasoning",
            text: "Inspecting the reports.",
          }),
          expect.objectContaining({ type: "agentMessage", text: "journal reply" }),
        ]),
      );
      expect(read.result.journalTailSeq).toBeGreaterThan(0);

      const replayRpc = await connectJsonRpc(url);
      await replayRpc.sendRequest("thread/resume", {
        threadId: started.result.thread.id,
        afterSeq: 1,
      });
      const replayedTurnStarted = await replayRpc.waitFor(
        (message) => message.method === "turn/started",
      );
      const replayedReasoningStarted = await replayRpc.waitFor(
        (message) => message.method === "item/started" && message.params.item.type === "reasoning",
      );
      const replayedReasoningDelta = await replayRpc.waitFor(
        (message) => message.method === "item/reasoning/delta",
      );
      const replayedAgentCompleted = await replayRpc.waitFor(
        (message) =>
          message.method === "item/completed" && message.params.item.type === "agentMessage",
      );
      expect(replayedTurnStarted.params.threadId).toBe(started.result.thread.id);
      expect(replayedReasoningStarted.params.item.text).toBe("");
      expect(replayedReasoningDelta.params.delta).toBe("Inspecting the reports.");
      expect(replayedReasoningDelta.params.itemId).toBe(replayedReasoningStarted.params.item.id);
      expect(replayedAgentCompleted.params.item.text).toBe("journal reply");

      replayRpc.close();
      rpc.close();
    } finally {
      await stopTestServer(server);
    }
  });

  test("thread/resume honors notification opt-outs while replaying journal events", async () => {
    const tmpDir = await makeTmpProject();
    const { server, url } = await startAgentServer(
      serverOpts(tmpDir, {
        runTurnImpl: (async (params: any) => {
          await params.onModelStreamPart?.({ type: "start" });
          await params.onModelStreamPart?.({
            type: "text-delta",
            id: "txt_optout",
            text: "journal delta",
          });
          await params.onModelStreamPart?.({ type: "finish", finishReason: "stop" });
          return {
            text: "journal delta",
            responseMessages: [],
          };
        }) as any,
      }),
    );

    try {
      const rpc = await connectJsonRpc(url);
      const started = await rpc.sendRequest("thread/start", { cwd: tmpDir });
      await rpc.waitFor((message) => message.method === "thread/started");
      await rpc.sendRequest("turn/start", {
        threadId: started.result.thread.id,
        input: [{ type: "text", text: "build the journal" }],
      });
      await rpc.waitFor((message) => message.method === "turn/completed");

      const replayRpc = await connectJsonRpc(url, {
        optOutNotificationMethods: ["item/agentMessage/delta"],
      });
      await replayRpc.sendRequest("thread/resume", {
        threadId: started.result.thread.id,
        afterSeq: 1,
      });
      const replayedTurnStarted = await replayRpc.waitFor(
        (message) => message.method === "turn/started",
      );
      const replayedAgentCompleted = await replayRpc.waitFor(
        (message) =>
          message.method === "item/completed" && message.params.item.type === "agentMessage",
      );

      expect(replayedTurnStarted.params.threadId).toBe(started.result.thread.id);
      expect(replayedAgentCompleted.params.item.text).toBe("journal delta");
      await expect(
        replayRpc.waitFor((message) => message.method === "item/agentMessage/delta", 250),
      ).rejects.toThrow(/Timed out waiting for JSON-RPC message/);

      replayRpc.close();
      rpc.close();
    } finally {
      await stopTestServer(server);
    }
  });

  test("thread/resume replays a journal cursor once before reattaching the live thread sink", {
    timeout: JSONRPC_REPLAY_TEST_TIMEOUT_MS,
  }, async () => {
    const tmpDir = await makeTmpProject();
    let releaseSecondChunk: (() => void) | undefined;
    const runTurnImpl = async (params: any) => {
      await params.onModelStreamPart?.({ type: "start" });
      await params.onModelStreamPart?.({
        type: "text-delta",
        id: "txt_resume",
        text: "before disconnect",
      });
      await new Promise<void>((resolve) => {
        releaseSecondChunk = resolve;
      });
      await params.onModelStreamPart?.({
        type: "text-delta",
        id: "txt_resume",
        text: "after disconnect",
      });
      await params.onModelStreamPart?.({ type: "finish", finishReason: "stop" });
      return {
        text: "after disconnect",
        responseMessages: [],
      };
    };

    const { server, url } = await startAgentServer(
      serverOpts(tmpDir, {
        runTurnImpl: runTurnImpl as any,
      }),
    );

    try {
      const rpc = await connectJsonRpc(url);
      const started = await rpc.sendRequest("thread/start", { cwd: tmpDir });
      await rpc.waitFor((message) => message.method === "thread/started");
      const beforeTurnRead = await rpc.sendRequest("thread/read", {
        threadId: started.result.thread.id,
        includeTurns: true,
      });
      await rpc.sendRequest("turn/start", {
        threadId: started.result.thread.id,
        input: [{ type: "text", text: "build the journal" }],
      });
      await rpc.waitFor(
        (message) =>
          message.method === "item/agentMessage/delta" &&
          message.params.delta === "before disconnect",
      );

      expect(beforeTurnRead.result.journalTailSeq).toBeGreaterThan(0);
      rpc.close();

      const replayRpc = await connectJsonRpc(url);
      const resumeResponse = replayRpc.sendRequest("thread/resume", {
        threadId: started.result.thread.id,
        afterSeq: beforeTurnRead.result.journalTailSeq,
      });
      await replayRpc.waitFor((message) => message.method === "thread/started");
      releaseSecondChunk?.();

      const replayedDelta = await replayRpc.waitFor(
        (message) =>
          message.method === "item/agentMessage/delta" &&
          message.params.delta === "after disconnect",
      );
      const resumed = await resumeResponse;

      expect(resumed.result.thread.id).toBe(started.result.thread.id);
      expect(replayedDelta.params.delta).toBe("after disconnect");
      await expect(
        replayRpc.waitFor(
          (message) =>
            message.method === "item/agentMessage/delta" &&
            message.params.delta === "after disconnect",
          250,
        ),
      ).rejects.toThrow(/Timed out waiting for JSON-RPC message/);
      replayRpc.close();
    } finally {
      releaseSecondChunk?.();
      await stopTestServer(server);
    }
  });

  test("thread/resume seeds the live projector so finish-only completions survive reconnect", async () => {
    const tmpDir = await makeTmpProject();
    let releaseFinish: (() => void) | undefined;
    const runTurnImpl = async (params: any) => {
      await params.onModelStreamPart?.({ type: "start" });
      await params.onModelStreamPart?.({
        type: "text-delta",
        id: "txt_resume_seed",
        text: "before disconnect",
      });
      await new Promise<void>((resolve) => {
        releaseFinish = resolve;
      });
      await params.onModelStreamPart?.({ type: "finish", finishReason: "stop" });
      return {
        text: "before disconnect",
        responseMessages: [],
      };
    };

    const { server, url } = await startAgentServer(
      serverOpts(tmpDir, {
        runTurnImpl: runTurnImpl as any,
      }),
    );

    try {
      const rpc = await connectJsonRpc(url);
      const started = await rpc.sendRequest("thread/start", { cwd: tmpDir });
      await rpc.waitFor((message) => message.method === "thread/started");
      const beforeTurnRead = await rpc.sendRequest("thread/read", {
        threadId: started.result.thread.id,
        includeTurns: true,
      });
      await rpc.sendRequest("turn/start", {
        threadId: started.result.thread.id,
        input: [{ type: "text", text: "resume me" }],
      });
      await rpc.waitFor(
        (message) =>
          message.method === "item/agentMessage/delta" &&
          message.params.delta === "before disconnect",
      );
      rpc.close();

      const replayRpc = await connectJsonRpc(url);
      const resumeResponse = replayRpc.sendRequest("thread/resume", {
        threadId: started.result.thread.id,
        afterSeq: beforeTurnRead.result.journalTailSeq,
      });
      await replayRpc.waitFor((message) => message.method === "thread/started");
      releaseFinish?.();

      const completed = await replayRpc.waitFor(
        (message) =>
          message.method === "item/completed" && message.params.item.type === "agentMessage",
      );
      const resumed = await resumeResponse;

      expect(resumed.result.thread.id).toBe(started.result.thread.id);
      expect(completed.params.item.text).toBe("before disconnect");
      replayRpc.close();
    } finally {
      releaseFinish?.();
      await stopTestServer(server);
    }
  });

  test("thread/resume never seeds a new turn with the previous turn's answer", async () => {
    const tmpDir = await makeTmpProject();
    const continueCurrentTurn = Promise.withResolvers<void>();
    let runCount = 0;
    const { server, url } = await startAgentServer(
      serverOpts(tmpDir, {
        runTurnImpl: (async (params: any) => {
          runCount += 1;
          if (runCount === 1) {
            return {
              text: "Previous turn answer",
              responseMessages: [{ role: "assistant", content: "Previous turn answer" }],
            };
          }
          await continueCurrentTurn.promise;
          await params.onModelStreamPart?.({ type: "reasoning-start", id: "current-reasoning" });
          await params.onModelStreamPart?.({
            type: "reasoning-delta",
            id: "current-reasoning",
            text: "Think about the current request",
          });
          await params.onModelStreamPart?.({ type: "reasoning-end", id: "current-reasoning" });
          await params.onModelStreamPart?.({
            type: "text-delta",
            id: "current-answer",
            text: "Current turn answer",
          });
          await params.onModelStreamPart?.({ type: "finish", finishReason: "stop" });
          return {
            text: "Current turn answer",
            responseMessages: [{ role: "assistant", content: "Current turn answer" }],
          };
        }) as any,
      }),
    );
    let replayRpc: Awaited<ReturnType<typeof connectJsonRpc>> | undefined;
    try {
      const rpc = await connectJsonRpc(url);
      const started = await rpc.sendRequest("thread/start", { cwd: tmpDir });
      const threadId = started.result.thread.id;
      await rpc.sendRequest("turn/start", { threadId, input: "previous request" });
      await rpc.waitFor((message) => message.method === "turn/completed");
      const current = await rpc.sendRequest("turn/start", { threadId, input: "current request" });
      await rpc.sendRequest("thread/unsubscribe", { threadId });
      rpc.close();

      replayRpc = await connectJsonRpc(url);
      const observed: any[] = [];
      replayRpc.ws.addEventListener("message", (event) => {
        observed.push(JSON.parse(String(event.data)));
      });
      await replayRpc.sendRequest("thread/resume", { threadId });
      continueCurrentTurn.resolve();
      await replayRpc.waitFor((message) => message.method === "turn/completed");

      const answers = observed.filter(
        (message) =>
          message.method === "item/completed" &&
          message.params.turnId === current.result.turn.id &&
          message.params.item.type === "agentMessage",
      );
      expect(answers.map((message) => message.params.item.text)).toEqual(["Current turn answer"]);
    } finally {
      continueCurrentTurn.resolve();
      replayRpc?.close();
      await stopTestServer(server);
    }
  });

  test.each([false, true])(
    "thread/resume preserves multi-subscriber live and buffered item occurrences (journal cursor: %s)",
    async (withCursor) => {
      const tmpDir = await makeTmpProject();
      const continueConnectedTurn = Promise.withResolvers<void>();
      const continueDisconnectedTurn = Promise.withResolvers<void>();
      const disconnectedOutputWritten = Promise.withResolvers<void>();
      const finishTurn = Promise.withResolvers<void>();
      const { server, url } = await startAgentServer(
        serverOpts(tmpDir, {
          runTurnImpl: (async (params: any) => {
            await params.onModelStreamPart?.({
              type: "text-delta",
              id: "first",
              text: "First segment",
            });
            await params.onModelStreamPart?.({ type: "reasoning-start", id: "middle" });
            await params.onModelStreamPart?.({
              type: "reasoning-delta",
              id: "middle",
              text: "Thinking",
            });
            await params.onModelStreamPart?.({ type: "reasoning-end", id: "middle" });
            await params.onModelStreamPart?.({
              type: "text-delta",
              id: "second",
              text: "Second segment",
            });
            await continueConnectedTurn.promise;
            await params.onModelStreamPart?.({
              type: "text-delta",
              id: "second",
              text: " still connected",
            });
            await continueDisconnectedTurn.promise;
            await params.onModelStreamPart?.({
              type: "text-delta",
              id: "second",
              text: " continued",
            });
            await params.onModelStreamPart?.({ type: "reasoning-start", id: "last" });
            disconnectedOutputWritten.resolve();
            await finishTurn.promise;
            await params.onModelStreamPart?.({ type: "reasoning-end", id: "last" });
            await params.onModelStreamPart?.({
              type: "text-delta",
              id: "final",
              text: "Final segment",
            });
            await params.onModelStreamPart?.({ type: "finish", finishReason: "stop" });
            return { text: "Final segment", responseMessages: [] };
          }) as any,
        }),
      );
      let replayRpc: Awaited<ReturnType<typeof connectJsonRpc>> | undefined;
      let remainingRpc: Awaited<ReturnType<typeof connectJsonRpc>> | undefined;
      try {
        const rpc = await connectJsonRpc(url);
        const started = await rpc.sendRequest("thread/start", { cwd: tmpDir });
        const threadId = started.result.thread.id;
        remainingRpc = await connectJsonRpc(url);
        await remainingRpc.sendRequest("thread/resume", { threadId });
        const turn = await rpc.sendRequest("turn/start", {
          threadId,
          input: "multi-segment reply",
        });
        const secondDelta = await rpc.waitFor(
          (message) =>
            message.method === "item/agentMessage/delta" &&
            message.params.delta === "Second segment",
        );
        const firstClosed = new Promise<void>((resolve) => {
          rpc.ws.addEventListener("close", () => resolve(), { once: true });
        });
        rpc.close();
        await firstClosed;
        continueConnectedTurn.resolve();
        const stillConnected = await remainingRpc.waitFor(
          (message) =>
            message.method === "item/agentMessage/delta" &&
            message.params.delta === " still connected",
        );
        expect(stillConnected.params.itemId).toBe(secondDelta.params.itemId);
        const beforeDisconnect = await remainingRpc.sendRequest("thread/read", {
          threadId,
          includeTurns: true,
        });
        await remainingRpc.sendRequest("thread/unsubscribe", { threadId });
        continueDisconnectedTurn.resolve();
        await disconnectedOutputWritten.promise;
        remainingRpc.close();

        replayRpc = await connectJsonRpc(url);
        const replayedDeltas: string[] = [];
        replayRpc.ws.addEventListener("message", (event) => {
          const message = JSON.parse(String(event.data));
          if (message.method === "item/agentMessage/delta") {
            replayedDeltas.push(message.params.delta);
          }
        });
        await replayRpc.sendRequest("thread/resume", {
          threadId,
          ...(withCursor ? { afterSeq: beforeDisconnect.result.journalTailSeq } : {}),
        });
        const continued = await replayRpc.waitFor(
          (message) =>
            message.method === "item/agentMessage/delta" && message.params.delta === " continued",
        );
        expect(continued.params.itemId).toBe(secondDelta.params.itemId);
        finishTurn.resolve();
        const final = await replayRpc.waitFor(
          (message) =>
            message.method === "item/completed" &&
            message.params.item.type === "agentMessage" &&
            message.params.item.text === "Final segment",
        );
        await replayRpc.waitFor((message) => message.method === "turn/completed");
        const canonical = await replayRpc.sendRequest("thread/read", {
          threadId,
          includeTurns: true,
        });
        const canonicalTurn = canonical.result.thread.turns.find(
          (entry: any) => entry.id === turn.result.turn.id,
        );
        const canonicalFinal = canonicalTurn.items.find(
          (item: any) => item.type === "agentMessage" && item.text === "Final segment",
        );
        expect(final.params.item.id).toBe(canonicalFinal.id);
        expect(final.params.item.id).not.toBe(secondDelta.params.itemId);
        expect(replayedDeltas.filter((delta) => delta === " continued")).toHaveLength(1);
        expect(replayedDeltas).not.toContain(" still connected");
        expect(canonicalTurn.items).toContainEqual(
          expect.objectContaining({
            id: secondDelta.params.itemId,
            text: "Second segment still connected continued",
          }),
        );
      } finally {
        continueConnectedTurn.resolve();
        continueDisconnectedTurn.resolve();
        finishTurn.resolve();
        remainingRpc?.close();
        replayRpc?.close();
        await stopTestServer(server);
      }
    },
  );

  test("thread/read, thread/hydrate and thread/resume replay journals beyond 1000 events", {
    timeout: JSONRPC_REPLAY_TEST_TIMEOUT_MS,
  }, async () => {
    const tmpDir = await makeTmpProject();
    const deltaCount = 1_005;
    const finalText = Array.from({ length: deltaCount }, (_, index) => `chunk-${index}`).join("");
    const runTurnImpl = async (params: any) => {
      await params.onModelStreamPart?.({ type: "start" });
      await params.onModelStreamPart?.({ type: "reasoning-start", id: "rs_1", mode: "reasoning" });
      for (let index = 0; index < deltaCount; index += 1) {
        await params.onModelStreamPart?.({
          type: "reasoning-delta",
          id: "rs_1",
          text: `chunk-${index}`,
        });
      }
      await params.onModelStreamPart?.({ type: "reasoning-end", id: "rs_1", mode: "reasoning" });
      await params.onModelStreamPart?.({
        type: "text-delta",
        id: "txt_1",
        text: finalText,
      });
      await params.onModelStreamPart?.({ type: "finish", finishReason: "stop" });
      return {
        text: finalText,
        responseMessages: [],
      };
    };

    const { server, url } = await startAgentServer(
      serverOpts(tmpDir, {
        runTurnImpl: runTurnImpl as any,
      }),
    );

    try {
      const rpc = await connectJsonRpc(url);
      const started = await rpc.sendRequest("thread/start", { cwd: tmpDir });
      await rpc.waitFor((message) => message.method === "thread/started");

      await rpc.sendRequest("turn/start", {
        threadId: started.result.thread.id,
        input: [{ type: "text", text: "flood the journal" }],
      });
      await rpc.waitFor(
        (message) => message.method === "turn/completed",
        JSONRPC_REPLAY_WAIT_TIMEOUT_MS,
      );

      const read = await rpc.sendRequest("thread/read", {
        threadId: started.result.thread.id,
        includeTurns: true,
      });
      expect(read.result.journalTailSeq).toBeGreaterThan(1_000);
      expect(read.result.coworkSnapshot.feed.at(-1)?.text).toContain("chunk-1004");
      const hydrate = await rpc.sendRequest("thread/hydrate", {
        threadId: started.result.thread.id,
        afterSeq: 1,
        includeTurns: true,
      });
      expect(hydrate.result.thread.turns).toEqual(read.result.thread.turns);
      expect(hydrate.result.journalTailSeq).toBe(read.result.journalTailSeq);
      expect(hydrate.result.coworkSnapshot).toEqual(read.result.coworkSnapshot);
      rpc.close();

      const replayRpc = await connectJsonRpc(url);
      const resumeResponse = replayRpc.sendRequest("thread/resume", {
        threadId: started.result.thread.id,
        afterSeq: 1,
      });
      await replayRpc.waitFor((message) => message.method === "thread/started");
      const replayedLastDelta = await replayRpc.waitFor(
        (message) =>
          message.method === "item/reasoning/delta" && message.params.delta === "chunk-1004",
        JSONRPC_REPLAY_WAIT_TIMEOUT_MS,
      );
      const resumed = await resumeResponse;

      expect(resumed.result.thread.id).toBe(started.result.thread.id);
      expect(replayedLastDelta.params.delta).toBe("chunk-1004");
      replayRpc.close();
    } finally {
      await stopTestServer(server);
    }
  });
});
