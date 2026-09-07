import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import path from "node:path";

import { executeToolCall } from "../src/runtime/pi/tools";
import type { RuntimeRunTurnParams } from "../src/runtime/types";
import { MODEL_SCRATCHPAD_DIRNAME } from "../src/shared/toolOutputOverflow";
import { makeTmpDirs } from "./providers/helpers";
import { makeConfig } from "./runtime/codex-app-server/helpers";

const workspaces: string[] = [];
const oversized = "meaningful-result\n".repeat(3_000);
afterEach(async () => {
  for (const workspace of workspaces.splice(0)) {
    await fs.rm(workspace, { recursive: true, force: true });
  }
});

async function makeParams(): Promise<RuntimeRunTurnParams> {
  const { tmp, cwd: workspace } = await makeTmpDirs();
  workspaces.push(tmp);
  await fs.mkdir(path.join(workspace, "assigned"));
  return {
    config: { ...makeConfig(workspace), toolOutputOverflowChars: 100 },
    system: "",
    messages: [],
    tools: { grep: { execute: async () => ({ count: 3_000, value: oversized }) } },
    maxSteps: 1,
    yolo: true,
    assertCanMutate: async () => {},
  };
}

async function execute(params: RuntimeRunTurnParams, name = "grep") {
  const emitted: Array<Record<string, unknown>> = [];
  const result = await executeToolCall(
    { id: "overflow", name, arguments: {} },
    params,
    async (p) => {
      emitted.push(p as Record<string, unknown>);
    },
  );
  return { result, emitted };
}

describe("overflow filesystem policy propagation", () => {
  test.each(["read-only", "role", "scope"] as const)(
    "%s keeps a bounded inline result without writing an unauthorized spill",
    async (restriction) => {
      const params = await makeParams();
      if (restriction === "read-only") {
        params.config.sandbox = { mode: "read-only", network: true };
      } else if (restriction === "role") {
        params.shellPolicy = "no_project_write";
      } else {
        params.agentTargetPaths = ["assigned"];
      }
      const { result, emitted } = await execute(params);
      expect(result.isError).toBe(false);
      expect(result.details).toMatchObject({ count: 3_000, truncated: true });
      expect(result.details).not.toHaveProperty("filePath");
      expect(JSON.stringify(result.content)).toContain("meaningful-result");
      expect(JSON.stringify(result.content).length).toBeLessThan(10_000);
      expect(emitted.some((p) => p.type === "file")).toBe(false);
      expect(await fs.readdir(params.config.workingDirectory)).not.toContain(
        MODEL_SCRATCHPAD_DIRNAME,
      );
    },
  );

  test("keeps permitted scoped spills readable by the same scope", async () => {
    const params = await makeParams();
    params.agentTargetPaths = [MODEL_SCRATCHPAD_DIRNAME];
    const { result, emitted } = await execute(params);
    expect(result.isError).toBe(false);
    const file = emitted.find((p) => p.type === "file")?.file as { path: string };
    expect(file.path).toContain(MODEL_SCRATCHPAD_DIRNAME);
    expect(JSON.parse(await fs.readFile(file.path, "utf-8")).value).toBe(oversized);
  });

  test("rechecks policy after an asynchronous mutation gate", async () => {
    const params = await makeParams();
    params.assertCanMutate = async () => {
      params.config.sandbox = { mode: "read-only", network: true };
    };
    const { result, emitted } = await execute(params);
    expect(result.details).toHaveProperty("truncated", true);
    expect(emitted.some((p) => p.type === "file")).toBe(false);
    expect(await fs.readdir(params.config.workingDirectory)).not.toContain(
      MODEL_SCRATCHPAD_DIRNAME,
    );
  });

  test("does not spill into writable directories denied to file readers", async () => {
    const params = await makeParams();
    params.config.userCoworkDir = params.config.workingDirectory;
    params.config.workingDirectory = path.join(params.config.userCoworkDir, "auth");
    await fs.mkdir(params.config.workingDirectory);
    const { result, emitted } = await execute(params);
    expect(result.details).toHaveProperty("truncated", true);
    expect(emitted.some((p) => p.type === "file")).toBe(false);
    expect(await fs.readdir(params.config.workingDirectory)).toEqual([]);
  });

  test.each(["read", "skill"])("preserves the complete %s exemption", async (name) => {
    const params = await makeParams();
    params.config.sandbox = { mode: "read-only", network: true };
    params.tools = { [name]: { execute: async () => oversized } };
    const { result, emitted } = await execute(params, name);
    expect(result.content).toEqual([{ type: "text", text: oversized }]);
    expect(emitted.some((p) => p.type === "file")).toBe(false);
    expect(await fs.readdir(params.config.workingDirectory)).not.toContain(
      MODEL_SCRATCHPAD_DIRNAME,
    );
  });
});
