import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import fs from "node:fs/promises";
import path from "node:path";

import { scratchRoots } from "../../../src/platform/sandbox";
import { pinHome } from "../../../test/helpers/platform";
import { createElectronMock, setElectronMockOverrides } from "./helpers/mockElectron";

let userDataDir = "";
let appDataDir = "";
let restoreHome: (() => void) | null = null;

const electronMockOverrides = {
  app: {
    getPath: (name: string) => (name === "appData" ? appDataDir : userDataDir),
  },
  BrowserWindow: {
    getAllWindows: () => [],
    fromWebContents: () => null,
    getFocusedWindow: () => null,
  },
  Menu: {
    buildFromTemplate() {
      return {
        popup() {},
      };
    },
  },
};

setElectronMockOverrides(electronMockOverrides);

mock.module("electron", () => createElectronMock());

const { PersistenceService } = await import("../electron/services/persistence");

const TS = "2024-01-01T00:00:00.000Z";

async function writeState(payload: unknown): Promise<void> {
  await fs.writeFile(
    path.join(userDataDir, "state.json"),
    JSON.stringify(payload, null, 2),
    "utf8",
  );
}

async function createWorkspaceDir(name: string): Promise<string> {
  const workspacePath = path.join(userDataDir, name);
  await fs.mkdir(workspacePath, { recursive: true });
  return workspacePath;
}

