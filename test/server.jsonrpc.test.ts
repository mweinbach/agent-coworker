import { describe, expect, test } from "bun:test";
import { WebSocket as NodeWebSocket } from "ws";

import { startAgentServer } from "../src/server/startServer";
import { makeTmpProject, serverOpts, stopTestServer } from "./helpers/wsHarness";

function waitForOpen(ws: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("Timed out waiting for websocket open")),
      5_000,
    );
    ws.onopen = () => {
      clearTimeout(timer);
      resolve();
    };
    ws.onerror = (event) => {
      clearTimeout(timer);
      reject(new Error(`WebSocket error: ${event}`));
    };
  });
}

function waitForNodeWsOpen(ws: NodeWebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("Timed out waiting for websocket open")),
      5_000,
    );
    ws.once("open", () => {
      clearTimeout(timer);
      resolve();
    });
    ws.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

function waitForNodeWsJson(ws: NodeWebSocket): Promise<any> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("Timed out waiting for websocket message")),
      5_000,
    );
    ws.once("message", (data) => {
      clearTimeout(timer);
      resolve(JSON.parse(typeof data === "string" ? data : data.toString("utf8")));
    });
    ws.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

function waitForSingleMessage(ws: WebSocket): Promise<any> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("Timed out waiting for websocket message")),
      5_000,
    );
    ws.onmessage = (event) => {
      clearTimeout(timer);
      resolve(JSON.parse(typeof event.data === "string" ? event.data : ""));
    };
    ws.onerror = (event) => {
      clearTimeout(timer);
      reject(new Error(`WebSocket error: ${event}`));
    };
  });
}

async function expectNoMessage(ws: WebSocket, durationMs = 150): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.onmessage = null;
      resolve();
    }, durationMs);
    ws.onmessage = (event) => {
      clearTimeout(timer);
      reject(
        new Error(
          `Unexpected websocket message: ${typeof event.data === "string" ? event.data : "<binary>"}`,
        ),
      );
    };
    ws.onerror = (event) => {
      clearTimeout(timer);
      reject(new Error(`WebSocket error: ${event}`));
    };
  });
}

