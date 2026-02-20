import { describe, expect, mock, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { AgentConfig, MCPServerConfig } from "../src/types";
import { runTurnWithDeps } from "../src/agent";
import { loadMCPTools } from "../src/mcp";

function fixturePath(name: string): string {
  return path.join(import.meta.dir, "fixtures", name);
}

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
    projectAgentDir: path.join(baseDir, ".agent"),
    userAgentDir: path.join(baseDir, ".agent"),
    builtInDir: baseDir,
    builtInConfigDir: path.join(baseDir, "config"),
    skillsDirs: [],
    memoryDirs: [],
    configDirs: [configDir],
    enableMcp: true,
  };
}

describe("local MCP integration", () => {
  test("loadMCPTools connects to a local stdio server and executes a real tool", async () => {
    const servers: MCPServerConfig[] = [
      {
        name: "local",
        transport: {
          type: "stdio",
          command: process.execPath,
          args: [fixturePath("mcp-echo-server.mjs")],
        },
        required: true,
        retries: 0,
      },
    ];

    const logs: string[] = [];
    const loaded = await loadMCPTools(servers, { log: (line) => logs.push(line) });
    try {
      expect(loaded.errors).toEqual([]);
      expect(loaded.tools).toHaveProperty("mcp__local__echo");

      const tool = loaded.tools["mcp__local__echo"] as any;
      const result = await tool.execute({ text: "hello" });
      const firstText = result?.content?.find((part: any) => part?.type === "text")?.text;
      expect(firstText).toBe("echo:hello");
      expect(logs.some((line) => line.includes("Connected to local"))).toBe(true);
    } finally {
      await loaded.close();
    }
  });

  test("runTurnWithDeps exposes local MCP tools to streamText", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "agent-local-mcp-"));
    try {
      await fs.writeFile(
        path.join(tmpDir, "mcp-servers.json"),
        JSON.stringify(
          {
            servers: [
              {
                name: "local",
                transport: {
                  type: "stdio",
                  command: process.execPath,
                  args: [fixturePath("mcp-echo-server.mjs")],
                },
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
      const streamText = mock(async (args: any) => {
        const tool = args?.tools?.["mcp__local__echo"];
        expect(tool).toBeDefined();

        const result = await tool.execute({ text: "turn" });
        const firstText = result?.content?.find((part: any) => part?.type === "text")?.text ?? "";

        return {
          text: firstText,
          reasoningText: undefined,
          response: { messages: [] as any[] },
        };
      });

      const response = await runTurnWithDeps(
        {
          config,
          system: "You are helpful.",
          messages: [{ role: "user", content: [{ type: "text", text: "use tools" }] }] as any[],
          log: () => {},
          askUser: async () => "ok",
          approveCommand: async () => true,
          maxSteps: 5,
        },
        {
          streamText: streamText as any,
          stepCountIs: mock((_n: number) => "stop") as any,
          getModel: mock((_cfg: AgentConfig, _id?: string) => "model") as any,
        },
      );

      expect(streamText).toHaveBeenCalledTimes(1);
      expect(response.text).toBe("echo:turn");
      expect(response.responseMessages).toEqual([]);
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });
});
