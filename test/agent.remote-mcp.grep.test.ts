import { describe, expect, mock, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runTurnWithDeps } from "../src/agent";
import type { RuntimeRunTurnParams, RuntimeRunTurnResult } from "../src/runtime/types";
import type { AgentConfig } from "../src/types";

const RUN_REMOTE =
  process.env.RUN_REMOTE_MCP_AGENT_TESTS === "1" ||
  process.env.RUN_REMOTE_MCP_AGENT_TESTS === "true" ||
  process.env.RUN_REMOTE_MCP_AGENT_TESTS === "yes";

const it = RUN_REMOTE ? test : test.skip;

function makeConfig(baseDir: string, configDir: string): AgentConfig {
  return {
    provider: "google",
    model: "gemini-3-flash-preview",
    preferredChildModel: "gemini-3-flash-preview",
    workingDirectory: baseDir,
    outputDirectory: path.join(baseDir, "output"),
    uploadsDirectory: path.join(baseDir, "uploads"),
    userName: "tester",
    knowledgeCutoff: "unknown",
    projectCoworkDir: path.join(baseDir, ".cowork"),
    userCoworkDir: path.join(baseDir, ".agent-user"),
    builtInDir: baseDir,
    builtInConfigDir: path.join(baseDir, "config"),
    skillsDirs: [],
    memoryDirs: [],
    configDirs: [configDir],
    enableMcp: true,
  };
}

describe("runTurn + remote MCP (mcp.grep.app)", () => {
  it("loads the remote MCP tools and can execute them via the tools passed to the runtime", async () => {
    // We don't want to call a real LLM, but we do want to exercise the real
    // MCP loading + tool execution path. Use dependency injection to avoid
    // global module mocks leaking across concurrent test files.
    const mockRuntimeRunTurn = mock(
      async (args: RuntimeRunTurnParams): Promise<RuntimeRunTurnResult> => {
        const tool = args?.tools?.["mcp__grep__searchGitHub"];
        expect(tool).toBeDefined();

        const res = (await tool.execute({
          query: "createMCPClient(",
          language: ["TypeScript", "JavaScript"],
        })) as { content?: Array<{ type: string; text?: string }> };

        const firstText = res?.content?.find((c: any) => c?.type === "text")?.text ?? "";

        return {
          text: firstText,
          reasoningText: undefined as string | undefined,
          responseMessages: [],
        };
      },
    );

    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "agent-remote-mcp-"));
    try {
      await fs.mkdir(path.join(tmpDir, ".cowork"), { recursive: true });
      await fs.writeFile(
        path.join(tmpDir, ".cowork", "mcp-servers.json"),
        JSON.stringify(
          {
            servers: [
              {
                name: "grep",
                transport: { type: "http", url: "https://mcp.grep.app" },
                required: true,
                retries: 0,
              },
            ],
          },
          null,
          2,
        ),
        "utf-8",
      );

      const config = makeConfig(tmpDir, tmpDir);

      const res = await runTurnWithDeps(
        {
          config,
          system: "You are a helpful assistant.",
          messages: [{ role: "user", content: [{ type: "text", text: "use the tool" }] }] as any[],
          log: mock(() => {}),
          askUser: mock(async () => "ok"),
          approveCommand: mock(async () => true),
          maxSteps: 5,
        },
        {
          createRuntime: () => ({ name: "pi", runTurn: mockRuntimeRunTurn }),
          // Keep only MCP tools in the tools map to reduce accidental coupling to built-ins.
          createTools: mock((_ctx: any) => ({})) as any,
        },
      );

      expect(mockRuntimeRunTurn).toHaveBeenCalledTimes(1);
      expect(typeof res.text).toBe("string");
      expect(res.text.trim().length).toBeGreaterThan(0);
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  }, 30_000);
});
