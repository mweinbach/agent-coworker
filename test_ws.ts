import { startAgentServer } from "./src/server/startServer";

async function main() {
  const dir = "/Users/mweinbach/Desktop/Cowork Test";
  const { server, url } = await startAgentServer({
    cwd: dir,
    yolo: true,
    port: 0
  });

  const ws = new WebSocket(url);
  
  ws.onopen = () => {
    // waiting for server_hello
  };

  ws.onmessage = (event) => {
    const msg = JSON.parse(event.data);
    if (msg.type === "server_hello") {
      ws.send(JSON.stringify({
        type: "user_message",
        sessionId: msg.sessionId,
        text: "research the galaxy s26 series for me what's coming up with it"
      }));
    }
    if (msg.type === "error" || msg.type === "agent_error") {
      console.log("GOT ERROR:", JSON.stringify(msg, null, 2));
      process.exit(1);
    }
    if (msg.type === "agent_started" || msg.type === "agent_chunk" || msg.type === "agent_tool_call") {
      console.log(msg.type);
    }
    if (msg.type === "agent_finished" || msg.type === "agent_stopped") {
      console.log("FINISHED");
      process.exit(0);
    }
  };
}

main();