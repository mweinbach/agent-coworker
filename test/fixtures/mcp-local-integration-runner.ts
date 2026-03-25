import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

import type { AgentConfig, MCPServerConfig } from "../../src/types";
import { runTurnWithDeps } from "../../src/agent";
import { loadMCPTools } from "../../src/mcp";

type RunnerResult =
  | {
      scenario: "load-tools";
      logs: string[];
      toolNames: string[];
      resultText: string;
      annotations: Record<string, unknown> | null;
    }
  | {
      scenario: "run-turn";
      responseText: string;
      responseMessagesLength: number;
      streamTextCalls: number;
    };

function fixturePath(name: string): string {
  return path.join(import.meta.dir, name);
}

function resolveNodeCommand(): string {
  const candidates = [
    process.execPath,
    "/opt/zerobrew/prefix/bin/node",
    "/opt/homebrew/bin/node",
    "/usr/local/bin/node",
    "/usr/bin/node",
    "node",
  ];
  const seen = new Set<string>();

  for (const candidate of candidates) {
    if (!candidate || seen.has(candidate)) continue;
    seen.add(candidate);

    if (candidate === process.execPath && !path.basename(candidate).toLowerCase().includes("node")) {
      continue;
    }

    const probe = spawnSync(candidate, ["-p", "process.execPath"], {
      encoding: "utf-8",
    });
    if (probe.status === 0) {
      const resolved = probe.stdout.trim();
      if (resolved) return resolved;
      return candidate;
    }
  }

  throw new Error("Node.js is required for local MCP integration tests.");
}

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

async function runLoadToolsScenario(): Promise<RunnerResult> {
  const nodeCommand = resolveNodeCommand();
  const servers: MCPServerConfig[] = [
    {
      name: "local",
      transport: {
        type: "stdio",
        command: nodeCommand,
        args: [fixturePath("mcp-echo-server.mjs")],
      },
      required: true,
      retries: 1,
    },
  ];

  const logs: string[] = [];
  const loaded = await loadMCPTools(servers, { log: (line) => logs.push(line) });
  try {
    const tool = loaded.tools["mcp__local__echo"] as {
      annotations?: Record<string, unknown>;
      execute: (input: Record<string, unknown>) => Promise<{
        content?: Array<{ type?: string; text?: string }>;
      }>;
    } | undefined;
    if (!tool) {
      throw new Error("Expected mcp__local__echo to be available.");
    }

    const result = await tool.execute({ text: "hello" });
    const resultText = result.content?.find((part) => part?.type === "text")?.text ?? "";

    return {
      scenario: "load-tools",
      logs,
      toolNames: Object.keys(loaded.tools).sort(),
      resultText,
      annotations: tool.annotations ?? null,
    };
  } finally {
    await loaded.close();
  }
}

async function runTurnScenario(): Promise<RunnerResult> {
  const nodeCommand = resolveNodeCommand();
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "agent-local-mcp-runner-"));
  try {
    await fs.mkdir(path.join(tmpDir, ".cowork"), { recursive: true });
    await fs.writeFile(
      path.join(tmpDir, ".cowork", "mcp-servers.json"),
      JSON.stringify(
        {
          servers: [
            {
              name: "local",
              transport: {
                type: "stdio",
                command: nodeCommand,
                args: [fixturePath("mcp-echo-server.mjs")],
              },
              required: true,
              retries: 1,
            },
          ],
        },
        null,
        2,
      ),
      "utf-8",
    );

    const config = makeConfig(tmpDir, tmpDir);
    let streamTextCalls = 0;

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
        streamText: async (args: any) => {
          streamTextCalls += 1;
          const tool = args?.tools?.["mcp__local__echo"];
          if (!tool) {
            throw new Error("Expected mcp__local__echo in streamText args.");
          }

          const result = await tool.execute({ text: "turn" });
          const firstText = result?.content?.find((part: any) => part?.type === "text")?.text ?? "";

          return {
            text: firstText,
            reasoningText: undefined,
            response: { messages: [] as any[] },
          };
        },
        stepCountIs: (_n: number) => "stop" as any,
        getModel: (_cfg: AgentConfig, _id?: string) => "model" as any,
      },
    );

    return {
      scenario: "run-turn",
      responseText: response.text,
      responseMessagesLength: response.responseMessages.length,
      streamTextCalls,
    };
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
}

async function main() {
  const [scenario, outputPath] = process.argv.slice(2);
  if (!scenario || !outputPath) {
    throw new Error("usage: <scenario> <outputPath>");
  }

  const result =
    scenario === "load-tools"
      ? await runLoadToolsScenario()
      : scenario === "run-turn"
        ? await runTurnScenario()
        : (() => {
            throw new Error(`unknown scenario: ${scenario}`);
          })();

  await fs.writeFile(outputPath, `${JSON.stringify(result)}\n`, "utf-8");
}

try {
  await main();
} catch (error) {
  console.error(JSON.stringify({
    error: error instanceof Error ? error.message : String(error),
    stack: error instanceof Error ? error.stack : undefined,
  }));
  process.exit(1);
}
