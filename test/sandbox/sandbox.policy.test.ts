import { describe, expect, test } from "bun:test";
import path from "node:path";

import { resolveSandboxPolicy } from "../../src/sandbox";
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

describe("sandbox policy mapping", () => {
  test("maps yolo to danger-full-access", () => {
    expect(resolveSandboxPolicy({ config: makeConfig("/repo"), yolo: true })).toMatchObject({
      mode: "danger-full-access",
      fileSystem: { kind: "unrestricted" },
      network: "enabled",
      platformSandboxRequired: false,
    });
  });

  test("maps no_project_write to read-only with restricted network", () => {
    expect(
      resolveSandboxPolicy({ config: makeConfig("/repo"), shellPolicy: "no_project_write" }),
    ).toMatchObject({
      mode: "read-only",
      fileSystem: { kind: "restricted", writableRoots: [] },
      network: "restricted",
      platformSandboxRequired: true,
    });
  });

  test("narrows workspace-write roots to child targetPaths", () => {
    const policy = resolveSandboxPolicy({
      config: makeConfig("/repo"),
      targetPaths: ["src/feature"],
    });

    expect(policy).toMatchObject({
      mode: "workspace-write",
      fileSystem: {
        kind: "restricted",
        writableRoots: [{ root: path.join("/repo", "src", "feature") }],
      },
    });
  });
});
