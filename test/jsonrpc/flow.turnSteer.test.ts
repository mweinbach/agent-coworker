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

async function expectStillPending(promise: Promise<unknown>, label: string): Promise<void> {
  let settled = false;
  promise.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  await new Promise((resolve) => setTimeout(resolve, 25));
  if (settled) throw new Error(`${label} settled before its correlated event`);
}

describe("server JSON-RPC flows", () => {
  test("turn/start rejects at the request layer when the thread is already running", {
    timeout: JSONRPC_REPLAY_TEST_TIMEOUT_MS,
  }, async () => {
    const tmpDir = await makeTmpProject();
    const releaseTurn = Promise.withResolvers<void>();
    const { server, url } = await startAgentServer(
      serverOpts(tmpDir, {
        runTurnImpl: (async () => {
          await releaseTurn.promise;
          return {
            text: "done",
            responseMessages: [],
          };
        }) as any,
      }),
    );

    try {
      const rpc = await connectJsonRpc(url);
      const started = await rpc.sendRequest("thread/start", { cwd: tmpDir });
      await rpc.waitFor((message) => message.method === "thread/started");

      const firstTurn = await rpc.sendRequest("turn/start", {
        threadId: started.result.thread.id,
        input: [{ type: "text", text: "first turn" }],
      });
      expect(firstTurn.result.turn.status).toBe("inProgress");

      const secondTurn = await rpc.sendRequest("turn/start", {
        threadId: started.result.thread.id,
        input: [{ type: "text", text: "second turn" }],
      });
      expect(secondTurn.error?.message).toBe("Agent is busy");
      expect(secondTurn.result).toBeUndefined();

      releaseTurn.resolve();
      await rpc.waitFor((message) => message.method === "turn/completed");
      rpc.close();
    } finally {
      await stopTestServer(server);
    }
  });

  test("turn/steer returns the accepted turn id once steering is actually accepted", {
    timeout: JSONRPC_REPLAY_TEST_TIMEOUT_MS,
  }, async () => {
    const tmpDir = await makeTmpProject();
    const releaseTurn = Promise.withResolvers<void>();
    const { server, url } = await startAgentServer(
      serverOpts(tmpDir, {
        runTurnImpl: (async () => {
          await releaseTurn.promise;
          return {
            text: "done",
            responseMessages: [],
          };
        }) as any,
      }),
    );

    try {
      const rpc = await connectJsonRpc(url);
      const started = await rpc.sendRequest("thread/start", { cwd: tmpDir });
      await rpc.waitFor((message) => message.method === "thread/started");

      const turnStart = await rpc.sendRequest("turn/start", {
        threadId: started.result.thread.id,
        input: [{ type: "text", text: "start turn" }],
      });
      const turnId = turnStart.result.turn.id;

      const steerResponse = await rpc.sendRequest("turn/steer", {
        threadId: started.result.thread.id,
        turnId,
        input: [{ type: "text", text: "keep going" }],
        clientMessageId: "steer-1",
      });
      expect(steerResponse.result.turnId).toBe(turnId);

      const steerAccepted = await rpc.waitFor(
        (message) => message.method === "cowork/session/steerAccepted",
      );
      expect(steerAccepted.params.turnId).toBe(turnId);
      expect(steerAccepted.params.clientMessageId).toBe("steer-1");

      releaseTurn.resolve();
      await rpc.waitFor((message) => message.method === "turn/completed");
      rpc.close();
    } finally {
      await stopTestServer(server);
    }
  });

  test("turn/steer replays one accepted steer after the original response is lost", {
    timeout: JSONRPC_REPLAY_TEST_TIMEOUT_MS,
  }, async () => {
    const tmpDir = await makeTmpProject();
    const releaseTurn = Promise.withResolvers<void>();
    let runTurnCalls = 0;
    let latestMessages: Array<{ role: string; content: unknown }> = [];
    const { server, url } = await startAgentServer(
      serverOpts(tmpDir, {
        runTurnImpl: (async (params: { messages: Array<{ role: string; content: unknown }> }) => {
          runTurnCalls += 1;
          latestMessages = params.messages;
          if (runTurnCalls === 1) await releaseTurn.promise;
          return {
            text: "done",
            responseMessages: [],
          };
        }) as never,
      }),
    );

    try {
      const firstRpc = await connectJsonRpc(url);
      const started = await firstRpc.sendRequest("thread/start", { cwd: tmpDir });
      await firstRpc.waitFor((message) => message.method === "thread/started");
      const threadId = started.result.thread.id;
      const turnStart = await firstRpc.sendRequest("turn/start", {
        threadId,
        input: [{ type: "text", text: "start turn" }],
      });
      const turnId = turnStart.result.turn.id;
      const steerParams = {
        threadId,
        turnId,
        input: [{ type: "text", text: "keep going exactly once" }],
        clientMessageId: "lost-response-steer",
      };

      firstRpc.ws.send(
        JSON.stringify({
          id: "discarded-response",
          method: "turn/steer",
          params: steerParams,
        }),
      );
      const accepted = await firstRpc.waitFor(
        (message) =>
          message.method === "cowork/session/steerAccepted" &&
          message.params.clientMessageId === steerParams.clientMessageId,
      );
      expect(accepted.params.steerRequestId).toBeString();
      firstRpc.close();

      const retryRpc = await connectJsonRpc(url);
      await retryRpc.sendRequest("thread/resume", { threadId });
      const replay = await retryRpc.sendRequest("turn/steer", steerParams);
      expect(replay.result).toEqual({
        turnId,
        steerRequestId: accepted.params.steerRequestId,
        replayed: true,
      });

      const conflict = await retryRpc.sendRequest("turn/steer", {
        ...steerParams,
        input: [{ type: "text", text: "different payload" }],
      });
      expect(conflict.error?.message).toContain("clientMessageId conflict");

      releaseTurn.resolve();
      await retryRpc.waitFor((message) => message.method === "turn/completed");
      expect(runTurnCalls).toBe(2);
      expect(
        latestMessages.filter(
          (message) => message.role === "user" && message.content === "keep going exactly once",
        ),
      ).toHaveLength(1);
      retryRpc.close();
    } finally {
      releaseTurn.resolve();
      await stopTestServer(server);
    }
  });

  test("turn/steer correlates concurrent live ACKs to the originating request", {
    timeout: JSONRPC_REPLAY_TEST_TIMEOUT_MS,
  }, async () => {
    const tmpDir = await makeTmpProject();
    const handlerReady = Promise.withResolvers<void>();
    const releaseTurn = Promise.withResolvers<void>();
    const aEntered = Promise.withResolvers<void>();
    const releaseA = Promise.withResolvers<void>();
    const { server, url } = await startAgentServer(
      serverOpts(tmpDir, {
        runTurnImpl: (async (params: any) => {
          const unregister = params.registerSteerHandler?.(async (steer: any) => {
            if (steer.text === "A") {
              aEntered.resolve();
              await releaseA.promise;
              return;
            }
            if (steer.text === "B") {
              return;
            }
            throw new Error(`unexpected steer ${steer.text}`);
          });
          handlerReady.resolve();
          await releaseTurn.promise;
          unregister?.();
          return {
            text: "done",
            responseMessages: [],
          };
        }) as any,
      }),
    );

    try {
      const rpc = await connectJsonRpc(url);
      const started = await rpc.sendRequest("thread/start", { cwd: tmpDir });
      await rpc.waitFor((message) => message.method === "thread/started");
      const turnStart = await rpc.sendRequest("turn/start", {
        threadId: started.result.thread.id,
        input: [{ type: "text", text: "start turn" }],
      });
      const turnId = turnStart.result.turn.id;
      await handlerReady.promise;

      const aResponse = rpc.sendRequest("turn/steer", {
        threadId: started.result.thread.id,
        turnId,
        input: [{ type: "text", text: "A" }],
        clientMessageId: "client-A",
      });
      await aEntered.promise;

      const bResponse = await rpc.sendRequest("turn/steer", {
        threadId: started.result.thread.id,
        turnId,
        input: [{ type: "text", text: "B" }],
        clientMessageId: "client-B",
      });
      expect(bResponse.result?.turnId).toBe(turnId);
      await expectStillPending(aResponse, "steer A");

      releaseA.resolve();
      const resolvedA = await aResponse;
      expect(resolvedA.result?.turnId).toBe(turnId);

      releaseTurn.resolve();
      await rpc.waitFor((message) => message.method === "turn/completed");
      rpc.close();
    } finally {
      releaseA.resolve();
      releaseTurn.resolve();
      await stopTestServer(server);
    }
  });

  test("turn/steer correlates omitted-clientMessageId errors without rejecting sibling requests", {
    timeout: JSONRPC_REPLAY_TEST_TIMEOUT_MS,
  }, async () => {
    const tmpDir = await makeTmpProject();
    const handlerReady = Promise.withResolvers<void>();
    const releaseTurn = Promise.withResolvers<void>();
    const bEntered = Promise.withResolvers<void>();
    const releaseB = Promise.withResolvers<void>();
    const { server, url } = await startAgentServer(
      serverOpts(tmpDir, {
        runTurnImpl: (async (params: any) => {
          const unregister = params.registerSteerHandler?.(async (steer: any) => {
            if (steer.text === "B") {
              bEntered.resolve();
              await releaseB.promise;
              return;
            }
            if (steer.text === "A") {
              throw new Error("A provider failed");
            }
            throw new Error(`unexpected steer ${steer.text}`);
          });
          handlerReady.resolve();
          await releaseTurn.promise;
          unregister?.();
          return {
            text: "done",
            responseMessages: [],
          };
        }) as any,
      }),
    );

    try {
      const rpc = await connectJsonRpc(url);
      const started = await rpc.sendRequest("thread/start", { cwd: tmpDir });
      await rpc.waitFor((message) => message.method === "thread/started");
      const turnStart = await rpc.sendRequest("turn/start", {
        threadId: started.result.thread.id,
        input: [{ type: "text", text: "start turn" }],
      });
      const turnId = turnStart.result.turn.id;
      await handlerReady.promise;

      const bResponse = rpc.sendRequest("turn/steer", {
        threadId: started.result.thread.id,
        turnId,
        input: [{ type: "text", text: "B" }],
      });
      await bEntered.promise;

      const aResponse = await rpc.sendRequest("turn/steer", {
        threadId: started.result.thread.id,
        turnId,
        input: [{ type: "text", text: "A" }],
      });
      expect(aResponse.error?.message).toContain("A provider failed");
      await expectStillPending(bResponse, "steer B");

      releaseB.resolve();
      const resolvedB = await bResponse;
      expect(resolvedB.result?.turnId).toBe(turnId);

      releaseTurn.resolve();
      await rpc.waitFor((message) => message.method === "turn/completed");
      rpc.close();
    } finally {
      releaseB.resolve();
      releaseTurn.resolve();
      await stopTestServer(server);
    }
  });

  test("turn/steer accepts legacy inputText parts", {
    timeout: JSONRPC_REPLAY_TEST_TIMEOUT_MS,
  }, async () => {
    const tmpDir = await makeTmpProject();
    const releaseTurn = Promise.withResolvers<void>();
    const { server, url } = await startAgentServer(
      serverOpts(tmpDir, {
        runTurnImpl: (async () => {
          await releaseTurn.promise;
          return {
            text: "done",
            responseMessages: [],
          };
        }) as any,
      }),
    );

    try {
      const rpc = await connectJsonRpc(url);
      const started = await rpc.sendRequest("thread/start", { cwd: tmpDir });
      await rpc.waitFor((message) => message.method === "thread/started");

      const turnStart = await rpc.sendRequest("turn/start", {
        threadId: started.result.thread.id,
        input: [{ type: "text", text: "start turn" }],
      });
      const turnId = turnStart.result.turn.id;

      const steerResponse = await rpc.sendRequest("turn/steer", {
        threadId: started.result.thread.id,
        turnId,
        input: [{ type: "inputText", text: "keep going" }],
        clientMessageId: "steer-legacy-1",
      });
      expect(steerResponse.result.turnId).toBe(turnId);

      const steerAccepted = await rpc.waitFor(
        (message) => message.method === "cowork/session/steerAccepted",
      );
      expect(steerAccepted.params.turnId).toBe(turnId);
      expect(steerAccepted.params.clientMessageId).toBe("steer-legacy-1");

      releaseTurn.resolve();
      await rpc.waitFor((message) => message.method === "turn/completed");
      rpc.close();
    } finally {
      await stopTestServer(server);
    }
  });

  test("turn/steer falls back to the active turn when turnId is omitted", {
    timeout: JSONRPC_REPLAY_TEST_TIMEOUT_MS,
  }, async () => {
    const tmpDir = await makeTmpProject();
    const releaseTurn = Promise.withResolvers<void>();
    const { server, url } = await startAgentServer(
      serverOpts(tmpDir, {
        runTurnImpl: (async () => {
          await releaseTurn.promise;
          return {
            text: "done",
            responseMessages: [],
          };
        }) as any,
      }),
    );

    try {
      const rpc = await connectJsonRpc(url);
      const started = await rpc.sendRequest("thread/start", { cwd: tmpDir });
      await rpc.waitFor((message) => message.method === "thread/started");

      const turnStart = await rpc.sendRequest("turn/start", {
        threadId: started.result.thread.id,
        input: [{ type: "text", text: "start turn" }],
      });
      const turnId = turnStart.result.turn.id;

      const steerResponse = await rpc.sendRequest("turn/steer", {
        threadId: started.result.thread.id,
        input: [{ type: "text", text: "keep going without explicit turn id" }],
        clientMessageId: "steer-without-turn-id",
      });
      expect(steerResponse.result.turnId).toBe(turnId);

      const steerAccepted = await rpc.waitFor(
        (message) => message.method === "cowork/session/steerAccepted",
      );
      expect(steerAccepted.params.turnId).toBe(turnId);
      expect(steerAccepted.params.clientMessageId).toBe("steer-without-turn-id");

      releaseTurn.resolve();
      await rpc.waitFor((message) => message.method === "turn/completed");
      rpc.close();
    } finally {
      await stopTestServer(server);
    }
  });

  test("turn/start preserves ordered mixed text and file input parts", {
    timeout: JSONRPC_REPLAY_TEST_TIMEOUT_MS,
  }, async () => {
    const tmpDir = await makeTmpProject();
    const realTmpDir = await fs.realpath(tmpDir);
    let capturedMessages: any[] = [];
    const { server, url } = await startAgentServer(
      serverOpts(tmpDir, {
        runTurnImpl: (async (params: any) => {
          capturedMessages = params.messages;
          return {
            text: "done",
            responseMessages: [],
          };
        }) as any,
      }),
    );

    try {
      const rpc = await connectJsonRpc(url);
      const started = await rpc.sendRequest("thread/start", { cwd: tmpDir });
      await rpc.waitFor((message) => message.method === "thread/started");

      const turnStart = await rpc.sendRequest("turn/start", {
        threadId: started.result.thread.id,
        input: [
          { type: "text", text: "first caption" },
          { type: "file", filename: "one.png", contentBase64: "b25l", mimeType: "image/png" },
          { type: "text", text: "second caption" },
          { type: "file", filename: "two.png", contentBase64: "dHdv", mimeType: "image/png" },
        ],
      });
      expect(turnStart.result.turn.status).toBe("inProgress");
      await rpc.waitFor((message) => message.method === "turn/completed");

      expect(capturedMessages.at(-1)?.content).toEqual([
        { type: "text", text: "first caption" },
        {
          type: "text",
          text: `[System: The user uploaded a file which has been saved to ${path.join(realTmpDir, "User Uploads", "one.png")}]`,
        },
        { type: "image", data: "b25l", mimeType: "image/png" },
        { type: "text", text: "second caption" },
        {
          type: "text",
          text: `[System: The user uploaded a file which has been saved to ${path.join(realTmpDir, "User Uploads", "two.png")}]`,
        },
        { type: "image", data: "dHdv", mimeType: "image/png" },
      ]);

      rpc.close();
    } finally {
      await stopTestServer(server);
    }
  });

  test("turn/steer rejects at the request layer when the requested turn is no longer active", {
    timeout: JSONRPC_REPLAY_TEST_TIMEOUT_MS,
  }, async () => {
    const tmpDir = await makeTmpProject();
    const releaseTurn = Promise.withResolvers<void>();
    const { server, url } = await startAgentServer(
      serverOpts(tmpDir, {
        runTurnImpl: (async () => {
          await releaseTurn.promise;
          return {
            text: "done",
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
        input: [{ type: "text", text: "start turn" }],
      });

      const steerResponse = await rpc.sendRequest("turn/steer", {
        threadId: started.result.thread.id,
        turnId: "turn-stale",
        input: [{ type: "text", text: "wrong turn" }],
      });
      expect(steerResponse.error?.message).toBe("Active turn mismatch.");
      expect(steerResponse.result).toBeUndefined();

      releaseTurn.resolve();
      await rpc.waitFor((message) => message.method === "turn/completed");
      rpc.close();
    } finally {
      await stopTestServer(server);
    }
  });

  test("turn/steer rejects too many attachment parts at the request layer", {
    timeout: JSONRPC_REPLAY_TEST_TIMEOUT_MS,
  }, async () => {
    const tmpDir = await makeTmpProject();
    const releaseTurn = Promise.withResolvers<void>();
    const { server, url } = await startAgentServer(
      serverOpts(tmpDir, {
        runTurnImpl: (async () => {
          await releaseTurn.promise;
          return {
            text: "done",
            responseMessages: [],
          };
        }) as any,
      }),
    );

    try {
      const rpc = await connectJsonRpc(url);
      const started = await rpc.sendRequest("thread/start", { cwd: tmpDir });
      await rpc.waitFor((message) => message.method === "thread/started");

      const turnStart = await rpc.sendRequest("turn/start", {
        threadId: started.result.thread.id,
        input: [{ type: "text", text: "start turn" }],
      });
      const turnId = turnStart.result.turn.id;

      const steerResponse = await rpc.sendRequest("turn/steer", {
        threadId: started.result.thread.id,
        turnId,
        input: Array.from({ length: MAX_TURN_ATTACHMENT_COUNT + 1 }, (_, index) => ({
          type: "file" as const,
          filename: `file-${index}.txt`,
          contentBase64: "YQ==",
          mimeType: "text/plain",
        })),
      });
      expect(steerResponse.error?.code).toBe(-32602);
      expect(steerResponse.error?.message).toContain(
        `Too many file attachments (max ${MAX_TURN_ATTACHMENT_COUNT})`,
      );
      expect(steerResponse.result).toBeUndefined();

      releaseTurn.resolve();
      await rpc.waitFor((message) => message.method === "turn/completed");
      rpc.close();
    } finally {
      await stopTestServer(server);
    }
  });

  test("turn/steer rejects invalid uploaded file paths without aborting the active turn", {
    timeout: JSONRPC_REPLAY_TEST_TIMEOUT_MS,
  }, async () => {
    const tmpDir = await makeTmpProject();
    const releaseTurn = Promise.withResolvers<void>();
    const { server, url } = await startAgentServer(
      serverOpts(tmpDir, {
        runTurnImpl: (async () => {
          await releaseTurn.promise;
          return {
            text: "done",
            responseMessages: [],
          };
        }) as any,
      }),
    );

    try {
      const rpc = await connectJsonRpc(url);
      const started = await rpc.sendRequest("thread/start", { cwd: tmpDir });
      await rpc.waitFor((message) => message.method === "thread/started");

      const turnStart = await rpc.sendRequest("turn/start", {
        threadId: started.result.thread.id,
        input: [{ type: "text", text: "start turn" }],
      });
      const turnId = turnStart.result.turn.id;

      const steerResponse = await rpc.sendRequest("turn/steer", {
        threadId: started.result.thread.id,
        turnId,
        input: [
          {
            type: "uploadedFile",
            filename: "outside.txt",
            path: `${tmpDir}/outside.txt`,
            mimeType: "text/plain",
          },
        ],
        clientMessageId: "steer-invalid-upload",
      });

      expect(steerResponse.error?.message).toBe(
        "Uploaded file path is outside the uploads directory.",
      );
      expect(steerResponse.result).toBeUndefined();

      releaseTurn.resolve();
      await rpc.waitFor((message) => message.method === "turn/completed");
      rpc.close();
    } finally {
      await stopTestServer(server);
    }
  });
});
