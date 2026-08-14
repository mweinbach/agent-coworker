import { describe, expect, test } from "bun:test";

import type { ProviderCatalogPayload } from "../src/providers/connectionCatalog";
import { runCreationPreflight } from "../src/server/readiness/creationPreflight";
import type { CreationPreflightParams } from "../src/shared/creationReadiness";
import type { AgentConfig } from "../src/types";

const config = {
  provider: "google",
  model: "gemini-2.5-flash",
  workingDirectory: "/tmp/project",
  skillsDirs: [],
} as AgentConfig;

function preflight(
  params: CreationPreflightParams,
  overrides: Partial<Parameters<typeof runCreationPreflight>[1]> = {},
) {
  return runCreationPreflight(params, {
    config,
    resolveWorkspace: () => "/tmp/project",
    getProviderCatalog: async () => {
      throw new Error("catalog not stubbed");
    },
    getRuntimeStartup: () => ({ ready: true }),
    ...overrides,
  });
}

describe("creation readiness provider reachability", () => {
  test("blocks an unreachable provider before credentials or model checks", async () => {
    const catalog: ProviderCatalogPayload = {
      all: [
        {
          id: "google",
          name: "Google",
          defaultModel: "gemini-2.5-flash",
          state: "unreachable",
          message: "Google API is not reachable from this host.",
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

    const result = await preflight(
      { kind: "chat", provider: "google", model: "gemini-2.5-flash" },
      { getProviderCatalog: async () => catalog },
    );

    expect(result.ready).toBe(false);
    expect(result.checks.find((entry) => entry.id === "provider_connected")).toEqual({
      id: "provider_connected",
      status: "blocked",
      message: "Google API is not reachable from this host.",
      repairAction: { type: "openProviderSettings", provider: "google" },
    });
    expect(result.checks.find((entry) => entry.id === "credentials")?.status).toBe("ok");
    expect(result.checks.find((entry) => entry.id === "model_available")?.status).toBe("ok");
  });

  test("blocks a provider that is missing from the catalog", async () => {
    const catalog: ProviderCatalogPayload = {
      all: [
        {
          id: "openai",
          name: "OpenAI",
          defaultModel: "gpt-5.2",
          state: "ready",
          models: [
            {
              id: "gpt-5.2",
              displayName: "GPT-5.2",
              knowledgeCutoff: "Unknown",
              supportsImageInput: true,
            },
          ],
        },
      ],
      default: { openai: "gpt-5.2" },
      connected: ["openai"],
    };

    const result = await preflight(
      { kind: "chat", provider: "google", model: "gemini-2.5-flash" },
      { getProviderCatalog: async () => catalog },
    );

    expect(result.ready).toBe(false);
    expect(result.checks.find((entry) => entry.id === "provider_connected")).toEqual({
      id: "provider_connected",
      status: "blocked",
      message: "Provider google is unavailable.",
      repairAction: { type: "openProviderSettings", provider: "google" },
    });
    expect(result.checks.find((entry) => entry.id === "credentials")).toMatchObject({
      status: "blocked",
      repairAction: { type: "connectProvider", provider: "google" },
    });
    expect(result.checks.find((entry) => entry.id === "model_available")).toMatchObject({
      status: "blocked",
      repairAction: { type: "openProviderSettings", provider: "google" },
    });
  });

  test("still fail-closes when a catalog load throws a non-Error value", async () => {
    const result = await preflight(
      { kind: "chat", provider: "google", model: "gemini-2.5-flash" },
      {
        getProviderCatalog: async () => {
          throw "catalog exploded";
        },
      },
    );

    expect(result.ready).toBe(false);
    expect(result.checks.map((entry) => entry.id)).toEqual([
      "project_access",
      "provider_connected",
      "runtime_ready",
    ]);
    expect(result.checks.find((entry) => entry.id === "provider_connected")).toEqual({
      id: "provider_connected",
      status: "blocked",
      message: "Provider status could not be loaded: catalog exploded",
      repairAction: { type: "openProviderSettings", provider: "google" },
    });
    expect(result.checks.find((entry) => entry.id === "runtime_ready")?.status).toBe("ok");
  });
});