describe("desktop persistence electron disk edges", () => {
  beforeEach(() => {
    setElectronMockOverrides(electronMockOverrides);
  });

  beforeEach(async () => {
    const [scratchRoot] = scratchRoots();
    if (!scratchRoot) {
      throw new Error("No platform scratch root is available for persistence disk-edge tests.");
    }
    appDataDir = await fs.mkdtemp(path.join(scratchRoot, "cowork-desktop-disk-edges-"));
    restoreHome = pinHome(appDataDir);
    userDataDir = path.join(appDataDir, "Cowork");
    await fs.mkdir(userDataDir, { recursive: true });
  });

  afterEach(async () => {
    if (appDataDir) {
      await fs.rm(appDataDir, { recursive: true, force: true });
    }
    restoreHome?.();
    restoreHome = null;
    userDataDir = "";
    appDataDir = "";
  });

  test("loadState drops unknown child routing modes and keeps sibling routing fields", async () => {
    const persistence = new PersistenceService();
    const workspacePath = await createWorkspaceDir("workspace-invalid-routing");

    await writeState({
      version: 2,
      workspaces: [
        {
          id: "ws_invalid_routing",
          name: "Invalid routing workspace",
          path: workspacePath,
          createdAt: TS,
          lastOpenedAt: TS,
          defaultProvider: "codex-cli",
          defaultModel: "gpt-5.4",
          defaultPreferredChildModel: "gpt-5.4",
          defaultChildModelRoutingMode: "bogus-mode",
          defaultPreferredChildModelRef: "opencode-zen:glm-5",
          defaultAllowedChildModelRefs: ["opencode-zen:glm-5", "", 12, "opencode-go:glm-5"],
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
    expect(loaded.workspaces).toHaveLength(1);
    expect(loaded.workspaces[0]?.id).toBe("ws_invalid_routing");
    expect(loaded.workspaces[0]?.defaultChildModelRoutingMode).toBeUndefined();
    expect(loaded.workspaces[0]?.defaultPreferredChildModel).toBe("gpt-5.4");
    expect(loaded.workspaces[0]?.defaultPreferredChildModelRef).toBe("opencode-zen:glm-5");
    expect(loaded.workspaces[0]?.defaultAllowedChildModelRefs).toEqual([
      "opencode-zen:glm-5",
      "opencode-go:glm-5",
    ]);
  });

  test("loadState keeps valid child routing modes from disk", async () => {
    const persistence = new PersistenceService();
    const sameProviderPath = await createWorkspaceDir("workspace-same-provider");
    const allowlistPath = await createWorkspaceDir("workspace-allowlist");

    await writeState({
      version: 2,
      workspaces: [
        {
          id: "ws_same_provider",
          name: "Same provider workspace",
          path: sameProviderPath,
          createdAt: TS,
          lastOpenedAt: TS,
          defaultChildModelRoutingMode: "same-provider",
          defaultEnableMcp: true,
          yolo: false,
        },
        {
          id: "ws_allowlist",
          name: "Allowlist workspace",
          path: allowlistPath,
          createdAt: TS,
          lastOpenedAt: TS,
          defaultChildModelRoutingMode: "cross-provider-allowlist",
          defaultEnableMcp: true,
          yolo: false,
        },
      ],
      threads: [],
    });

    const loaded = await persistence.loadState();
    expect(
      loaded.workspaces.find((workspace) => workspace.id === "ws_same_provider")
        ?.defaultChildModelRoutingMode,
    ).toBe("same-provider");
    expect(
      loaded.workspaces.find((workspace) => workspace.id === "ws_allowlist")
        ?.defaultChildModelRoutingMode,
    ).toBe("cross-provider-allowlist");
  });

  test("loadState coerces invalid thread status and infers titleSource from the title", async () => {
    const persistence = new PersistenceService();
    const workspacePath = await createWorkspaceDir("workspace-thread-coercion");

    await writeState({
      version: 2,
      workspaces: [
        {
          id: "ws_thread_coercion",
          name: "Thread coercion workspace",
          path: workspacePath,
          createdAt: TS,
          lastOpenedAt: TS,
          defaultEnableMcp: true,
          yolo: false,
        },
      ],
      threads: [
        {
          id: "thread_placeholder",
          workspaceId: "ws_thread_coercion",
          title: "New Thread",
          createdAt: TS,
          lastMessageAt: TS,
          status: "unknown",
        },
        {
          id: "thread_custom",
          workspaceId: "ws_thread_coercion",
          title: "Shipping plan",
          titleSource: "not-a-source",
          createdAt: TS,
          lastMessageAt: TS,
        },
        {
          id: "thread_explicit",
          workspaceId: "ws_thread_coercion",
          title: "New Conversation",
          titleSource: "manual",
          createdAt: TS,
          lastMessageAt: TS,
          status: "active",
        },
      ],
    });

    const loaded = await persistence.loadState();
    expect(loaded.threads).toHaveLength(3);

    const placeholder = loaded.threads.find((thread) => thread.id === "thread_placeholder");
    expect(placeholder?.titleSource).toBe("default");
    expect(placeholder?.status).toBe("disconnected");

    const custom = loaded.threads.find((thread) => thread.id === "thread_custom");
    expect(custom?.titleSource).toBe("manual");
    expect(custom?.status).toBe("disconnected");

    const explicit = loaded.threads.find((thread) => thread.id === "thread_explicit");
    expect(explicit?.titleSource).toBe("manual");
    expect(explicit?.status).toBe("active");
  });

  test("loadState keeps the first workspace and thread when ids collide", async () => {
    const persistence = new PersistenceService();
    const firstWorkspace = await createWorkspaceDir("workspace-first");
    const secondWorkspace = await createWorkspaceDir("workspace-second");

    await writeState({
      version: 2,
      workspaces: [
        {
          id: "ws_dup",
          name: "First workspace",
          path: firstWorkspace,
          createdAt: TS,
          lastOpenedAt: TS,
          defaultEnableMcp: true,
          yolo: false,
        },
        {
          id: "ws_dup",
          name: "Second workspace",
          path: secondWorkspace,
          createdAt: TS,
          lastOpenedAt: TS,
          defaultEnableMcp: false,
          yolo: true,
        },
      ],
      threads: [
        {
          id: "thread_dup",
          workspaceId: "ws_dup",
          title: "First thread",
          titleSource: "manual",
          createdAt: TS,
          lastMessageAt: TS,
          status: "active",
        },
        {
          id: "thread_dup",
          workspaceId: "ws_dup",
          title: "Second thread",
          titleSource: "manual",
          createdAt: TS,
          lastMessageAt: TS,
          status: "disconnected",
        },
      ],
    });

    const loaded = await persistence.loadState();
    expect(loaded.workspaces).toHaveLength(1);
    expect(loaded.workspaces[0]?.name).toBe("First workspace");
    expect(loaded.workspaces[0]?.path).toBe(await fs.realpath(firstWorkspace));
    expect(loaded.threads).toHaveLength(1);
    expect(loaded.threads[0]?.title).toBe("First thread");
    expect(loaded.threads[0]?.status).toBe("active");
  });

  test("loadState drops invalid overflow, skill-scope, and provider-option values", async () => {
    const persistence = new PersistenceService();
    const workspacePath = await createWorkspaceDir("workspace-invalid-options");

    await writeState({
      version: 2,
      workspaces: [
        {
          id: "ws_invalid_options",
          name: "Invalid options workspace",
          path: workspacePath,
          createdAt: TS,
          lastOpenedAt: TS,
          defaultToolOutputOverflowChars: "12000",
          defaultSkillImprovementScope: "everyone",
          defaultAllowedChildModelRefs: { model: "gpt-5.4" },
          providerOptions: {
            openai: { reasoningEffort: "ludicrous" },
            "codex-cli": { reasoningEffort: "high", extra: true },
          },
          defaultEnableMcp: true,
          yolo: false,
        },
      ],
      threads: [],
    });

    const loaded = await persistence.loadState();
    const workspace = loaded.workspaces[0];
    expect(workspace?.defaultToolOutputOverflowChars).toBeUndefined();
    expect(workspace?.defaultSkillImprovementScope).toBeUndefined();
    expect(workspace?.defaultAllowedChildModelRefs).toBeUndefined();
    expect(workspace?.providerOptions?.openai).toBeUndefined();
    expect(workspace?.providerOptions?.["codex-cli"]).toEqual({ reasoningEffort: "high" });
  });
});