describe("server JSON-RPC websocket mode", () => {
  test("jsonrpc is the default websocket protocol", async () => {
    const tmpDir = await makeTmpProject();
    const { server, url } = await startAgentServer(serverOpts(tmpDir));

    try {
      const ws = new WebSocket(url);
      await waitForOpen(ws);
      // JSON-RPC mode requires initialize handshake — no immediate server_hello
      await expectNoMessage(ws);

      ws.send(
        JSON.stringify({
          id: 1,
          method: "thread/list",
          params: {},
        }),
      );
      const notInitialized = await waitForSingleMessage(ws);
      expect(notInitialized.error?.code).toBe(-32002);
      ws.close();
    } finally {
      await stopTestServer(server);
    }
  });

  test("JSON-RPC subprotocol mode requires initialize handshake", async () => {
    const tmpDir = await makeTmpProject();
    const { server, url } = await startAgentServer(serverOpts(tmpDir));

    try {
      const ws = new WebSocket(url, "cowork.jsonrpc.v1");
      await waitForOpen(ws);
      await expectNoMessage(ws);

      ws.send(
        JSON.stringify({
          id: 1,
          method: "thread/list",
          params: {},
        }),
      );
      const notInitialized = await waitForSingleMessage(ws);
      expect(notInitialized).toEqual({
        id: 1,
        error: {
          code: -32002,
          message: "Not initialized",
        },
      });

      ws.send(
        JSON.stringify({
          id: 2,
          method: "initialize",
          params: {
            clientInfo: {
              name: "test-client",
              version: "1.0.0",
            },
          },
        }),
      );
      const initializeResponse = await waitForSingleMessage(ws);
      expect(initializeResponse.id).toBe(2);
      expect(initializeResponse.result.protocolVersion).toBe("0.1");
      expect(initializeResponse.result.transport.protocolMode).toBe("jsonrpc");

      ws.send(JSON.stringify({ method: "initialized" }));
      await expectNoMessage(ws);

      ws.send(
        JSON.stringify({
          id: 3,
          method: "thread/list",
          params: {},
        }),
      );
      const listedThreads = await waitForSingleMessage(ws);
      expect(listedThreads).toEqual({
        id: 3,
        result: {
          threads: [],
        },
      });
      ws.close();
    } finally {
      await stopTestServer(server);
    }
  });

  test("subprotocol JSON-RPC mode initializes without sending an implicit hello", async () => {
    const tmpDir = await makeTmpProject();
    const { server, url } = await startAgentServer(serverOpts(tmpDir));

    try {
      const ws = new WebSocket(url, "cowork.jsonrpc.v1");
      await waitForOpen(ws);
      await expectNoMessage(ws);
      expect(ws.protocol).toBe("cowork.jsonrpc.v1");

      ws.send(
        JSON.stringify({
          id: 1,
          method: "initialize",
          params: {
            clientInfo: {
              name: "subprotocol-client",
            },
          },
        }),
      );
      const response = await waitForSingleMessage(ws);
      expect(response.id).toBe(1);
      expect(response.result.serverInfo.subprotocol).toBe("cowork.jsonrpc.v1");
      ws.close();
    } finally {
      await stopTestServer(server);
    }
  });

  test("multi-offer websocket clients preserve a supported first-offer JSON-RPC subprotocol on the wire", async () => {
    const tmpDir = await makeTmpProject();
    const { server, url } = await startAgentServer(serverOpts(tmpDir));

    try {
      const ws = new NodeWebSocket(url, ["cowork.jsonrpc.v1", "foo"]);
      await waitForNodeWsOpen(ws);
      expect(ws.protocol).toBe("cowork.jsonrpc.v1");

      ws.send(
        JSON.stringify({
          id: 1,
          method: "initialize",
          params: {
            clientInfo: {
              name: "multi-offer-client",
            },
          },
        }),
      );
      const response = await waitForNodeWsJson(ws);
      expect(response.id).toBe(1);
      expect(response.result.serverInfo.subprotocol).toBe("cowork.jsonrpc.v1");
      ws.close();
    } finally {
      await stopTestServer(server);
    }
  });

  test("JSON-RPC returns -32001 when the request queue is overloaded", async () => {
    const tmpDir = await makeTmpProject();
    const { server, url } = await startAgentServer(
      serverOpts(tmpDir, {
        env: {
          AGENT_WORKING_DIR: tmpDir,
          AGENT_PROVIDER: "google",
          COWORK_SKIP_DEFAULT_SKILLS_BOOTSTRAP: "1",
          COWORK_WS_JSONRPC_MAX_PENDING_REQUESTS: "0",
        },
      }),
    );

    try {
      const ws = new WebSocket(url, "cowork.jsonrpc.v1");
      await waitForOpen(ws);
      ws.send(
        JSON.stringify({
          id: 1,
          method: "initialize",
          params: {
            clientInfo: {
              name: "test-client",
            },
          },
        }),
      );
      await waitForSingleMessage(ws);
      ws.send(JSON.stringify({ method: "initialized" }));
      await expectNoMessage(ws);

      ws.send(
        JSON.stringify({
          id: 2,
          method: "thread/list",
          params: {},
        }),
      );
      const overloaded = await waitForSingleMessage(ws);
      expect(overloaded).toEqual({
        id: 2,
        error: {
          code: -32001,
          message: "Server overloaded; retry later.",
        },
      });
      ws.close();
    } finally {
      await stopTestServer(server);
    }
  });

  test("JSON-RPC workspace control routes fall back to the server cwd when params.cwd is omitted", async () => {
    const tmpDir = await makeTmpProject();
    const { server, url } = await startAgentServer(serverOpts(tmpDir));

    try {
      const ws = new WebSocket(url, "cowork.jsonrpc.v1");
      await waitForOpen(ws);
      ws.send(
        JSON.stringify({
          id: 1,
          method: "initialize",
          params: {
            clientInfo: {
              name: "test-client",
            },
          },
        }),
      );
      await waitForSingleMessage(ws);
      ws.send(JSON.stringify({ method: "initialized" }));
      await expectNoMessage(ws);

      ws.send(
        JSON.stringify({
          id: 2,
          method: "cowork/provider/status/refresh",
          params: {},
        }),
      );
      const response = await waitForSingleMessage(ws);
      expect(response.id).toBe(2);
      expect(response.result?.event?.type).toBe("provider_status");
      expect(Array.isArray(response.result?.event?.providers)).toBe(true);
      ws.close();
    } finally {
      await stopTestServer(server);
    }
  });
});
