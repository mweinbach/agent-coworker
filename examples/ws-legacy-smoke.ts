import { startAgentServer } from "../src/server/startServer";

async function main() {
  const { server, url } = await startAgentServer({
    cwd: process.cwd(),
    hostname: "127.0.0.1",
    port: 0,
    env: {
      ...process.env,
      AGENT_WORKING_DIR: process.cwd(),
      COWORK_SKIP_DEFAULT_SKILLS_BOOTSTRAP: process.env.COWORK_SKIP_DEFAULT_SKILLS_BOOTSTRAP ?? "1",
    },
    runTurnImpl: (async () => ({
      text: "legacy smoke ok",
      responseMessages: [],
    })) as any,
  });

  const ws = new WebSocket(url);
  const shutdown = async (code: number) => {
    try {
      ws.close();
    } catch {
      // ignore
    }
    void server.stop();
    process.exit(code);
  };

  ws.onmessage = (event) => {
    const message = JSON.parse(typeof event.data === "string" ? event.data : "");
    console.log(JSON.stringify(message));

    if (message.type === "server_hello") {
      ws.send(JSON.stringify({
        type: "user_message",
        sessionId: message.sessionId,
        text: "reply with exactly: legacy smoke ok",
      }));
      return;
    }

    if (message.type === "assistant_message") {
      void shutdown(0);
    }

    if (message.type === "error") {
      void shutdown(1);
    }
  };

  ws.onerror = () => {
    void shutdown(1);
  };
}

void main();
