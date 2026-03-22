import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

let userDataDir = "";
let appDataDir = "";

mock.module("electron", () => ({
  app: {
    getPath: (name: string) => (name === "appData" ? appDataDir : userDataDir),
  },
}));

const { PersistenceService } = await import("../electron/services/persistence");

const TS = "2024-01-01T00:00:00.000Z";

describe("desktop persistence state validation", () => {
  beforeEach(async () => {
    appDataDir = await fs.mkdtemp(path.join(os.tmpdir(), "cowork-desktop-appdata-"));
    userDataDir = path.join(appDataDir, "Cowork");
    await fs.mkdir(userDataDir, { recursive: true });
  });

  afterEach(async () => {
    if (!appDataDir) {
      return;
    }
    await fs.rm(appDataDir, { recursive: true, force: true });
    userDataDir = "";
    appDataDir = "";
  });

  test("saveState skips invalid workspaces and orphan threads instead of failing", async () => {
    const persistence = new PersistenceService();
    const validWorkspace = path.join(userDataDir, "workspace-valid");
    const missingWorkspace = path.join(userDataDir, "workspace-missing");
    await fs.mkdir(validWorkspace, { recursive: true });

    await persistence.saveState({
      version: 2,
      workspaces: [
        {
          id: "ws_valid",
          name: "Valid workspace",
          path: validWorkspace,
          createdAt: TS,
          lastOpenedAt: TS,
          defaultPreferredChildModel: "gpt-5.2-mini",
          defaultEnableMcp: true,
          defaultBackupsEnabled: false,
          yolo: false,
        },
        {
          id: "ws_missing",
          name: "Missing workspace",
          path: missingWorkspace,
          createdAt: TS,
          lastOpenedAt: TS,
          defaultEnableMcp: false,
          yolo: true,
        },
      ],
      threads: [
        {
          id: "thread_valid",
          workspaceId: "ws_valid",
          title: "Valid thread",
          titleSource: "manual",
          createdAt: TS,
          lastMessageAt: TS,
          status: "active",
          sessionId: null,
          lastEventSeq: 0,
        },
        {
          id: "thread_orphan",
          workspaceId: "ws_missing",
          title: "Orphan thread",
          titleSource: "manual",
          createdAt: TS,
          lastMessageAt: TS,
          status: "active",
          sessionId: null,
          lastEventSeq: 0,
        },
      ],
      developerMode: true,
      showHiddenFiles: true,
    });

    const loaded = await persistence.loadState();
    expect(loaded.workspaces).toHaveLength(1);
    expect(loaded.workspaces[0]?.id).toBe("ws_valid");
    expect(loaded.workspaces[0]?.wsProtocol).toBe("jsonrpc");
    expect(loaded.workspaces[0]?.defaultBackupsEnabled).toBe(false);
    expect(loaded.threads).toHaveLength(1);
    expect(loaded.threads[0]?.id).toBe("thread_valid");
  });

  test("saveState preserves sanitized provider status snapshots", async () => {
    const persistence = new PersistenceService();
    const validWorkspace = path.join(userDataDir, "workspace-provider");
    await fs.mkdir(validWorkspace, { recursive: true });

    await persistence.saveState({
      version: 2,
      workspaces: [
        {
          id: "ws_provider",
          name: "Provider workspace",
          path: validWorkspace,
          createdAt: TS,
          lastOpenedAt: TS,
          defaultEnableMcp: true,
          yolo: false,
        },
      ],
      threads: [],
      developerMode: false,
      showHiddenFiles: false,
      providerState: {
        statusByName: {
          "codex-cli": {
            provider: "codex-cli",
            authorized: true,
            verified: false,
            mode: "oauth",
            account: { email: "max@example.com" },
            message: "Codex credentials present.",
            checkedAt: TS,
          },
        },
        statusLastUpdatedAt: TS,
      },
    });

    const loaded = await persistence.loadState();
    expect(loaded.providerState?.statusLastUpdatedAt).toBe(TS);
    expect(loaded.providerState?.statusByName?.["codex-cli"]?.authorized).toBe(true);
    expect(loaded.providerState?.statusByName?.["codex-cli"]?.mode).toBe("oauth");
    expect(loaded.providerState?.statusByName?.["codex-cli"]?.account?.email).toBe("max@example.com");
  });

  test("saveState preserves LM Studio UI visibility preferences", async () => {
    const persistence = new PersistenceService();
    const validWorkspace = path.join(userDataDir, "workspace-lmstudio-ui");
    await fs.mkdir(validWorkspace, { recursive: true });

    await persistence.saveState({
      version: 2,
      workspaces: [
        {
          id: "ws_lmstudio_ui",
          name: "LM Studio workspace",
          path: validWorkspace,
          createdAt: TS,
          lastOpenedAt: TS,
          defaultEnableMcp: true,
          defaultBackupsEnabled: true,
          yolo: false,
        },
      ],
      threads: [],
      developerMode: false,
      showHiddenFiles: false,
      providerUiState: {
        lmstudio: {
          enabled: true,
          hiddenModels: ["llama-3.2-vision"],
        },
      },
    });

    const loaded = await persistence.loadState();
    expect(loaded.providerUiState).toEqual({
      lmstudio: {
        enabled: true,
        hiddenModels: ["llama-3.2-vision"],
      },
    });
  });

  test("loadState enables LM Studio UI by default when the saved provider status is already connected", async () => {
    const persistence = new PersistenceService();
    const validWorkspace = path.join(userDataDir, "workspace-lmstudio-default");
    await fs.mkdir(validWorkspace, { recursive: true });

    await persistence.saveState({
      version: 2,
      workspaces: [
        {
          id: "ws_lmstudio_default",
          name: "LM Studio workspace",
          path: validWorkspace,
          createdAt: TS,
          lastOpenedAt: TS,
          defaultEnableMcp: true,
          defaultBackupsEnabled: true,
          yolo: false,
        },
      ],
      threads: [],
      developerMode: false,
      showHiddenFiles: false,
      providerState: {
        statusByName: {
          lmstudio: {
            provider: "lmstudio",
            authorized: true,
            verified: true,
            mode: "local",
            account: null,
            message: "LM Studio reachable.",
            checkedAt: TS,
          },
        },
        statusLastUpdatedAt: TS,
      },
    });

    const loaded = await persistence.loadState();
    expect(loaded.providerUiState?.lmstudio.enabled).toBe(true);
    expect(loaded.providerUiState?.lmstudio.hiddenModels).toEqual([]);
  });

  test("saveState preserves workspace tool output overflow defaults", async () => {
    const persistence = new PersistenceService();
    const customWorkspace = path.join(userDataDir, "workspace-overflow-custom");
    const disabledWorkspace = path.join(userDataDir, "workspace-overflow-disabled");
    const inheritedWorkspace = path.join(userDataDir, "workspace-overflow-inherited");
    await fs.mkdir(customWorkspace, { recursive: true });
    await fs.mkdir(disabledWorkspace, { recursive: true });
    await fs.mkdir(inheritedWorkspace, { recursive: true });

    await persistence.saveState({
      version: 2,
      workspaces: [
        {
          id: "ws_overflow_custom",
          name: "Custom overflow workspace",
          path: customWorkspace,
          createdAt: TS,
          lastOpenedAt: TS,
          defaultToolOutputOverflowChars: 12000,
          defaultEnableMcp: true,
          defaultBackupsEnabled: true,
          yolo: false,
        },
        {
          id: "ws_overflow_disabled",
          name: "Disabled overflow workspace",
          path: disabledWorkspace,
          createdAt: TS,
          lastOpenedAt: TS,
          defaultToolOutputOverflowChars: null,
          defaultEnableMcp: true,
          defaultBackupsEnabled: true,
          yolo: false,
        },
        {
          id: "ws_overflow_inherited",
          name: "Inherited overflow workspace",
          path: inheritedWorkspace,
          createdAt: TS,
          lastOpenedAt: TS,
          defaultEnableMcp: true,
          defaultBackupsEnabled: true,
          yolo: false,
        },
      ],
      threads: [],
      developerMode: false,
      showHiddenFiles: false,
    });

    const loaded = await persistence.loadState();
    expect(loaded.workspaces.find((workspace) => workspace.id === "ws_overflow_custom")?.defaultToolOutputOverflowChars).toBe(12000);
    expect(loaded.workspaces.find((workspace) => workspace.id === "ws_overflow_disabled")?.defaultToolOutputOverflowChars).toBeNull();
    expect(loaded.workspaces.find((workspace) => workspace.id === "ws_overflow_inherited")?.defaultToolOutputOverflowChars).toBeUndefined();
  });

  test("saveState preserves workspace user profile defaults", async () => {
    const persistence = new PersistenceService();
    const profileWorkspace = path.join(userDataDir, "workspace-profile");
    await fs.mkdir(profileWorkspace, { recursive: true });

    await persistence.saveState({
      version: 2,
      workspaces: [
        {
          id: "ws_profile",
          name: "Profile workspace",
          path: profileWorkspace,
          createdAt: TS,
          lastOpenedAt: TS,
          userName: "Alex",
          userProfile: {
            instructions: "Keep answers terse.",
            work: "Platform engineer",
            details: "Prefers Bun",
          },
          defaultEnableMcp: true,
          defaultBackupsEnabled: true,
          yolo: false,
        },
      ],
      threads: [],
      developerMode: false,
      showHiddenFiles: false,
    });

    const loaded = await persistence.loadState();
    expect(loaded.workspaces[0]?.userName).toBe("Alex");
    expect(loaded.workspaces[0]?.userProfile).toEqual({
      instructions: "Keep answers terse.",
      work: "Platform engineer",
      details: "Prefers Bun",
    });
  });

  test("saveState preserves workspace cross-provider child routing defaults", async () => {
    const persistence = new PersistenceService();
    const routingWorkspace = path.join(userDataDir, "workspace-child-routing");
    await fs.mkdir(routingWorkspace, { recursive: true });

    await persistence.saveState({
      version: 2,
      workspaces: [
        {
          id: "ws_child_routing",
          name: "Child routing workspace",
          path: routingWorkspace,
          createdAt: TS,
          lastOpenedAt: TS,
          defaultProvider: "codex-cli",
          defaultModel: "gpt-5.4",
          defaultPreferredChildModel: "gpt-5.4",
          defaultChildModelRoutingMode: "cross-provider-allowlist",
          defaultPreferredChildModelRef: "opencode-zen:glm-5",
          defaultAllowedChildModelRefs: ["opencode-zen:glm-5", "opencode-go:glm-5"],
          defaultEnableMcp: true,
          defaultBackupsEnabled: true,
          yolo: false,
        },
      ],
      threads: [],
      developerMode: false,
      showHiddenFiles: false,
    });

    const loaded = await persistence.loadState();
    expect(loaded.workspaces[0]?.defaultChildModelRoutingMode).toBe("cross-provider-allowlist");
    expect(loaded.workspaces[0]?.defaultPreferredChildModelRef).toBe("opencode-zen:glm-5");
    expect(loaded.workspaces[0]?.defaultAllowedChildModelRefs).toEqual(["opencode-zen:glm-5", "opencode-go:glm-5"]);
  });

  test("saveState drops recoverable expired codex status snapshots that would look disconnected on restart", async () => {
    const persistence = new PersistenceService();
    const validWorkspace = path.join(userDataDir, "workspace-provider-recoverable");
    await fs.mkdir(validWorkspace, { recursive: true });

    await persistence.saveState({
      version: 2,
      workspaces: [
        {
          id: "ws_provider_recoverable",
          name: "Recoverable provider workspace",
          path: validWorkspace,
          createdAt: TS,
          lastOpenedAt: TS,
          defaultEnableMcp: true,
          yolo: false,
        },
      ],
      threads: [],
      developerMode: false,
      showHiddenFiles: false,
      providerState: {
        statusByName: {
          "codex-cli": {
            provider: "codex-cli",
            authorized: false,
            verified: false,
            mode: "oauth",
            account: { email: "max@example.com" },
            message: "Codex token expired. Token refresh failed: temporary outage",
            checkedAt: TS,
            tokenRecoverable: true,
          },
        },
        statusLastUpdatedAt: TS,
      },
    });

    const loaded = await persistence.loadState();
    expect(loaded.providerState?.statusByName?.["codex-cli"]).toBeUndefined();
    expect(loaded.providerState?.statusLastUpdatedAt).toBe(TS);
  });

  test("loadState sanitizes malformed on-disk payloads instead of failing", async () => {
    const persistence = new PersistenceService();
    const validWorkspace = path.join(userDataDir, "workspace-from-disk");
    await fs.mkdir(validWorkspace, { recursive: true });

    const statePath = path.join(userDataDir, "state.json");
    await fs.writeFile(
      statePath,
      JSON.stringify(
        {
          version: "bad",
          workspaces: [
            {
              id: "",
              name: 123,
              path: validWorkspace,
              createdAt: "not-a-date",
              lastOpenedAt: TS,
            },
          ],
          threads: [
            {
              id: "thread_disk",
              workspaceId: "ws_disk",
              title: "Thread",
              createdAt: TS,
              lastMessageAt: TS,
              status: "unknown",
            },
          ],
          providerState: {
            statusByName: {
              "codex-cli": {
                provider: "totally-wrong",
                authorized: "yes",
              },
            },
            statusLastUpdatedAt: 123,
          },
          developerMode: "sometimes",
          showHiddenFiles: "always",
        },
        null,
        2,
      ),
      "utf8",
    );

    const loaded = await persistence.loadState();
    expect(loaded.version).toBe(2);
    expect(loaded.workspaces).toEqual([]);
    expect(loaded.threads).toEqual([]);
    expect(loaded.developerMode).toBe(false);
    expect(loaded.showHiddenFiles).toBe(false);
    expect(loaded.providerState).toBeUndefined();
  });

  test("loadState migrates legacy defaultSubAgentModel values from disk", async () => {
    const persistence = new PersistenceService();
    const validWorkspace = path.join(userDataDir, "workspace-legacy-child-model");
    await fs.mkdir(validWorkspace, { recursive: true });

    const statePath = path.join(userDataDir, "state.json");
    await fs.writeFile(
      statePath,
      JSON.stringify(
        {
          version: 2,
          workspaces: [
            {
              id: "ws_legacy_child_model",
              name: "Legacy child model workspace",
              path: validWorkspace,
              createdAt: TS,
              lastOpenedAt: TS,
              defaultProvider: "openai",
              defaultModel: "gpt-5.2",
              defaultSubAgentModel: "gpt-5.2-mini",
              defaultEnableMcp: true,
              defaultBackupsEnabled: true,
              yolo: false,
            },
          ],
          threads: [],
          developerMode: false,
          showHiddenFiles: false,
        },
        null,
        2,
      ),
      "utf8",
    );

    const loaded = await persistence.loadState();
    expect(loaded.workspaces[0]?.defaultPreferredChildModel).toBe("gpt-5.2-mini");
  });

  test("loadState recovers from invalid JSON", async () => {
    const persistence = new PersistenceService();

    const statePath = path.join(userDataDir, "state.json");
    await fs.writeFile(statePath, "{not-json", "utf8");

    const loaded = await persistence.loadState();
    expect(loaded).toEqual({
      version: 2,
      workspaces: [],
      threads: [],
      developerMode: false,
      showHiddenFiles: false,
      perWorkspaceSettings: false,
      providerUiState: {
        lmstudio: {
          enabled: false,
          hiddenModels: [],
        },
      },
    });
  });

  test("readTranscript skips malformed lines", async () => {
    const persistence = new PersistenceService();
    const transcriptDir = path.join(userDataDir, "transcripts");
    await fs.mkdir(transcriptDir, { recursive: true });
    const transcriptPath = path.join(transcriptDir, "thread_1.jsonl");

    const validEventA = JSON.stringify({ ts: TS, threadId: "thread_1", direction: "server", payload: { type: "log", line: "a" } });
    const invalidJson = "{not-json";
    const invalidShape = JSON.stringify({ ts: TS, threadId: "thread_1", direction: "sideways", payload: {} });
    const validEventB = JSON.stringify({ ts: TS, threadId: "thread_1", direction: "client", payload: { type: "ping" } });
    await fs.writeFile(transcriptPath, `${validEventA}\n${invalidJson}\n${invalidShape}\n${validEventB}\n`, "utf8");

    const transcript = await persistence.readTranscript("thread_1");
    expect(transcript).toHaveLength(2);
    expect(transcript[0]?.direction).toBe("server");
    expect(transcript[1]?.direction).toBe("client");
  });

  test("loadState migrates legacy desktop user data into Cowork on first access", async () => {
    const persistence = new PersistenceService();
    const legacyDir = path.join(appDataDir, "desktop");
    const legacyWorkspace = path.join(legacyDir, "workspace-from-legacy");
    const legacyTranscriptDir = path.join(legacyDir, "transcripts");
    await fs.mkdir(legacyWorkspace, { recursive: true });
    await fs.mkdir(legacyTranscriptDir, { recursive: true });

    await fs.writeFile(
      path.join(legacyDir, "state.json"),
      JSON.stringify(
        {
          version: 2,
          workspaces: [
            {
              id: "ws_legacy",
              name: "Legacy workspace",
              path: legacyWorkspace,
              createdAt: TS,
              lastOpenedAt: TS,
              defaultEnableMcp: true,
              yolo: false,
            },
          ],
          threads: [
            {
              id: "thread_legacy",
              workspaceId: "ws_legacy",
              title: "Legacy thread",
              createdAt: TS,
              lastMessageAt: TS,
              status: "active",
              sessionId: null,
              lastEventSeq: 0,
            },
          ],
          developerMode: false,
          showHiddenFiles: false,
        },
        null,
        2,
      ),
      "utf8",
    );
    await fs.writeFile(
      path.join(legacyTranscriptDir, "thread_legacy.jsonl"),
      `${JSON.stringify({ ts: TS, threadId: "thread_legacy", direction: "server", payload: { type: "log" } })}\n`,
      "utf8",
    );

    const loaded = await persistence.loadState();
    const transcript = await persistence.readTranscript("thread_legacy");

    expect(loaded.workspaces).toHaveLength(1);
    expect(loaded.workspaces[0]?.id).toBe("ws_legacy");
    expect(loaded.workspaces[0]?.wsProtocol).toBe("jsonrpc");
    expect(transcript).toHaveLength(1);
    expect(await fs.readFile(path.join(userDataDir, "state.json"), "utf8")).toContain("\"ws_legacy\"");
    expect(await fs.readFile(path.join(userDataDir, "transcripts", "thread_legacy.jsonl"), "utf8")).toContain("\"thread_legacy\"");
  });
});
