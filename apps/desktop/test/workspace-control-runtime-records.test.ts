import { describe, expect, test } from "bun:test";
import {
  mergeWorkspaceProviderOptionsPreservingSearchSettings,
  type WorkspaceProviderOptions,
} from "../src/app/openaiCompatibleProviderOptions";
import {
  resolveWorkspaceRecordWithControlRuntime,
  syncWorkspaceControlRuntimeToRecord,
} from "../src/app/store.actions/workspaceDefaultRecords";
import type { WorkspaceRecord, WorkspaceRuntime } from "../src/app/types";
import { isProviderNameString } from "../src/lib/providerDisplayNames";
import type { ProviderName } from "../src/lib/wsProtocol";

function isProviderName(value: unknown): value is ProviderName {
  return typeof value === "string" && isProviderNameString(value);
}

const workspace = (overrides: Partial<WorkspaceRecord> = {}): WorkspaceRecord => ({
  id: "workspace-1",
  name: "Workspace",
  path: "/workspace/project",
  createdAt: "2026-10-06T00:00:00.000Z",
  lastOpenedAt: "2026-10-06T00:00:00.000Z",
  defaultEnableMcp: true,
  defaultBackupsEnabled: true,
  yolo: false,
  ...overrides,
});

function sessionConfig(
  config: Partial<NonNullable<WorkspaceRuntime["controlSessionConfig"]>> & {
    userName?: unknown;
  },
): NonNullable<WorkspaceRuntime["controlSessionConfig"]> {
  return config as NonNullable<WorkspaceRuntime["controlSessionConfig"]>;
}

function runtime(overrides: {
  controlConfig?: WorkspaceRuntime["controlConfig"];
  controlSessionConfig?: WorkspaceRuntime["controlSessionConfig"];
  controlEnableMcp?: boolean | null;
  controlSessionId?: string | null;
}): WorkspaceRuntime {
  return {
    controlConfig: null,
    controlSessionConfig: null,
    controlEnableMcp: null,
    controlSessionId: null,
    ...overrides,
  } as WorkspaceRuntime;
}

function controlConfig(config: {
  provider?: unknown;
  model?: unknown;
  workingDirectory?: string;
}): NonNullable<WorkspaceRuntime["controlConfig"]> {
  return config as NonNullable<WorkspaceRuntime["controlConfig"]>;
}

describe("mergeWorkspaceProviderOptionsPreservingSearchSettings", () => {
  test("keeps saved search settings that a live session omits and drops other saved settings", () => {
    const saved: WorkspaceProviderOptions = {
      openai: { reasoningEffort: "high" },
      "codex-cli": {
        reasoningEffort: "high",
        webSearchBackend: "exa",
        webSearchFallbackBackend: "parallel",
        webSearchMode: "cached",
        webSearch: { contextSize: "high", allowedDomains: ["docs.example"] },
      },
      google: { nativeWebSearch: true },
    };
    const live: WorkspaceProviderOptions = {
      "codex-cli": { reasoningEffort: "low" },
    };

    expect(mergeWorkspaceProviderOptionsPreservingSearchSettings(saved, live)).toEqual({
      "codex-cli": {
        reasoningEffort: "low",
        webSearchBackend: "exa",
        webSearchFallbackBackend: "parallel",
        webSearchMode: "cached",
        webSearch: { contextSize: "high", allowedDomains: ["docs.example"] },
      },
      google: { nativeWebSearch: true },
    });
  });

  test("lets an explicit live search choice replace the saved one without deep-merging", () => {
    const saved: WorkspaceProviderOptions = {
      "codex-cli": {
        webSearchBackend: "exa",
        webSearch: { contextSize: "high", allowedDomains: ["docs.example"] },
      },
      google: { nativeWebSearch: true },
    };
    const live: WorkspaceProviderOptions = {
      "codex-cli": {
        webSearchBackend: "parallel",
        webSearch: { contextSize: "low" },
      },
      google: { nativeWebSearch: false },
    };

    expect(mergeWorkspaceProviderOptionsPreservingSearchSettings(saved, live)).toEqual({
      "codex-cli": {
        webSearchBackend: "parallel",
        webSearch: { contextSize: "low" },
      },
      google: { nativeWebSearch: false },
    });
  });

  test("treats an invalid live search backend as omitted and ignores a live payload with no editable options", () => {
    const saved: WorkspaceProviderOptions = {
      "codex-cli": { webSearchBackend: "exa" },
    };

    expect(
      mergeWorkspaceProviderOptionsPreservingSearchSettings(saved, {
        "codex-cli": { reasoningEffort: "low", webSearchBackend: "dns" },
      } as WorkspaceProviderOptions),
    ).toEqual({
      "codex-cli": { reasoningEffort: "low", webSearchBackend: "exa" },
    });
    expect(
      mergeWorkspaceProviderOptionsPreservingSearchSettings(saved, {
        openai: { reasoningEffort: "sideways" },
      } as WorkspaceProviderOptions),
    ).toEqual(saved);
  });
});

