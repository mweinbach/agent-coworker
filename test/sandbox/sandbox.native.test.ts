import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { __internal as sandboxNativeInternal } from "../../src/sandbox/native";
import { createBashTool } from "../../src/tools/bash";
import type { ToolContext } from "../../src/tools/context";
import type { AgentConfig } from "../../src/types";

function makeConfig(dir: string): AgentConfig {
  return {
    provider: "google",
    model: "gemini-3-flash-preview",
    preferredChildModel: "gemini-3-flash-preview",
    workingDirectory: dir,
    outputDirectory: path.join(dir, "output"),
    uploadsDirectory: path.join(dir, "uploads"),
    userName: "",
    knowledgeCutoff: "unknown",
    projectCoworkDir: path.join(dir, ".cowork"),
    userCoworkDir: path.join(dir, ".agent-user"),
    builtInDir: dir,
    builtInConfigDir: path.join(dir, "config"),
    skillsDirs: [],
    memoryDirs: [],
    configDirs: [],
  };
}

function makeCtx(dir: string, overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    config: makeConfig(dir),
    log: () => {},
    askUser: async () => "",
    approveCommand: async () => true,
    shellPolicy: "full",
    ...overrides,
  };
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

describe("native sandbox runner", () => {
  afterEach(() => {
    delete process.env.COWORK_LINUX_SANDBOX_HELPER;
  });

  test("generates macOS Seatbelt write allowlist and protected metadata denies", () => {
    const profile = sandboxNativeInternal.buildSeatbeltPolicy({
      mode: "workspace-write",
      network: "restricted",
      platformSandboxRequired: true,
      reference: {
        repository: "https://github.com/openai/codex",
        commit: "4de7a2b9d8eae19e00ca7f744647fa1aabdc204f",
      },
      fileSystem: {
        kind: "restricted",
        readableRoots: ["/"],
        writableRoots: [{ root: "/repo", readOnlySubpaths: ["/repo/.git"] }],
        protectedMetadataNames: [".git"],
        allowTmpWrite: false,
      },
    });

    expect(profile).toContain("(deny default)");
    expect(profile).toContain('(allow file-write* (subpath "/repo"))');
    expect(profile).toContain('(deny file-write* (subpath "/repo/.git"))');
    expect(profile).not.toContain("(allow network*)");
  });

  test.skipIf(process.platform !== "linux")(
    "denies writes outside workspace-write roots on Linux",
    async () => {
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cowork-sandbox-workspace-"));
      const outside = path.join(os.tmpdir(), `cowork-sandbox-outside-${crypto.randomUUID()}`);
      const tool: any = createBashTool(makeCtx(dir));

      const result = await tool.execute({
        command: `echo ok > inside.txt; echo blocked > ${outside}`,
      });

      expect(result.exitCode).not.toBe(0);
      expect(await fs.readFile(path.join(dir, "inside.txt"), "utf8")).toBe("ok\n");
      expect(await exists(outside)).toBe(false);
    },
  );

  test.skipIf(process.platform !== "linux")(
    "denies writes in read-only mode on Linux",
    async () => {
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cowork-sandbox-readonly-"));
      const tool: any = createBashTool(makeCtx(dir, { shellPolicy: "no_project_write" }));

      const result = await tool.execute({ command: "echo blocked > inside.txt" });

      expect(result.exitCode).not.toBe(0);
      expect(await exists(path.join(dir, "inside.txt"))).toBe(false);
    },
  );
});
