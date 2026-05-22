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

    try {
      const producer = await connectJsonRpc(url);
      const started = await producer.sendRequest("thread/start", { cwd: tmpDir });
      await producer.waitFor((message) => message.method === "thread/started");
      await producer.sendRequest("turn/start", {
        threadId: started.result.thread.id,
        input: [{ type: "text", text: "first input" }],
      });
      await producer.waitFor((message) => message.method === "turn/completed");

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

      // Producer starts a second turn. Hydrator must not receive any live events.
      await producer.sendRequest("turn/start", {
        threadId: started.result.thread.id,
        input: [{ type: "text", text: "second input" }],
      });
      await producer.waitFor((message) => message.method === "turn/completed");
      await expect(
        hydrator.waitFor((message) => message.method === "turn/started", 500),
      ).rejects.toThrow(/Timed out waiting for JSON-RPC message/);

      // afterSeq cursor advances — second hydrate with previous tail returns no turns.
      const hydrateAgain = await hydrator.sendRequest("thread/hydrate", {
        threadId: started.result.thread.id,
        afterSeq: hydrate.result.journalTailSeq,
        includeTurns: true,
      });
      expect(hydrateAgain.result.journalTailSeq).toBeGreaterThan(hydrate.result.journalTailSeq);

      producer.close();
      hydrator.close();
    } finally {
      await stopTestServer(server);
    }
  });

  test("thread/hydrate rejects invalid params via zod", async () => {
    const tmpDir = await makeTmpProject();
    const { server, url } = await startAgentServer(serverOpts(tmpDir));
    try {
      const rpc = await connectJsonRpc(url);
      const result = await rpc
        .sendRequest("thread/hydrate", {
          threadId: "",
        })
        .catch((err) => err);
      expect(result?.error?.code).toBe(-32602);
      rpc.close();
    } finally {
      await stopTestServer(server);
    }
  });
});
