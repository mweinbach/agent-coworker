import { describe, expect, mock, test } from "bun:test";

import type { ProviderCatalogPayload } from "../src/providers/connectionCatalog";
import { runCreationPreflight } from "../src/server/readiness/creationPreflight";
import { hasGoogleResearchApiKey } from "../src/server/research/googleApiKey";
import {
  COWORK_RUNTIME_STARTING_MESSAGE,
  type CreationPreflightParams,
} from "../src/shared/creationReadiness";
import type { AgentConfig } from "../src/types";

const config = {
  provider: "google",
  model: "gemini-2.5-flash",
  workingDirectory: "/tmp/project",
  skillsDirs: [],
} as AgentConfig;

const readyCatalog: ProviderCatalogPayload = {
  all: [
    {
      id: "google",
      name: "Google",
      defaultModel: "gemini-2.5-flash",
      state: "ready",
      models: [
        {
          id: "gemini-2.5-flash",
          displayName: "Gemini 2.5 Flash",
          knowledgeCutoff: "Unknown",
          supportsImageInput: true,
        },
      ],
    },
  ],
  default: { google: "gemini-2.5-flash" },
  connected: ["google"],
};

function preflight(
  params: CreationPreflightParams,
  overrides: Partial<Parameters<typeof runCreationPreflight>[1]> = {},
) {
  return runCreationPreflight(params, {
    config,
    resolveWorkspace: () => "/tmp/project",
    getProviderCatalog: async () => readyCatalog,
    getRuntimeStartup: () => ({ ready: true }),
    hasResearchCredentials: () => true,
    ...overrides,
  });
}

