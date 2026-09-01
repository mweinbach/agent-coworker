import { describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { __internal as codexAppServerAuthInternal } from "../src/providers/codexAppServerAuth";
import {
  listOpenAiNativeConnectors,
  setOpenAiNativeConnectorEnabled,
} from "../src/server/connectors/openaiNativeConnectors";
import { createConnectorsRouteHandlers } from "../src/server/jsonrpc/routes/connectors";
import type { JsonRpcRouteContext } from "../src/server/jsonrpc/routes/types";
import type { AgentConfig } from "../src/types";
import { pinHome } from "./helpers/platform";
import { makeTmpProject } from "./helpers/wsHarness";

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
  test("derives apps from Codex app-server MCP status metadata", () => {
    const appsConfig = codexAppServerAuthInternal.normalizeAppConfig({
      _default: null,
      connector_gmail: { enabled: false },
    });
    const apps = codexAppServerAuthInternal.appsFromMcpServerStatuses(
      [
        {
          name: "codex_apps",
          tools: {
            gmail_search: {
              name: "gmail_search",
              description: "Search Gmail",
              _meta: {
                connector_id: "connector_gmail",
                connector_name: "Gmail",
                connector_description: "Search mail from Gmail.",
                link_id: "link_gmail",
              },
            },
            drive_search: {
              name: "drive_search",
              _meta: {
                connector_id: "connector_drive",
                connector_name: "Google Drive",
                connector_description: "Search Drive files.",
                link_id: "link_drive",
              },
            },
            unowned_tool: {
              name: "unowned_tool",
              _meta: {
                resource_name: "Local tool",
              },
            },
          },
          resources: [],
          resourceTemplates: [],
          authStatus: "unsupported",
        },
      ],
      appsConfig,
    );

    expect(apps).toEqual([
      expect.objectContaining({
        id: "connector_gmail",
        name: "Gmail",
        description: "Search mail from Gmail.",
        isAccessible: true,
        isEnabled: false,
      }),
      expect.objectContaining({
        id: "connector_drive",
        name: "Google Drive",
        description: "Search Drive files.",
        isAccessible: true,
        isEnabled: true,
      }),
    ]);
    expect(apps[0]?.appMetadata).toMatchObject({
      source: "mcpServerStatus/list",
      toolCount: 1,
      serverNames: ["codex_apps"],
      linkIds: ["link_gmail"],
    });
  });

  test("lists Codex app-server apps when Codex is signed in", async () => {
    const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "connectors-workspace-"));
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "connectors-home-"));
    const config = makeConfig(workspaceRoot, home);
    codexAppServerAuthInternal.setAuthOverridesForTests({
      readAccount: async () => ({
        account: { type: "chatgpt", email: "tester@example.com" },
        requiresOpenaiAuth: true,
      }),
      listApps: async () => [
        {
          id: "connector_gmail",
          name: "Gmail",
          description: "Search mail",
          isAccessible: true,
          isEnabled: true,
        },
      ],
    });
    try {
      const snapshot = await listOpenAiNativeConnectors({
        config,
        forceRefetch: true,
      });

      expect(snapshot.authenticated).toBe(true);
      expect(snapshot.enabledConnectorIds).toEqual(["connector_gmail"]);
      expect(snapshot.connectors).toEqual([
        expect.objectContaining({
          id: "connector_gmail",
          name: "Gmail",
          isAccessible: true,
          isEnabled: true,
        }),
      ]);
    } finally {
      codexAppServerAuthInternal.resetAuthOverridesForTests();
    }
  });

  test("persists connector enabled state through Codex app-server config", async () => {
    const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "connectors-config-"));
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "connectors-config-home-"));
    const config = makeConfig(workspaceRoot, home);
    const writes: Array<{ appId: string; enabled: boolean }> = [];
    codexAppServerAuthInternal.setAuthOverridesForTests({
      setAppEnabled: async (opts) => {
        writes.push({ appId: opts.appId, enabled: opts.enabled });
      },
    });

    try {
      await setOpenAiNativeConnectorEnabled(config, "connector_dropbox", true);

      expect(writes).toEqual([{ appId: "connector_dropbox", enabled: true }]);
      await expect(
        fs.readFile(path.join(config.projectCoworkDir, "openai-native-connectors.json"), "utf-8"),
      ).rejects.toThrow();
    } finally {
      codexAppServerAuthInternal.resetAuthOverridesForTests();
    }
  });

  test.each([
    ["list", false],
    ["refresh", true],
  ] as const)(
    "RPC %s uses the intended app-server cache policy",
    async (operation, forceRefetch) => {
      const workspaceRoot = await makeTmpProject("connectors-route-");
      const restoreHome = pinHome(workspaceRoot);
      const previousFeatureFlag = process.env.COWORK_EXPERIMENTAL_OPENAI_NATIVE_CONNECTORS;
      process.env.COWORK_EXPERIMENTAL_OPENAI_NATIVE_CONNECTORS = "1";
      const requests: Array<boolean | undefined> = [];
      const results: unknown[] = [];
      const errors: unknown[] = [];
      codexAppServerAuthInternal.setAuthOverridesForTests({
        readAccount: async () => ({
          account: { type: "chatgpt", email: "tester@example.com" },
          requiresOpenaiAuth: true,
        }),
        listApps: async (opts) => {
          requests.push(opts.forceRefetch);
          return [
            {
              id: "connector_one",
              name: opts.forceRefetch ? "Fresh app" : "Cached app",
              isAccessible: true,
              isEnabled: true,
            },
          ];
        },
      });
      const context = {
        utils: { resolveWorkspacePath: () => workspaceRoot },
        workspaceControl: {
          withSession: async (
            _cwd: string,
            run: (binding: unknown, runtime: unknown) => Promise<unknown>,
          ) => await run({}, { read: { id: "control-1" } }),
        },
        jsonrpc: {
          sendResult: (_ws: unknown, _id: unknown, result: unknown) => results.push(result),
          sendError: (_ws: unknown, _id: unknown, error: unknown) => errors.push(error),
        },
      } as unknown as JsonRpcRouteContext;

      try {
        const method = `cowork/connectors/openai-native/${operation}`;
        await createConnectorsRouteHandlers(context)[method]!({} as never, {
          id: 1,
          method,
          params: { cwd: workspaceRoot },
        });

        expect(errors).toEqual([]);
        expect(requests).toEqual([forceRefetch]);
        expect(results).toEqual([
          {
            event: {
              type: "openai_native_connectors",
              sessionId: "control-1",
              authenticated: true,
              connectors: [
                {
                  id: "connector_one",
                  name: forceRefetch ? "Fresh app" : "Cached app",
                  isAccessible: true,
                  isEnabled: true,
                },
              ],
              enabledConnectorIds: ["connector_one"],
            },
          },
        ]);
      } finally {
        codexAppServerAuthInternal.resetAuthOverridesForTests();
        restoreHome();
        if (previousFeatureFlag === undefined) {
          delete process.env.COWORK_EXPERIMENTAL_OPENAI_NATIVE_CONNECTORS;
        } else {
          process.env.COWORK_EXPERIMENTAL_OPENAI_NATIVE_CONNECTORS = previousFeatureFlag;
        }
        await fs.rm(workspaceRoot, { recursive: true, force: true });
      }
    },
  );
});
