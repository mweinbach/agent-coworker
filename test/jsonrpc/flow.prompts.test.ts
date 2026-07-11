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
  test("server-initiated user input requests resolve over JSON-RPC responses", async () => {
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

      await rpc.sendRequest("turn/start", {
        threadId: started.result.thread.id,
        input: [{ type: "text", text: "start ask flow" }],
      });

      const systemEntry = await rpc.waitFor(
        (message) =>
          message.method === "item/completed" &&
          message.params.turnId === null &&
          message.params.item.type === "system",
      );
      const request = await rpc.waitFor(
        (message) => message.method === "item/tool/requestUserInput",
      );
      expect(systemEntry.params.item.line).toBe("question: Pick one");
      expect(request.params.question).toBe("Pick one");
      rpc.sendResponse(request.id, { answer: "b" });

      const resolved = await rpc.waitFor((message) => message.method === "serverRequest/resolved");
      const agentCompleted = await rpc.waitFor(
        (message) =>
          message.method === "item/completed" && message.params.item.type === "agentMessage",
      );
      expect(resolved.params.threadId).toBe(started.result.thread.id);
      expect(agentCompleted.params.item.text).toBe("answer:b");
      rpc.close();
    } finally {
      await stopTestServer(server);
    }
  });

  test("invalid ask responses remain pending and can be retried exactly once", async () => {
    const tmpDir = await makeTmpProject();
    const { server, url } = await startAgentServer(
      serverOpts(tmpDir, {
        runTurnImpl: (async (params: any) => {
          const answer = await params.askUser("Retry me");
          return { text: `answer:${answer}`, responseMessages: [] };
        }) as any,
      }),
    );

    try {
      const rpc = await connectJsonRpc(url);
      const started = await rpc.sendRequest("thread/start", { cwd: tmpDir });
      await rpc.waitFor((message) => message.method === "thread/started");
      await rpc.sendRequest("turn/start", {
        threadId: started.result.thread.id,
        input: [{ type: "text", text: "start retry flow" }],
      });

      const request = await rpc.waitFor(
        (message) => message.method === "item/tool/requestUserInput",
      );
      rpc.sendResponse(request.id, { answer: "   " });
      const replayed = await rpc.waitFor(
        (message) =>
          message.method === "item/tool/requestUserInput" &&
          message.params.requestId === request.params.requestId,
      );
      expect(replayed.id).toBe(request.id);
      await expect(
        rpc.waitFor(
          (message) =>
            message.method === "serverRequest/resolved" &&
            message.params.requestId === request.params.requestId,
          250,
        ),
      ).rejects.toThrow(/Timed out waiting for JSON-RPC message/);

      rpc.sendResponse(request.id, { answer: "valid" });
      const resolved = await rpc.waitFor(
        (message) =>
          message.method === "serverRequest/resolved" &&
          message.params.requestId === request.params.requestId,
      );
      const completed = await rpc.waitFor(
        (message) =>
          message.method === "item/completed" && message.params.item.type === "agentMessage",
      );
      expect(resolved.params.threadId).toBe(started.result.thread.id);
      expect(completed.params.item.text).toBe("answer:valid");
      rpc.close();
    } finally {
      await stopTestServer(server);
    }
  });

  test("server-initiated approval requests resolve over JSON-RPC responses", async () => {
    const tmpDir = await makeTmpProject();
    const { server, url } = await startAgentServer(
      serverOpts(tmpDir, {
        runTurnImpl: (async (params: any) => {
          const approved = await params.approveCommand("rm -rf /tmp/example");
          return {
            text: approved ? "approved" : "denied",
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
        input: [{ type: "text", text: "start approval flow" }],
      });

      const systemEntry = await rpc.waitFor(
        (message) =>
          message.method === "item/completed" &&
          message.params.turnId === null &&
          message.params.item.type === "system",
      );
      const request = await rpc.waitFor(
        (message) => message.method === "item/commandExecution/requestApproval",
      );
      expect(systemEntry.params.item.line).toBe("approval requested: rm -rf /tmp/example");
      expect(request.params.command).toBe("rm -rf /tmp/example");
      rpc.sendResponse(request.id, { decision: "accept" });

      const resolved = await rpc.waitFor((message) => message.method === "serverRequest/resolved");
      const agentCompleted = await rpc.waitFor(
        (message) =>
          message.method === "item/completed" && message.params.item.type === "agentMessage",
      );
      expect(resolved.params.threadId).toBe(started.result.thread.id);
      expect(agentCompleted.params.item.text).toBe("approved");
      rpc.close();
    } finally {
      await stopTestServer(server);
    }
  });

  test("sandbox-denied escalation carries detail + category to the approval request", async () => {
    const tmpDir = await makeTmpProject();
    const { server, url } = await startAgentServer(
      serverOpts(tmpDir, {
        runTurnImpl: (async (params: any) => {
          const approved = await params.approveCommand("curl https://example.com", {
            reason: "sandbox_denied",
            detail: "The OS sandbox blocked network access for this command.",
            category: "network",
          });
          return { text: approved ? "approved" : "denied", responseMessages: [] };
        }) as any,
      }),
    );

    try {
      const rpc = await connectJsonRpc(url);
      const started = await rpc.sendRequest("thread/start", { cwd: tmpDir });
      await rpc.waitFor((message) => message.method === "thread/started");

      await rpc.sendRequest("turn/start", {
        threadId: started.result.thread.id,
        input: [{ type: "text", text: "start sandbox escalation flow" }],
      });

      const request = await rpc.waitFor(
        (message) => message.method === "item/commandExecution/requestApproval",
      );
      expect(request.params.command).toBe("curl https://example.com");
      expect(request.params.dangerous).toBe(true);
      expect(request.params.reason).toBe("sandbox_denied_escalation");
      expect(request.params.detail).toBe("The OS sandbox blocked network access for this command.");
      expect(request.params.category).toBe("network");
      rpc.sendResponse(request.id, { decision: "decline" });

      const agentCompleted = await rpc.waitFor(
        (message) =>
          message.method === "item/completed" && message.params.item.type === "agentMessage",
      );
      expect(agentCompleted.params.item.text).toBe("denied");
      rpc.close();
    } finally {
      await stopTestServer(server);
    }
  });

  test("thread/resume replays a pending user input request after reconnect", async () => {
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

      await rpc.sendRequest("turn/start", {
        threadId: started.result.thread.id,
        input: [{ type: "text", text: "start ask reconnect flow" }],
      });

      const request = await rpc.waitFor(
        (message) => message.method === "item/tool/requestUserInput",
      );
      expect(request.params.question).toBe("Pick one");
      rpc.close();

      const replayRpc = await connectJsonRpc(url);
      const resumeResponse = replayRpc.sendRequest("thread/resume", {
        threadId: started.result.thread.id,
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

      replayRpc.sendResponse(replayedRequest.id, { answer: "b" });
      const resolved = await replayRpc.waitFor(
        (message) => message.method === "serverRequest/resolved",
      );
      const agentCompleted = await replayRpc.waitFor(
        (message) =>
          message.method === "item/completed" && message.params.item.type === "agentMessage",
      );
      expect(resolved.params.threadId).toBe(started.result.thread.id);
      expect(resolved.params.requestId).toBe(request.params.requestId);
      expect(agentCompleted.params.item.text).toBe("answer:b");
      replayRpc.close();
    } finally {
      await stopTestServer(server);
    }
  });

  test("thread/resume replays a pending approval request after reconnect", async () => {
    const tmpDir = await makeTmpProject();
    const { server, url } = await startAgentServer(
      serverOpts(tmpDir, {
        runTurnImpl: (async (params: any) => {
          const approved = await params.approveCommand("rm -rf /tmp/example");
          return {
            text: approved ? "approved" : "denied",
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
        input: [{ type: "text", text: "start approval reconnect flow" }],
      });

      const request = await rpc.waitFor(
        (message) => message.method === "item/commandExecution/requestApproval",
      );
      expect(request.params.command).toBe("rm -rf /tmp/example");
      rpc.close();

      const replayRpc = await connectJsonRpc(url);
      const resumeResponse = replayRpc.sendRequest("thread/resume", {
        threadId: started.result.thread.id,
      });
      const replayedRequest = await replayRpc.waitFor(
        (message) => message.method === "item/commandExecution/requestApproval",
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
            message.method === "item/commandExecution/requestApproval" &&
            message.params.requestId === request.params.requestId,
          250,
        ),
      ).rejects.toThrow(/Timed out waiting for JSON-RPC message/);

      replayRpc.sendResponse(replayedRequest.id, { decision: "accept" });
      const resolved = await replayRpc.waitFor(
        (message) => message.method === "serverRequest/resolved",
      );
      const agentCompleted = await replayRpc.waitFor(
        (message) =>
          message.method === "item/completed" && message.params.item.type === "agentMessage",
      );
      expect(resolved.params.threadId).toBe(started.result.thread.id);
      expect(resolved.params.requestId).toBe(request.params.requestId);
      expect(agentCompleted.params.item.text).toBe("approved");
      replayRpc.close();
    } finally {
      await stopTestServer(server);
    }
  });
});