describe("resolveWorkspaceRecordWithControlRuntime", () => {
  test("returns the saved record when there is no control runtime", () => {
    const saved = workspace();
    expect(resolveWorkspaceRecordWithControlRuntime(saved, undefined, isProviderName)).toBe(saved);
  });

  test("prefers a valid saved provider and live child, safety, and search settings", () => {
    const resolved = resolveWorkspaceRecordWithControlRuntime(
      workspace({
        defaultProvider: "google",
        defaultModel: "  ",
        defaultPreferredChildModel: "saved-child",
        defaultPreferredChildModelRef: "google:saved-child",
        defaultChildModelRoutingMode: "same-provider",
        defaultAllowedChildModelRefs: ["google:saved-child"],
        defaultToolOutputOverflowChars: 4_000,
        defaultWorkflowMaxConcurrentAgents: 2,
        userName: "Ada",
        userProfile: { instructions: "saved", work: "saved-work", details: "saved-details" },
        yolo: false,
        defaultBackupsEnabled: true,
        defaultEnableMcp: true,
        providerOptions: {
          openai: { reasoningEffort: "high" },
          "codex-cli": { webSearchBackend: "exa", webSearchMode: "cached" },
          google: { nativeWebSearch: true },
        },
      }),
      runtime({
        controlEnableMcp: false,
        controlConfig: controlConfig({ provider: "openai", model: "  gpt-live  " }),
        controlSessionConfig: sessionConfig({
          preferredChildModel: "  live-child  ",
          preferredChildModelRef: "  openai:live-child  ",
          childModelRoutingMode: "cross-provider-allowlist",
          allowedChildModelRefs: [],
          defaultToolOutputOverflowChars: 100,
          workflowMaxConcurrentAgents: 0,
          userName: "",
          userProfile: { instructions: "be brief" },
          yolo: true,
          defaultBackupsEnabled: false,
          providerOptions: {
            "codex-cli": { reasoningEffort: "low" },
          },
        }),
      }),
      isProviderName,
    );

    expect(resolved).toMatchObject({
      defaultProvider: "google",
      defaultModel: "gpt-live",
      defaultPreferredChildModel: "live-child",
      defaultPreferredChildModelRef: "openai:live-child",
      defaultChildModelRoutingMode: "cross-provider-allowlist",
      defaultAllowedChildModelRefs: [],
      defaultToolOutputOverflowChars: 100,
      defaultWorkflowMaxConcurrentAgents: 0,
      userName: "",
      userProfile: { instructions: "be brief", work: "", details: "" },
      yolo: true,
      defaultBackupsEnabled: false,
      defaultEnableMcp: false,
      providerOptions: {
        "codex-cli": {
          reasoningEffort: "low",
          webSearchBackend: "exa",
          webSearchMode: "cached",
        },
        google: { nativeWebSearch: true },
      },
    });
  });

  test("falls back through invalid providers and missing live safety fields", () => {
    const resolved = resolveWorkspaceRecordWithControlRuntime(
      workspace({
        defaultProvider: "not-a-provider" as ProviderName,
        defaultModel: "   ",
        defaultPreferredChildModel: "  saved-child  ",
        userName: "Ada",
        userProfile: { instructions: "saved", work: "", details: "" },
        yolo: true,
        defaultBackupsEnabled: false,
        defaultEnableMcp: false,
        defaultToolOutputOverflowChars: 4_000,
      }),
      runtime({
        controlEnableMcp: null,
        controlConfig: controlConfig({ provider: "openai", model: "   " }),
        controlSessionConfig: sessionConfig({
          preferredChildModel: "   ",
          defaultToolOutputOverflowChars: null,
          userName: 12,
        }),
      }),
      isProviderName,
    );

    expect(resolved).toMatchObject({
      defaultProvider: "openai",
      defaultModel: "   ",
      defaultPreferredChildModel: "saved-child",
      defaultPreferredChildModelRef: "openai:saved-child",
      defaultChildModelRoutingMode: "same-provider",
      defaultAllowedChildModelRefs: [],
      defaultToolOutputOverflowChars: 4_000,
      userName: "Ada",
      userProfile: { instructions: "saved", work: "", details: "" },
      yolo: true,
      defaultBackupsEnabled: false,
      defaultEnableMcp: false,
    });
  });

  test("keeps an invalid saved provider when control has no valid provider", () => {
    const resolved = resolveWorkspaceRecordWithControlRuntime(
      workspace({ defaultProvider: "not-a-provider" as ProviderName, defaultModel: "local" }),
      runtime({
        controlConfig: controlConfig({ provider: "also-invalid", model: 3 }),
      }),
      isProviderName,
    );

    expect(resolved.defaultProvider).toBe("not-a-provider");
    expect(resolved.defaultModel).toBe("local");
    expect(resolved.defaultPreferredChildModel).toBe("local");
    expect(resolved.defaultPreferredChildModelRef).toBe("not-a-provider:local");
  });
});

