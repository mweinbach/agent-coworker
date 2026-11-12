import { describe, expect, test } from "bun:test";
import { childAgentReportSchema } from "../../src/shared/agents";
import { connectRustJsonRpc, startRustTestServer } from "../helpers/rustServerHarness";

describe("cowork/session/agent/spawn context schema", () => {
  test("rejects brief mode without a briefing before spawn runs", async () => {
    const srv = await startRustTestServer();
    try {
      const rpc = await connectRustJsonRpc(srv.wsUrl);
      const started = await rpc.request<{ thread: { id: string } }>("thread/start", {
        cwd: srv.workspaceDir,
      });
      const raw = await rpc.requestRaw("cowork/session/agent/spawn", {
        threadId: started.thread.id,
        message: "Plan the change",
        contextMode: "brief",
      });
      expect(raw.error).toBeDefined();
      expect(raw.error?.code).toBe(-32602);
      rpc.close();
    } finally {
      await srv.stop();
    }
  });
});

describe("childAgentReportSchema", () => {
  test("accepts a complete report and rejects blank, extra, or unknown fields", () => {
    expect(
      childAgentReportSchema.parse({
        status: "completed",
        summary: " Done ",
        filesChanged: [" src/a.ts "],
        verification: [{ command: " bun test ", outcome: "passed" }],
      }),
    ).toEqual({
      status: "completed",
      summary: "Done",
      filesChanged: ["src/a.ts"],
      verification: [{ command: "bun test", outcome: "passed" }],
    });

    for (const invalid of [
      { status: "completed", summary: " " },
      { status: "done", summary: "ok" },
      { status: "completed", summary: "ok", extra: true },
      { status: "completed", summary: "ok", filesChanged: [" "] },
    ]) {
      expect(childAgentReportSchema.safeParse(invalid).success).toBe(false);
    }
  });
});
