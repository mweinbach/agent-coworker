import { describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { withGlobalTestLock } from "./shared/processLock";

type LoadToolsResult = {
  scenario: "load-tools";
  logs: string[];
  toolNames: string[];
  resultText: string;
  annotations: Record<string, unknown> | null;
};

type RunTurnResult = {
  scenario: "run-turn";
  responseText: string;
  responseMessagesLength: number;
  streamTextCalls: number;
};

function runnerPath(): string {
  return path.join(import.meta.dir, "fixtures", "mcp-local-integration-runner.ts");
}

async function runScenario<T>(scenario: "load-tools" | "run-turn"): Promise<T> {
  const outputDir = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-local-runner-"));
  const outputPath = path.join(outputDir, "result.json");

  try {
    const proc = Bun.spawn({
      cmd: [process.execPath, runnerPath(), scenario, outputPath],
      cwd: path.resolve(import.meta.dir, ".."),
      stdout: "ignore",
      stderr: "pipe",
    });

    const [exitCode, stderr] = await Promise.all([
      proc.exited,
      new Response(proc.stderr).text(),
    ]);

    if (exitCode !== 0) {
      throw new Error(stderr.trim() || `Runner exited with status ${exitCode}`);
    }

    return JSON.parse(await fs.readFile(outputPath, "utf-8")) as T;
  } finally {
    await fs.rm(outputDir, { recursive: true, force: true });
  }
}

describe("local MCP integration", () => {
  test("loadMCPTools connects to a local stdio server and executes a real tool", async () => {
    await withGlobalTestLock("subprocess-env", async () => {
      const result = await runScenario<LoadToolsResult>("load-tools");
      expect(result.toolNames).toContain("mcp__local__echo");
      expect(result.resultText).toBe("echo:hello");
      expect(result.annotations).toEqual(expect.objectContaining({ readOnlyHint: true }));
      expect(result.logs.some((line) => line.includes("Connected to local"))).toBe(true);
    });
  });

  test("runTurnWithDeps exposes local MCP tools to streamText", async () => {
    await withGlobalTestLock("subprocess-env", async () => {
      const result = await runScenario<RunTurnResult>("run-turn");
      expect(result.responseText).toBe("echo:turn");
      expect(result.responseMessagesLength).toBe(0);
      expect(result.streamTextCalls).toBe(1);
    });
  });
});
