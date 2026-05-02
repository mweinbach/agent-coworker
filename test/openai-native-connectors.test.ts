import { describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { __internal as codexAppServerAuthInternal } from "../src/providers/codexAppServerAuth";
import {
  listOpenAiNativeConnectors,
  openAiNativeConnectorsConfigPath,
  setOpenAiNativeConnectorEnabled,
} from "../src/server/connectors/openaiNativeConnectors";
import type { AgentConfig } from "../src/types";

function makeConfig(workspaceRoot: string, home: string): AgentConfig {
  return {
    provider: "codex-cli",
    model: "gpt-5.4",
    preferredChildModel: "gpt-5.4",
    workingDirectory: workspaceRoot,
    outputDirectory: path.join(workspaceRoot, "output"),
    uploadsDirectory: path.join(workspaceRoot, "uploads"),
    userName: "tester",
    knowledgeCutoff: "unknown",
    projectCoworkDir: path.join(workspaceRoot, ".cowork"),
    userCoworkDir: path.join(home, ".cowork"),
    builtInDir: workspaceRoot,
    builtInConfigDir: path.join(workspaceRoot, "config"),
    skillsDirs: [path.join(home, ".cowork", "skills")],
    memoryDirs: [],
    configDirs: [],
    experimentalFeatures: { openAiNativeConnectors: true },
  };
}

describe("OpenAI native connectors", () => {
  test("reports app-server connector ownership when Codex is signed in", async () => {
    const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "connectors-workspace-"));
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "connectors-home-"));
    const config = makeConfig(workspaceRoot, home);
    codexAppServerAuthInternal.setAuthOverridesForTests({
      readAccount: async () => ({
        account: { type: "chatgpt", email: "tester@example.com" },
        requiresOpenaiAuth: true,
      }),
    });
    try {
      await setOpenAiNativeConnectorEnabled(config, "connector_gmail", true);

      const snapshot = await listOpenAiNativeConnectors({
        config,
        fetchImpl: async () => {
          throw new Error("direct connector fetch should not run");
        },
        discoverAccessible: false,
      });

      expect(snapshot.authenticated).toBe(true);
      expect(snapshot.enabledConnectorIds).toEqual([]);
      expect(snapshot.connectors).toEqual([]);
      expect(snapshot.message).toContain("app-server owns ChatGPT apps/connectors");
    } finally {
      codexAppServerAuthInternal.resetAuthOverridesForTests();
    }
  });

  test("persists connector enabled state in the workspace .cowork directory", async () => {
    const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "connectors-config-"));
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "connectors-config-home-"));
    const config = makeConfig(workspaceRoot, home);

    await setOpenAiNativeConnectorEnabled(config, "connector_dropbox", true);

    const persisted = JSON.parse(
      await fs.readFile(openAiNativeConnectorsConfigPath(config), "utf-8"),
    );
    expect(persisted.connectors.connector_dropbox.enabled).toBe(true);
  });
});
