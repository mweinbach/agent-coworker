import { describe, expect, spyOn, test } from "bun:test";
import fs from "node:fs/promises";
import path from "node:path";
import { jsonRpcThreadTurnRequestSchemas } from "../../src/server/jsonrpc/schema.threadTurn";
import { AgentSession } from "../../src/server/session/AgentSession";
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
  test("thread/hydrate returns snapshot + turns without subscribing the client", {
    timeout: JSONRPC_REPLAY_TEST_TIMEOUT_MS,
  }, async () => {
    const tmpDir = await makeTmpProject();
    let releaseSecondTurn: (() => void) | undefined;
    const { server, url } = await startAgentServer(
      serverOpts(tmpDir, {
        runTurnImpl: (async (params: any) => {
          await params.onModelStreamPart?.({ type: "start" });
          await params.onModelStreamPart?.({
            type: "text-delta",
            id: "txt_hydrate",
            text: "first reply",
          });
          await params.onModelStreamPart?.({ type: "finish", finishReason: "stop" });
          if (releaseSecondTurn) {
            await new Promise<void>((resolve) => {
              releaseSecondTurn = resolve;
            });
          }
          return { text: "first reply", responseMessages: [] };
        }) as any,
      }),
    );

    const turnSettlements: Promise<void>[] = [];
    const sendUserMessage = AgentSession.prototype.sendUserMessage;
    const sendTurn = spyOn(AgentSession.prototype, "sendUserMessage").mockImplementation(function (
      this: AgentSession,
      ...args
    ) {
      const turn = sendUserMessage.apply(this, args);
      const settled = turn.then(() => this.waitForPersistenceIdle({ throwOnError: true }));
      // Keep the original turn timing; only this test waits for persistence.
      void settled.catch(() => {});
      turnSettlements.push(settled);
      return turn;
    });

    try {
      const producer = await connectJsonRpc(url);
      const started = await producer.sendRequest("thread/start", { cwd: tmpDir });
      await producer.waitFor((message) => message.method === "thread/started");
      await producer.sendRequest("turn/start", {
        threadId: started.result.thread.id,
        input: [{ type: "text", text: "first input" }],
      });
      await producer.waitFor((message) => message.method === "turn/completed");
      // turn/completed precedes the final session_info.updated checkpoint.
      // Drain the actual turn and persistence queue before comparing read-only
      // snapshots, including lastEventSeq; the notification alone is not a barrier.
      expect(turnSettlements).toHaveLength(1);
      await turnSettlements[0];

      // Separate client hydrates — should receive snapshot + turns, no subscription.
      const hydrator = await connectJsonRpc(url);
      const hydrate = await hydrator.sendRequest("thread/hydrate", {
        threadId: started.result.thread.id,
        includeTurns: true,
      });
      expect(hydrate.result.thread.id).toBe(started.result.thread.id);
      expect(hydrate.result.thread.turns).toHaveLength(1);
      expect(hydrate.result.thread.turns[0].items).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ type: "agentMessage", text: "first reply" }),
        ]),
      );
      expect(hydrate.result.coworkSnapshot).toBeTruthy();
      expect(hydrate.result.journalTailSeq).toBeGreaterThan(0);

      const read = await hydrator.sendRequest("thread/read", {
        threadId: started.result.thread.id,
        includeTurns: true,
      });
      expect(read.result).toEqual(hydrate.result);
      for (const method of ["thread/read", "thread/hydrate"]) {
        const snapshotOnly = await hydrator.sendRequest(method, {
          threadId: started.result.thread.id,
        });
        expect(snapshotOnly.result.thread).not.toHaveProperty("turns");
        expect(snapshotOnly.result).not.toHaveProperty("journalTailSeq");
        expect(snapshotOnly.result.coworkSnapshot).toEqual(hydrate.result.coworkSnapshot);
        expect(snapshotOnly.result.replayHealth).toEqual(hydrate.result.replayHealth);
      }
      const subscription = await hydrator.sendRequest("thread/unsubscribe", {
        threadId: started.result.thread.id,
      });
      expect(subscription.result.status).toBe("notSubscribed");

      // Producer starts a second turn. Hydrator must not receive any live events.
      await producer.sendRequest("turn/start", {
        threadId: started.result.thread.id,
        input: [{ type: "text", text: "second input" }],
      });
      await producer.waitFor((message) => message.method === "turn/completed");
      expect(turnSettlements).toHaveLength(2);
      await turnSettlements[1];
      await expect(
        hydrator.waitFor((message) => message.method === "turn/started", 500),
      ).rejects.toThrow(/Timed out waiting for JSON-RPC message/);

      const hydrateAgain = await hydrator.sendRequest("thread/hydrate", {
        threadId: started.result.thread.id,
        afterSeq: hydrate.result.journalTailSeq,
        includeTurns: true,
      });
      expect(hydrateAgain.result.journalTailSeq).toBeGreaterThan(hydrate.result.journalTailSeq);
      expect(hydrateAgain.result.thread.turns).toHaveLength(1);
      expect(hydrateAgain.result.thread.turns[0].items).toContainEqual(
        expect.objectContaining({
          type: "userMessage",
          content: [{ type: "text", text: "second input" }],
        }),
      );
      expect(hydrateAgain.result.thread.turns[0].id).not.toBe(hydrate.result.thread.turns[0].id);

      const caughtUp = await hydrator.sendRequest("thread/hydrate", {
        threadId: started.result.thread.id,
        afterSeq: hydrateAgain.result.journalTailSeq,
        includeTurns: true,
      });
      expect(caughtUp.result.thread.turns).toEqual([]);
      expect(caughtUp.result.journalTailSeq).toBe(hydrateAgain.result.journalTailSeq);
      expect(caughtUp.result.coworkSnapshot).toEqual(hydrateAgain.result.coworkSnapshot);
      expect(caughtUp.result.replayHealth.snapshotRequired).toBe(false);

      const futureCursor = caughtUp.result.journalTailSeq + 100;
      for (const includeTurns of [true, false]) {
        const beyondTail = await hydrator.sendRequest("thread/hydrate", {
          threadId: started.result.thread.id,
          afterSeq: futureCursor,
          includeTurns,
        });
        expect(beyondTail.result.coworkSnapshot).toEqual(caughtUp.result.coworkSnapshot);
        expect(beyondTail.result.replayHealth).toMatchObject({
          trusted: false,
          snapshotRequired: true,
          reason: "after_seq_beyond_tail",
          tailSeq: caughtUp.result.journalTailSeq,
        });
        if (includeTurns) {
          expect(beyondTail.result.thread.turns).toEqual([]);
          expect(beyondTail.result.journalTailSeq).toBe(futureCursor);
        } else {
          expect(beyondTail.result.thread).not.toHaveProperty("turns");
          expect(beyondTail.result).not.toHaveProperty("journalTailSeq");
        }
      }

      producer.close();
      hydrator.close();
    } finally {
      try {
        await stopTestServer(server);
      } finally {
        sendTurn.mockRestore();
      }
    }
  });

  test("thread/read and thread/hydrate retain separate strict validators", async () => {
    const tmpDir = await makeTmpProject();
    const { server, url } = await startAgentServer(serverOpts(tmpDir));
    try {
      const rpc = await connectJsonRpc(url);
      const invalidRequests = [
        { method: "thread/read", params: { threadId: "" } },
        { method: "thread/read", params: { threadId: "thread-1", afterSeq: 0 } },
        { method: "thread/hydrate", params: { threadId: "" } },
        { method: "thread/hydrate", params: { threadId: "thread-1", afterSeq: -1 } },
        { method: "thread/hydrate", params: { threadId: "thread-1", afterSeq: 1.5 } },
        { method: "thread/hydrate", params: { threadId: "thread-1", extra: true } },
      ] as const;
      for (const { method, params } of invalidRequests) {
        const parsed = jsonRpcThreadTurnRequestSchemas[method].safeParse(params);
        expect(parsed.success).toBe(false);
        if (parsed.success) throw new Error("Expected invalid thread params");
        const result = await rpc.sendRequest(method, params).catch((error) => error);
        expect(result.error).toEqual({
          code: -32602,
          message: `${method}: ${parsed.error.issues[0]?.message}`,
        });
      }
      rpc.close();
    } finally {
      await stopTestServer(server);
    }
  });
});
