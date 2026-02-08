import { describe, expect, test, mock, afterAll } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import * as REAL_AI from "ai";
import * as REAL_CONFIG from "../src/config";
import { createTools as REAL_CREATE_TOOLS } from "../src/tools/index";

import type { AgentConfig } from "../src/types";

const RUN_REMOTE =
  process.env.RUN_REMOTE_MCP_TESTS === "1" ||
  process.env.RUN_REMOTE_MCP_TESTS === "true" ||
  process.env.RUN_REMOTE_MCP_TESTS === "yes";

if (!RUN_REMOTE) {
  test.skip("runTurn + remote MCP (mcp.grep.app)", () => {});
} else {
  // -------------------------------------------------------------------------
  // Module mocks: we don't want to call a real LLM, but we do want to exercise
  // the real MCP loading + tool execution path.
  // -------------------------------------------------------------------------

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

  const mockStepCountIs = mock((_n: number) => "step-count-sentinel");

  mock.module("ai", () => ({
    generateText: mockGenerateText,
    stepCountIs: mockStepCountIs,
  }));

  const mockGetModel = mock((_config: AgentConfig, _id?: string) => "model-sentinel");

  mock.module("../src/config", () => ({
    getModel: mockGetModel,
  }));

  const mockCreateTools = mock((_ctx: any) => ({}));

  mock.module("../src/tools", () => ({
    createTools: mockCreateTools,
  }));

  afterAll(() => {
    // Prevent this file's module mocks from leaking into other test files.
    mock.module("ai", () => REAL_AI);
    mock.module("../src/config", () => REAL_CONFIG);
    mock.module("../src/tools", () => ({ createTools: REAL_CREATE_TOOLS }));
    mock.module("../src/tools/index", () => ({ createTools: REAL_CREATE_TOOLS }));
  });

  const { runTurn } = await import("../src/agent");

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
    test(
      "loads the remote MCP tools and can execute them via the tools passed to generateText",
      async () => {
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

          const res = await runTurn({
            config,
            system: "You are a helpful assistant.",
            messages: [{ role: "user", content: [{ type: "text", text: "use the tool" }] }] as any[],
            log: mock(() => {}),
            askUser: mock(async () => "ok"),
            approveCommand: mock(async () => true),
            maxSteps: 5,
          });

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
}
