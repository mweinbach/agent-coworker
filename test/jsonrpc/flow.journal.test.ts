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

  test("thread/read and thread/resume replay journals beyond 1000 events", {
    timeout: JSONRPC_REPLAY_TEST_TIMEOUT_MS,
  }, async () => {
    const tmpDir = await makeTmpProject();
    const deltaCount = 1_005;
    const finalText = Array.from({ length: deltaCount }, (_, index) => `chunk-${index}`).join("");
    const runTurnImpl = async (params: any) => {
      await params.onModelStreamPart?.({ type: "start" });
      for (let index = 0; index < deltaCount; index += 1) {
        await params.onModelStreamPart?.({
          type: "text-delta",
          id: `txt_${index}`,
          text: `chunk-${index}`,
        });
      }
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
      rpc.close();

      const replayRpc = await connectJsonRpc(url);
      const resumeResponse = replayRpc.sendRequest("thread/resume", {
        threadId: started.result.thread.id,
        afterSeq: 1,
      });
      await replayRpc.waitFor((message) => message.method === "thread/started");
      const replayedLastDelta = await replayRpc.waitFor(
        (message) =>
          message.method === "item/agentMessage/delta" && message.params.delta === "chunk-1004",
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
