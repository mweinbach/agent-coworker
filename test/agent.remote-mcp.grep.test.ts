import { describe, expect, test, mock } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { AgentConfig } from "../src/types";
import { runTurnWithDeps } from "../src/agent";

const RUN_REMOTE =
  process.env.RUN_REMOTE_MCP_TESTS === "1" ||
  process.env.RUN_REMOTE_MCP_TESTS === "true" ||
  process.env.RUN_REMOTE_MCP_TESTS === "yes";

const it = RUN_REMOTE ? test : test.skip;

function makeConfig(baseDir: string, configDir: string): AgentConfig {
  return {
    provider: "google",
    model: "gemini-3-flash-preview",
    subAgentModel: "gemini-3-flash-preview",
    workingDirectory: baseDir,
    outputDirectory: path.join(baseDir, "output"),
    uploadsDirectory: path.join(baseDir, "uploads"),
    userName: "tester",
    knowledgeCutoff: "unknown",
    projectAgentDir: baseDir,
    userAgentDir: baseDir,
    builtInDir: baseDir,
    builtInConfigDir: baseDir,
    skillsDirs: [],
    memoryDirs: [],
    configDirs: [configDir],
    enableMcp: true,
  };
}

describe("runTurn + remote MCP (mcp.grep.app)", () => {
  it(
    "loads the remote MCP tools and can execute them via the tools passed to generateText",
    async () => {
      // We don't want to call a real LLM, but we do want to exercise the real
      // MCP loading + tool execution path. Use dependency injection to avoid
      // global module mocks leaking across concurrent test files.
      const mockGenerateText = mock(async (args: any) => {
        const tool = args?.tools?.["mcp__grep__searchGitHub"];
        expect(tool).toBeDefined();

        const res = await tool.execute({
          query: "createMCPClient(",
          language: ["TypeScript", "JavaScript"],
        });

        const firstText = res?.content?.find((c: any) => c?.type === "text")?.text ?? "";

        return {
          text: firstText,
          reasoningText: undefined as string | undefined,
          response: { messages: [] as any[] },
        };
      });

      const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "agent-remote-mcp-"));
      try {
        await fs.writeFile(
          path.join(tmpDir, "mcp-servers.json"),
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
            2
          ),
          "utf-8"
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
            generateText: mockGenerateText as any,
            stepCountIs: mock((_n: number) => "step-count-sentinel") as any,
            getModel: mock((_config: AgentConfig, _id?: string) => "model-sentinel") as any,
            // Keep only MCP tools in the tools map to reduce accidental coupling to built-ins.
            createTools: mock((_ctx: any) => ({})) as any,
          }
        );

        expect(mockGenerateText).toHaveBeenCalledTimes(1);
        expect(typeof res.text).toBe("string");
        expect(res.text.trim().length).toBeGreaterThan(0);
      } finally {
        await fs.rm(tmpDir, { recursive: true, force: true });
      }
    },
    30_000
  );
});
