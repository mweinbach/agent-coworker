import { describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { startAgentServer, type StartAgentServerOptions } from "../src/server/startServer";

/** Create an isolated temp directory that mimics a valid project for the agent. */
async function makeTmpProject(): Promise<string> {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "agent-toolstream-test-"));
  await fs.mkdir(path.join(tmp, ".agent"), { recursive: true });
  return tmp;
}

/**
 * Helper: open a WebSocket, wait for server_hello, send a user message,
 * then collect ALL events (including model_stream_chunk) until a
 * session_busy { busy: false } is received or timeout fires.
 *
 * Unlike the `sendAndCollect` in server.test.ts, this does NOT filter out
 * model_stream_chunk events -- we need them for assertions.
 */
function sendAndCollectAll(
  url: string,
  text: string,
  timeoutMs = 30_000
): Promise<{ hello: any; sessionId: string; events: any[] }> {
  return new Promise((resolve, reject) => {
    const events: any[] = [];
    let hello: any = null;
    let sessionId = "";
    let sent = false;
    let settled = false;
    const ws = new WebSocket(url);

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      ws.close();
      const types = events.map((e) => e.type).join(", ");
      reject(new Error(`Timed out after ${timeoutMs}ms. Collected ${events.length} events: [${types}]`));
    }, timeoutMs);

    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      ws.close();
      resolve({ hello, sessionId, events });
    };

    ws.onmessage = (e) => {
      const msg = JSON.parse(typeof e.data === "string" ? e.data : "");

      // Capture server_hello and extract sessionId, then send user message
      if (!hello && msg.type === "server_hello") {
        hello = msg;
        sessionId = msg.sessionId;
        if (!sent) {
          sent = true;
          ws.send(JSON.stringify({ type: "user_message", sessionId, text }));
        }
        return;
      }

      // Skip initial handshake events that arrive before we send the message
      if (
        !sent ||
        msg.type === "session_settings" ||
        msg.type === "session_info" ||
        msg.type === "observability_status" ||
        msg.type === "provider_catalog" ||
        msg.type === "provider_auth_methods" ||
        msg.type === "provider_status" ||
        msg.type === "session_backup_state"
      ) {
        return;
      }

      events.push(msg);

      // Once we see session_busy { busy: false }, the turn is done -- give a
      // small window for trailing events (e.g. turn_usage) then resolve.
      if (msg.type === "session_busy" && msg.busy === false) {
        setTimeout(finish, 100);
      }
    };

    ws.onerror = (e) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      ws.close();
      reject(new Error(`WebSocket error: ${e}`));
    };
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Tool loop stream events arrive over WebSocket", () => {
  test("multi-step tool loop emits correct model_stream_chunk events in order", async () => {
    const tmpDir = await makeTmpProject();

    const runTurnImpl = async (params: any) => {
      const emit = params.onModelStreamPart;
      await emit?.({ type: "start" });
      await emit?.({ type: "start-step", stepNumber: 0 });
      await emit?.({ type: "tool-call", toolCallId: "tc1", toolName: "bash", input: { command: "ls" } });
      await emit?.({ type: "tool-result", toolCallId: "tc1", toolName: "bash", output: "file.txt\nREADME.md" });
      await emit?.({ type: "finish-step", stepNumber: 0, finishReason: "tool-calls" });
      await emit?.({ type: "start-step", stepNumber: 1 });
      await emit?.({ type: "text-delta", id: "t1", text: "Found 2 files." });
      await emit?.({ type: "finish-step", stepNumber: 1, finishReason: "stop" });
      await emit?.({ type: "finish", finishReason: "stop" });
      return {
        text: "Found 2 files.",
        reasoningText: undefined,
        responseMessages: [],
      };
    };

    const { server, url } = await startAgentServer({
      cwd: tmpDir,
      hostname: "127.0.0.1",
      port: 0,
      homedir: tmpDir,
      env: { AGENT_WORKING_DIR: tmpDir, AGENT_PROVIDER: "google" },
      runTurnImpl: runTurnImpl as any,
    });

    try {
      const { sessionId, events } = await sendAndCollectAll(url, "list files please");

      // Extract model_stream_chunk events
      const chunks = events.filter((e) => e.type === "model_stream_chunk");

      // All 9 model_stream_chunk events should arrive
      expect(chunks.length).toBe(9);

      // partType values in the expected order
      const expectedPartTypes = [
        "start",
        "start_step",
        "tool_call",
        "tool_result",
        "finish_step",
        "start_step",
        "text_delta",
        "finish_step",
        "finish",
      ];
      expect(chunks.map((c: any) => c.partType)).toEqual(expectedPartTypes);

      // index values are sequential 0..8
      expect(chunks.map((c: any) => c.index)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8]);

      // All share the same turnId
      const turnIds = new Set(chunks.map((c: any) => c.turnId));
      expect(turnIds.size).toBe(1);
      const turnId = chunks[0].turnId;
      expect(typeof turnId).toBe("string");
      expect(turnId.length).toBeGreaterThan(0);

      // All share the same sessionId
      const chunkSessionIds = new Set(chunks.map((c: any) => c.sessionId));
      expect(chunkSessionIds.size).toBe(1);
      expect(chunks[0].sessionId).toBe(sessionId);

      // session_busy events bracket the turn (busy=true before chunks, busy=false after)
      const busyTrueIdx = events.findIndex(
        (e) => e.type === "session_busy" && e.busy === true
      );
      const busyFalseIdx = events.findIndex(
        (e) => e.type === "session_busy" && e.busy === false
      );
      const firstChunkIdx = events.findIndex((e) => e.type === "model_stream_chunk");
      const lastChunkIdx = events.length - 1 - [...events].reverse().findIndex((e) => e.type === "model_stream_chunk");

      expect(busyTrueIdx).toBeGreaterThanOrEqual(0);
      expect(busyFalseIdx).toBeGreaterThan(busyTrueIdx);
      expect(firstChunkIdx).toBeGreaterThan(busyTrueIdx);
      expect(busyFalseIdx).toBeGreaterThan(lastChunkIdx);

      // assistant_message arrives after all model_stream_chunk events
      const assistantIdx = events.findIndex((e) => e.type === "assistant_message");
      expect(assistantIdx).toBeGreaterThan(lastChunkIdx);

      // Verify assistant_message content
      const assistantMsg = events.find((e) => e.type === "assistant_message");
      expect(assistantMsg).toBeDefined();
      expect(assistantMsg.text).toBe("Found 2 files.");
    } finally {
      server.stop();
    }
  }, 30_000);
});

