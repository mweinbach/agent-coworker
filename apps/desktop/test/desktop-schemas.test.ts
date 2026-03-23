import { describe, expect, test } from "bun:test";

import { desktopMenuCommandSchema, persistedStateInputSchema, updaterStateSchema } from "../src/lib/desktopSchemas";

const TS = "2024-01-01T00:00:00.000Z";

describe("desktop persisted-state schema defaults", () => {
  test("defaults workspace booleans when omitted", () => {
    const parsed = persistedStateInputSchema.parse({
      version: 2,
      workspaces: [
        {
          id: "ws_1",
          name: "Workspace",
          path: "/tmp/workspace",
          createdAt: TS,
          lastOpenedAt: TS,
        },
      ],
      threads: [],
    });

    expect(parsed.workspaces[0]?.defaultEnableMcp).toBe(true);
    expect(parsed.workspaces[0]?.defaultBackupsEnabled).toBe(true);
    expect(parsed.workspaces[0]?.wsProtocol).toBe("jsonrpc");
    expect(parsed.workspaces[0]?.defaultToolOutputOverflowChars).toBeUndefined();
    expect(parsed.workspaces[0]?.yolo).toBe(false);
    expect(parsed.developerMode).toBe(false);
    expect(parsed.showHiddenFiles).toBe(false);
  });

  test("normalizes legacy workspace protocol values to jsonrpc", () => {
    const parsed = persistedStateInputSchema.parse({
      version: 2,
      workspaces: [
        {
          id: "ws_1",
          name: "Workspace",
          path: "/tmp/workspace",
          createdAt: TS,
          lastOpenedAt: TS,
          wsProtocol: "legacy",
        },
      ],
      threads: [],
    });

    expect(parsed.workspaces[0]?.wsProtocol).toBe("jsonrpc");
  });

  test("keeps explicit workspace booleans", () => {
    const parsed = persistedStateInputSchema.parse({
      version: 2,
      workspaces: [
        {
          id: "ws_1",
          name: "Workspace",
          path: "/tmp/workspace",
          createdAt: TS,
          lastOpenedAt: TS,
          wsProtocol: "jsonrpc",
          defaultEnableMcp: false,
          defaultBackupsEnabled: false,
          defaultToolOutputOverflowChars: null,
          userName: "Alex",
          userProfile: {
            instructions: "Keep answers terse.",
            work: "Platform engineer",
            details: "Prefers Bun",
          },
          yolo: true,
        },
      ],
      threads: [],
      developerMode: true,
      showHiddenFiles: true,
    });

    expect(parsed.workspaces[0]?.defaultEnableMcp).toBe(false);
    expect(parsed.workspaces[0]?.defaultBackupsEnabled).toBe(false);
    expect(parsed.workspaces[0]?.wsProtocol).toBe("jsonrpc");
    expect(parsed.workspaces[0]?.defaultToolOutputOverflowChars).toBeNull();
    expect(parsed.workspaces[0]?.userName).toBe("Alex");
    expect(parsed.workspaces[0]?.userProfile).toEqual({
      instructions: "Keep answers terse.",
      work: "Platform engineer",
      details: "Prefers Bun",
    });
    expect(parsed.workspaces[0]?.yolo).toBe(true);
    expect(parsed.developerMode).toBe(true);
    expect(parsed.showHiddenFiles).toBe(true);
  });

  test("accepts aws bedrock proxy workspace provider options", () => {
    const parsed = persistedStateInputSchema.parse({
      version: 2,
      workspaces: [
        {
          id: "ws_1",
          name: "Workspace",
          path: "/tmp/workspace",
          createdAt: TS,
          lastOpenedAt: TS,
          providerOptions: {
            "aws-bedrock-proxy": {
              reasoningEffort: "high",
              reasoningSummary: "detailed",
              textVerbosity: "medium",
              baseUrl: "https://bedrock-proxy.example.com",
              promptCaching: {
                enabled: true,
                ttl: "1h",
              },
            },
          },
        },
      ],
      threads: [],
    });

    expect(parsed.workspaces[0]?.providerOptions).toEqual({
      "aws-bedrock-proxy": {
        reasoningEffort: "high",
        reasoningSummary: "detailed",
        textVerbosity: "medium",
        baseUrl: "https://bedrock-proxy.example.com",
        promptCaching: {
          enabled: true,
          ttl: "1h",
        },
      },
    });
  });

  test("accepts updater state payloads", () => {
    const parsed = updaterStateSchema.parse({
      phase: "downloading",
      packaged: true,
      currentVersion: "0.1.0",
      lastCheckStartedAt: TS,
      lastCheckedAt: TS,
      downloadedAt: null,
      message: "Downloading update…",
      error: null,
      progress: {
        percent: 42.5,
        transferred: 425,
        total: 1000,
        bytesPerSecond: 256,
      },
      release: {
        version: "0.2.0",
        releaseName: "Cowork 0.2.0",
        releaseDate: TS,
        releaseNotes: "Bug fixes",
        releasePageUrl: "https://github.com/mweinbach/agent-coworker/releases/latest",
      },
    });

    expect(parsed.phase).toBe("downloading");
    expect(parsed.progress?.percent).toBe(42.5);
    expect(parsed.release?.version).toBe("0.2.0");
  });

  test("accepts openUpdates desktop menu command", () => {
    expect(desktopMenuCommandSchema.parse("openUpdates")).toBe("openUpdates");
  });
});