describe("syncWorkspaceControlRuntimeToRecord", () => {
  test("does not invent control config for a workspace that has not connected", () => {
    const source = workspace({
      defaultProvider: "openai",
      defaultModel: "gpt-live",
      defaultEnableMcp: false,
      yolo: true,
    });
    const current = runtime({});

    const synced = syncWorkspaceControlRuntimeToRecord(current, source, isProviderName);

    expect(synced.controlConfig).toBeNull();
    expect(synced.controlSessionConfig).toBeNull();
    expect(synced.controlEnableMcp).toBeNull();
    expect(synced).not.toBe(current);
  });

  test("leaves a connected config unchanged when the source provider or model is unusable", () => {
    const currentConfig = controlConfig({
      provider: "google",
      model: "gemini-saved",
      workingDirectory: "/workspace/project",
    });
    const current = runtime({
      controlConfig: currentConfig,
      controlEnableMcp: null,
      controlSessionId: null,
    });

    const missingModel = syncWorkspaceControlRuntimeToRecord(
      current,
      workspace({ defaultProvider: "openai", defaultModel: "   " }),
      isProviderName,
    );
    const invalidProvider = syncWorkspaceControlRuntimeToRecord(
      current,
      workspace({
        defaultProvider: "not-a-provider" as ProviderName,
        defaultModel: "gpt-live",
      }),
      isProviderName,
    );

    expect(missingModel.controlConfig).toBe(currentConfig);
    expect(invalidProvider.controlConfig).toBe(currentConfig);
    expect(missingModel.controlEnableMcp).toBeNull();
  });

  test("copies global settings onto a live session and clears omitted memory fields", () => {
    const allowedRefs = ["openai:live-child"];
    const excludedSkills = ["beta", "alpha"];
    const source = workspace({
      defaultProvider: "openai",
      defaultModel: "  gpt-live  ",
      defaultPreferredChildModel: "   ",
      defaultPreferredChildModelRef: "   ",
      defaultAllowedChildModelRefs: allowedRefs,
      defaultToolOutputOverflowChars: 0,
      defaultWorkflowMaxConcurrentAgents: undefined,
      defaultAdvancedMemory: false,
      defaultMemoryGenerationModel: "   ",
      defaultSkillImprovementEnabled: undefined,
      defaultSkillImprovementModel: "  openai:skill  ",
      defaultSkillImprovementScope: undefined,
      defaultSkillImprovementExcludedSkills: excludedSkills,
      providerOptions: {
        "codex-cli": { webSearchBackend: "exa", reasoningEffort: "sideways" },
      } as WorkspaceProviderOptions,
      userName: undefined,
      userProfile: undefined,
      yolo: true,
      defaultBackupsEnabled: false,
      defaultEnableMcp: false,
    });
    const current = runtime({
      controlSessionId: "control-1",
      controlEnableMcp: null,
      controlConfig: controlConfig({
        provider: "google",
        model: "gemini-old",
        workingDirectory: "/workspace/project",
      }),
      controlSessionConfig: sessionConfig({
        preferredChildModel: "old-child",
        preferredChildModelRef: "google:old-child",
        childModelRoutingMode: "cross-provider-allowlist",
        allowedChildModelRefs: ["google:old-child"],
        defaultToolOutputOverflowChars: 8_000,
        workflowMaxConcurrentAgents: 3,
        advancedMemory: true,
        memoryGenerationModel: "google:memory-old",
        skillImprovementEnabled: true,
        skillImprovementModel: "google:skill-old",
        skillImprovementScope: "user",
        skillImprovementExcludedSkills: ["old"],
        yolo: false,
        defaultBackupsEnabled: true,
        userName: "Old",
        userProfile: { instructions: "old", work: "old", details: "old" },
        providerOptions: { google: { nativeWebSearch: true } },
      }),
    });

    const synced = syncWorkspaceControlRuntimeToRecord(current, source, isProviderName);
    allowedRefs.push("openai:mutated");
    excludedSkills.push("gamma");

    expect(synced.controlConfig).toMatchObject({
      provider: "openai",
      model: "gpt-live",
      workingDirectory: "/workspace/project",
    });
    expect(current.controlConfig).toMatchObject({ provider: "google", model: "gemini-old" });
    expect(synced.controlEnableMcp).toBe(false);
    expect(synced.controlSessionConfig).toMatchObject({
      yolo: true,
      defaultBackupsEnabled: false,
      preferredChildModel: "gpt-live",
      preferredChildModelRef: "openai:gpt-live",
      childModelRoutingMode: "same-provider",
      allowedChildModelRefs: ["openai:live-child"],
      defaultToolOutputOverflowChars: 0,
      workflowMaxConcurrentAgents: 3,
      advancedMemory: false,
      skillImprovementEnabled: true,
      skillImprovementModel: "openai:skill",
      skillImprovementScope: "user",
      skillImprovementExcludedSkills: ["beta", "alpha"],
      providerOptions: { "codex-cli": { webSearchBackend: "exa" } },
      userName: "",
      userProfile: { instructions: "", work: "", details: "" },
    });
    expect(synced.controlSessionConfig).not.toHaveProperty("memoryGenerationModel");
    expect(current.controlSessionConfig?.memoryGenerationModel).toBe("google:memory-old");
    expect(current.controlSessionConfig?.skillImprovementModel).toBe("google:skill-old");
    expect(current.controlSessionConfig?.defaultToolOutputOverflowChars).toBe(8_000);
  });

  test("keeps the live child ref and drops overflow when the source cannot replace them", () => {
    const synced = syncWorkspaceControlRuntimeToRecord(
      runtime({
        controlEnableMcp: false,
        controlSessionId: null,
        controlConfig: controlConfig({ provider: "google", model: "gemini-old" }),
        controlSessionConfig: sessionConfig({
          preferredChildModelRef: "google:old-child",
          defaultToolOutputOverflowChars: 8_000,
          memoryGenerationModel: "google:memory-old",
          skillImprovementModel: "google:skill-old",
          workflowMaxConcurrentAgents: 4,
          advancedMemory: true,
        }),
      }),
      workspace({
        defaultProvider: "not-a-provider" as ProviderName,
        defaultModel: "gpt-live",
        defaultEnableMcp: true,
      }),
      isProviderName,
    );

    expect(synced.controlConfig).toMatchObject({ provider: "google", model: "gemini-old" });
    expect(synced.controlEnableMcp).toBe(true);
    expect(synced.controlSessionConfig?.preferredChildModel).toBe("gpt-live");
    expect(synced.controlSessionConfig?.preferredChildModelRef).toBe("google:old-child");
    expect(synced.controlSessionConfig).not.toHaveProperty("defaultToolOutputOverflowChars");
    expect(synced.controlSessionConfig).not.toHaveProperty("memoryGenerationModel");
    expect(synced.controlSessionConfig).not.toHaveProperty("skillImprovementModel");
    expect(synced.controlSessionConfig?.workflowMaxConcurrentAgents).toBe(4);
    expect(synced.controlSessionConfig?.advancedMemory).toBe(true);
    expect(synced.controlSessionConfig?.skillImprovementExcludedSkills).toEqual([]);
    expect(synced.controlSessionConfig?.providerOptions).toEqual({});
  });
});