describe("Error part delivered over WebSocket", () => {
  test("error stream part is delivered as model_stream_chunk with partType error", async () => {
    const tmpDir = await makeTmpProject();

    const runTurnImpl = async (params: any) => {
      const emit = params.onModelStreamPart;
      await emit?.({ type: "start" });
      await emit?.({ type: "error", error: "Rate limit exceeded" });
      await emit?.({ type: "finish", finishReason: "error" });
      return {
        text: "",
        reasoningText: undefined,
        responseMessages: [],
      };
    };

    const { server, url } = await startAgentServer({
      cwd: tmpDir,
      hostname: "127.0.0.1",
      port: 0,
      homedir: tmpDir,
      env: { AGENT_WORKING_DIR: tmpDir, AGENT_PROVIDER: "google" },
      runTurnImpl: runTurnImpl as any,
    });

    try {
      const { events } = await sendAndCollectAll(url, "trigger error");

      // Extract model_stream_chunk events
      const chunks = events.filter((e) => e.type === "model_stream_chunk");

      // All three chunks arrive
      expect(chunks.length).toBe(3);

      // Correct partType values including "error"
      expect(chunks.map((c: any) => c.partType)).toEqual(["start", "error", "finish"]);

      // Sequential index values
      expect(chunks.map((c: any) => c.index)).toEqual([0, 1, 2]);

      // The error chunk carries the error message in part
      const errorChunk = chunks.find((c: any) => c.partType === "error");
      expect(errorChunk).toBeDefined();
      expect(errorChunk.part.error).toBe("Rate limit exceeded");
    } finally {
      server.stop();
    }
  }, 30_000);
});

describe("Usage event after tool loop", () => {
  test("turn_usage event is emitted with correct usage numbers", async () => {
    const tmpDir = await makeTmpProject();

    const runTurnImpl = async (params: any) => {
      const emit = params.onModelStreamPart;
      await emit?.({ type: "start" });
      await emit?.({ type: "text-delta", id: "t1", text: "Hello" });
      await emit?.({ type: "finish", finishReason: "stop" });
      return {
        text: "Hello",
        reasoningText: undefined,
        responseMessages: [],
        usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
      };
    };

    const { server, url } = await startAgentServer({
      cwd: tmpDir,
      hostname: "127.0.0.1",
      port: 0,
      homedir: tmpDir,
      env: { AGENT_WORKING_DIR: tmpDir, AGENT_PROVIDER: "google" },
      runTurnImpl: runTurnImpl as any,
    });

    try {
      const { events } = await sendAndCollectAll(url, "say hello");

      // Find the turn_usage event
      const usageEvents = events.filter((e) => e.type === "turn_usage");
      expect(usageEvents.length).toBe(1);

      const usage = usageEvents[0];
      expect(usage.usage.promptTokens).toBe(100);
      expect(usage.usage.completionTokens).toBe(50);
      expect(usage.usage.totalTokens).toBe(150);

      // turn_usage should share the same turnId as the stream chunks
      const chunks = events.filter((e) => e.type === "model_stream_chunk");
      expect(chunks.length).toBeGreaterThan(0);
      expect(usage.turnId).toBe(chunks[0].turnId);

      // turn_usage should arrive after the turn completes (after assistant_message)
      const assistantIdx = events.findIndex((e) => e.type === "assistant_message");
      const usageIdx = events.findIndex((e) => e.type === "turn_usage");
      expect(usageIdx).toBeGreaterThan(assistantIdx);
    } finally {
      server.stop();
    }
  }, 30_000);
});
