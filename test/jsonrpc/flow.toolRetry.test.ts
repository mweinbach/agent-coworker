import { describe, expect, test } from "bun:test";

import { type StartAgentServerOptions, startAgentServer } from "../../src/server/startServer";
import { makeTmpProject, serverOpts, stopTestServer } from "../helpers/wsHarness";
import { connectJsonRpc, JSONRPC_REPLAY_TEST_TIMEOUT_MS } from "./flow.harness";

type RunTurnImpl = NonNullable<StartAgentServerOptions["runTurnImpl"]>;

function toolItemsFromSnapshot(snapshot: unknown): Array<Record<string, unknown>> {
  if (!snapshot || typeof snapshot !== "object" || !("feed" in snapshot)) return [];
  const feed = snapshot.feed;
  if (!Array.isArray(feed)) return [];
  return feed.filter(
    (item): item is Record<string, unknown> =>
      typeof item === "object" && item !== null && item.kind === "tool",
  );
}

function userMessagesFromSnapshot(snapshot: unknown): Array<Record<string, unknown>> {
  if (!snapshot || typeof snapshot !== "object" || !("feed" in snapshot)) return [];
  const feed = snapshot.feed;
  if (!Array.isArray(feed)) return [];
  return feed.filter(
    (item): item is Record<string, unknown> =>
      typeof item === "object" && item !== null && item.kind === "message" && item.role === "user",
  );
}

describe("server JSON-RPC explicit tool retries", () => {
  test("confirms exact lineage, scopes reused provider ids, persists restart state, and rolls back for old clients", {
    timeout: JSONRPC_REPLAY_TEST_TIMEOUT_MS,
  }, async () => {
    const tmpDir = await makeTmpProject("agent-harness-tool-retry-");
    let invocation = 0;
    const runTurnImpl: RunTurnImpl = async (params) => {
      invocation += 1;
      await params.onModelStreamPart?.({ type: "start" });
      await params.onModelStreamPart?.({
        type: "tool-call",
        toolCallId: "provider-call-id-reused-across-turns",
        toolName: "bash",
        input: { command: "bun test" },
      });
      if (invocation === 1) {
        await params.onModelStreamPart?.({
          type: "tool-error",
          toolCallId: "provider-call-id-reused-across-turns",
          toolName: "bash",
          error: "tests failed",
        });
      } else {
        await params.onModelStreamPart?.({
          type: "tool-result",
          toolCallId: "provider-call-id-reused-across-turns",
          toolName: "bash",
          output: { ok: true },
        });
      }
      await params.onModelStreamPart?.({ type: "finish", finishReason: "stop" });
      return {
        text: invocation === 1 ? "The tests failed." : "The tests pass.",
        responseMessages: [],
      };
    };

    let threadId = "";
    let failedItemId = "";
    let replacementItemId = "";

    {
      const { server, url } = await startAgentServer(serverOpts(tmpDir, { runTurnImpl }));
      try {
        const rpc = await connectJsonRpc(url, { toolRetryLineage: true });
        expect(rpc.initializeResult).toMatchObject({
          capabilities: {
            toolRetryLineage: true,
          },
        });
        const started = await rpc.sendRequest("thread/start", { cwd: tmpDir });
        threadId = started.result.thread.id;
        await rpc.waitFor((message) => message.method === "thread/started");

        await rpc.sendRequest("turn/start", {
          threadId,
          input: [{ type: "text", text: "Run the tests." }],
        });
        const failed = await rpc.waitFor(
          (message) =>
            message.method === "item/completed" &&
            message.params.item.type === "toolCall" &&
            message.params.item.state === "output-error",
        );
        failedItemId = failed.params.item.id;
        await rpc.waitFor((message) => message.method === "turn/completed");

        const oldClient = await connectJsonRpc(url);
        expect(oldClient.initializeResult).toMatchObject({
          capabilities: {
            experimentalApi: true,
          },
        });
        expect(oldClient.initializeResult).not.toHaveProperty("capabilities.toolRetryLineage");
        await oldClient.sendRequest("thread/resume", { threadId, afterSeq: 999_999 });

        await rpc.sendRequest("turn/start", {
          threadId,
          input: [
            {
              type: "text",
              text: "Continue from where the previous turn stopped. Retry the failed step only if it is still necessary, then finish the user's request.",
            },
          ],
          retry: { toolItemIds: [failedItemId] },
        });
        const replacement = await rpc.waitFor(
          (message) =>
            message.method === "item/completed" &&
            message.params.item.type === "toolCall" &&
            message.params.item.state === "output-available" &&
            message.params.item.retryOf === failedItemId,
        );
        replacementItemId = replacement.params.item.id;
        expect(replacementItemId).not.toBe(failedItemId);
        const legacyReplacement = await oldClient.waitFor(
          (message) =>
            message.method === "item/completed" &&
            message.params.item.type === "toolCall" &&
            message.params.item.id === replacementItemId,
        );
        expect(legacyReplacement.params.item).not.toHaveProperty("retryOf");
        await rpc.waitFor((message) => message.method === "turn/completed");

        const read = await rpc.sendRequest("thread/read", { threadId });
        expect(toolItemsFromSnapshot(read.result.coworkSnapshot)).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ id: failedItemId, state: "output-error" }),
            expect.objectContaining({
              id: replacementItemId,
              state: "output-available",
              retryOf: failedItemId,
            }),
          ]),
        );

        const rollbackRead = await oldClient.sendRequest("thread/read", { threadId });
        expect(
          userMessagesFromSnapshot(rollbackRead.result.coworkSnapshot).map((item) => item.text),
        ).toEqual(["Run the tests."]);
        expect(
          toolItemsFromSnapshot(rollbackRead.result.coworkSnapshot).find(
            (item) => item.id === replacementItemId,
          ),
        ).not.toHaveProperty("retryOf");
        const unsupportedRetry = await oldClient.sendRequest("turn/start", {
          threadId,
          input: [{ type: "text", text: "Retry again." }],
          retry: { toolItemIds: [failedItemId] },
        });
        expect(unsupportedRetry.error?.message).toContain(
          "requires the toolRetryLineage client capability",
        );
        oldClient.close();
        rpc.close();
      } finally {
        await stopTestServer(server);
      }
    }

    const { server, url } = await startAgentServer(serverOpts(tmpDir, { runTurnImpl }));
    try {
      const rpc = await connectJsonRpc(url, { toolRetryLineage: true });
      const read = await rpc.sendRequest("thread/read", { threadId });
      expect(toolItemsFromSnapshot(read.result.coworkSnapshot)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ id: failedItemId, state: "output-error" }),
          expect.objectContaining({
            id: replacementItemId,
            state: "output-available",
            retryOf: failedItemId,
          }),
        ]),
      );
      rpc.close();
    } finally {
      await stopTestServer(server);
    }
  });
});