describe("creation readiness preflight", () => {
  test("reports every ready chat dependency", async () => {
    const result = await preflight({
      kind: "chat",
      provider: "google",
      model: "gemini-2.5-flash",
    });

    expect(result.ready).toBe(true);
    expect(result.checks.map((entry) => entry.id)).toEqual([
      "project_access",
      "provider_connected",
      "credentials",
      "model_available",
      "runtime_ready",
    ]);
  });

  test("returns an actionable project access failure", async () => {
    const result = await preflight(
      { kind: "chat", provider: "google", model: "gemini-2.5-flash" },
      {
        resolveWorkspace: () => {
          throw new Error("Selected project cannot be accessed.");
        },
      },
    );

    expect(result.ready).toBe(false);
    expect(result.checks).toEqual([
      {
        id: "project_access",
        status: "blocked",
        message: "Selected project cannot be accessed.",
      },
    ]);
  });

  test("distinguishes missing credentials from provider and model availability", async () => {
    const result = await preflight(
      { kind: "chat", provider: "google", model: "gemini-2.5-flash" },
      {
        getProviderCatalog: async () => ({ ...readyCatalog, connected: [] }),
      },
    );

    expect(result.ready).toBe(false);
    expect(result.checks.find((entry) => entry.id === "provider_connected")?.status).toBe("ok");
    expect(result.checks.find((entry) => entry.id === "model_available")?.status).toBe("ok");
    expect(result.checks.find((entry) => entry.id === "credentials")).toMatchObject({
      status: "blocked",
      repairAction: { type: "connectProvider", provider: "google" },
    });
  });

  test("blocks an unavailable or disabled model", async () => {
    const result = await preflight({
      kind: "chat",
      provider: "google",
      model: "removed-model",
    });

    expect(result.ready).toBe(false);
    expect(result.checks.find((entry) => entry.id === "model_available")).toMatchObject({
      status: "blocked",
      repairAction: { type: "openProviderSettings", provider: "google" },
    });
  });

  test("returns an LM Studio runtime repair action", async () => {
    const lmCatalog: ProviderCatalogPayload = {
      all: [
        {
          id: "lmstudio",
          name: "LM Studio",
          defaultModel: "local-model",
          state: "ready",
          models: [
            {
              id: "local-model",
              displayName: "Local Model",
              knowledgeCutoff: "Unknown",
              supportsImageInput: false,
            },
          ],
        },
      ],
      default: { lmstudio: "local-model" },
      connected: ["lmstudio"],
    };
    const result = await preflight(
      { kind: "chat", provider: "lmstudio", model: "local-model" },
      {
        getProviderCatalog: async () => lmCatalog,
        getLmStudioStatus: async () => ({
          installed: true,
          running: false,
          baseUrl: "http://localhost:1234",
          canAutoStart: true,
          checkedAt: "2026-07-12T00:00:00.000Z",
        }),
      },
    );

    expect(result.ready).toBe(false);
    expect(result.checks.find((entry) => entry.id === "runtime_ready")).toMatchObject({
      status: "blocked",
      repairAction: {
        type: "startLmStudio",
        baseUrl: "http://localhost:1234",
        canAutoStart: true,
      },
    });
  });

  test("runs the same dependency set for a task as for a chat", async () => {
    const result = await preflight(
      { kind: "task", provider: "google", model: "gemini-2.5-flash" },
      { isProjectWorkspace: async () => true },
    );

    expect(result.ready).toBe(true);
    expect(result.checks.map((entry) => entry.id)).toEqual([
      "project_access",
      "provider_connected",
      "credentials",
      "model_available",
      "runtime_ready",
    ]);
  });

  test("blocks a task in a workspace that cannot host one", async () => {
    const result = await preflight(
      { kind: "task", provider: "google", model: "gemini-2.5-flash" },
      { isProjectWorkspace: async () => false },
    );

    expect(result.ready).toBe(false);
    expect(result.checks).toEqual([
      {
        id: "project_access",
        status: "blocked",
        message: "Tasks run inside a project workspace. Choose a project instead of a quick chat.",
      },
    ]);
  });

  test("names the task, not a chat, in a blocked task credentials check", async () => {
    const result = await preflight(
      { kind: "task", provider: "google", model: "gemini-2.5-flash" },
      {
        isProjectWorkspace: async () => true,
        getProviderCatalog: async () => ({ ...readyCatalog, connected: [] }),
      },
    );

    expect(result.checks.find((entry) => entry.id === "credentials")).toEqual({
      id: "credentials",
      status: "blocked",
      message: "Connect Google before starting this task.",
      repairAction: { type: "connectProvider", provider: "google" },
    });
  });

  test("keeps a task startable while the startup bootstrap is still pending", async () => {
    const result = await preflight(
      { kind: "task", provider: "google", model: "gemini-2.5-flash" },
      {
        isProjectWorkspace: async () => true,
        getRuntimeStartup: () => ({ ready: false }),
      },
    );

    expect(result.ready).toBe(true);
    expect(result.checks.find((entry) => entry.id === "runtime_ready")).toMatchObject({
      status: "pending",
    });
  });

  test("leaves chat readiness free of the task project-workspace rule", async () => {
    const isProjectWorkspace = mock(async () => false);
    const result = await preflight(
      { kind: "chat", provider: "google", model: "gemini-2.5-flash" },
      { isProjectWorkspace },
    );

    expect(result.ready).toBe(true);
    expect(isProjectWorkspace).not.toHaveBeenCalled();
  });

  test("keeps Research discoverable but blocked without Google credentials", async () => {
    const result = await preflight({ kind: "research" }, { hasResearchCredentials: () => false });

    expect(result.ready).toBe(false);
    expect(result.checks.find((entry) => entry.id === "research_credentials")).toMatchObject({
      status: "blocked",
      repairAction: { type: "connectProvider", provider: "google" },
    });
  });

  test("treats an in-flight startup bootstrap as pending, not as a blocker", async () => {
    const result = await preflight(
      { kind: "chat", provider: "google", model: "gemini-2.5-flash" },
      {
        getRuntimeStartup: () => ({
          ready: false,
          progress: {
            phase: "downloading",
            version: "1.2.3",
            transferredBytes: 62,
            totalBytes: 100,
            percent: 62,
          },
        }),
      },
    );

    expect(result.ready).toBe(true);
    expect(result.checks.find((entry) => entry.id === "runtime_ready")).toEqual({
      id: "runtime_ready",
      status: "pending",
      message: "Downloading the Cowork runtime — 62%.",
    });
  });

  test("names waiting and installing bootstrap phases in the pending message", async () => {
    const waiting = await preflight(
      { kind: "chat", provider: "google", model: "gemini-2.5-flash" },
      {
        getRuntimeStartup: () => ({
          ready: false,
          progress: {
            phase: "waiting",
            version: "1.2.3",
            transferredBytes: 0,
            totalBytes: null,
            percent: null,
          },
        }),
      },
    );
    expect(waiting.checks.find((entry) => entry.id === "runtime_ready")).toEqual({
      id: "runtime_ready",
      status: "pending",
      message: "Another Cowork window is finishing the one-time setup.",
    });

    const installing = await preflight(
      { kind: "chat", provider: "google", model: "gemini-2.5-flash" },
      {
        getRuntimeStartup: () => ({
          ready: false,
          progress: {
            phase: "installing",
            version: "1.2.3",
            transferredBytes: 100,
            totalBytes: 100,
            percent: 100,
          },
        }),
      },
    );
    expect(installing.checks.find((entry) => entry.id === "runtime_ready")).toEqual({
      id: "runtime_ready",
      status: "pending",
      message: "Verifying and installing the Cowork runtime.",
    });

    const downloadWithoutPercent = await preflight(
      { kind: "chat", provider: "google", model: "gemini-2.5-flash" },
      {
        getRuntimeStartup: () => ({
          ready: false,
          progress: {
            phase: "downloading",
            version: "1.2.3",
            transferredBytes: 10,
            totalBytes: null,
            percent: null,
          },
        }),
      },
    );
    expect(downloadWithoutPercent.checks.find((entry) => entry.id === "runtime_ready")).toEqual({
      id: "runtime_ready",
      status: "pending",
      message: "Downloading the Cowork runtime.",
    });
  });

  test("falls back to a generic pending message without bootstrap progress", async () => {
    const result = await preflight(
      { kind: "chat", provider: "google", model: "gemini-2.5-flash" },
      { getRuntimeStartup: () => ({ ready: false }) },
    );

    expect(result.ready).toBe(true);
    expect(result.checks.find((entry) => entry.id === "runtime_ready")).toMatchObject({
      status: "pending",
      message: COWORK_RUNTIME_STARTING_MESSAGE,
    });
  });

  test("still blocks when the startup bootstrap failed", async () => {
    const result = await preflight(
      { kind: "chat", provider: "google", model: "gemini-2.5-flash" },
      { getRuntimeStartup: () => ({ ready: false, error: "runtime archive is corrupt" }) },
    );

    expect(result.ready).toBe(false);
    expect(result.checks.find((entry) => entry.id === "runtime_ready")).toMatchObject({
      status: "blocked",
      message: "Cowork runtime failed to start: runtime archive is corrupt",
    });
  });

  test("accepts the Google API key environment supported by the research runtime", () => {
    expect(
      hasGoogleResearchApiKey(
        {
          ...config,
          userCoworkDir: "/tmp/nonexistent-cowork-home/.cowork",
        },
        { GOOGLE_API_KEY: "test-key" },
      ),
    ).toBe(true);
  });
});
