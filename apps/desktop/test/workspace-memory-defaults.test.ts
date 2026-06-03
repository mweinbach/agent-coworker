import { describe, expect, test } from "bun:test";

import {
  buildGlobalMemoryDefaultsPatch,
  resolveControlApplyMemoryDefaults,
  resolveThreadApplyMemoryDefaults,
  resolveWorkspaceMemoryDefaultsFromControl,
} from "../src/app/store.actions/workspaceMemoryDefaults";
import type { WorkspaceRecord, WorkspaceRuntime } from "../src/app/types";

const workspace = (overrides: Partial<WorkspaceRecord> = {}): WorkspaceRecord => ({
  id: "workspace-1",
  name: "Workspace",
  path: "/tmp/workspace",
  createdAt: "2026-06-03T00:00:00.000Z",
  lastOpenedAt: "2026-06-03T00:00:00.000Z",
  defaultEnableMcp: true,
  defaultBackupsEnabled: true,
  yolo: false,
  ...overrides,
});

const sessionConfig = (
  config: Partial<NonNullable<WorkspaceRuntime["controlSessionConfig"]>>,
): WorkspaceRuntime["controlSessionConfig"] => config as WorkspaceRuntime["controlSessionConfig"];

describe("workspace memory defaults", () => {
  test("resolves workspace records from live control memory config", () => {
    const resolved = resolveWorkspaceMemoryDefaultsFromControl(
      workspace({
        defaultAdvancedMemory: false,
        defaultMemoryGenerationModel: "google:gemini-saved",
      }),
      sessionConfig({
        advancedMemory: true,
        memoryGenerationModel: "  openai:gpt-5.4  ",
      }),
    );

    expect(resolved.defaultAdvancedMemory).toBe(true);
    expect(resolved.defaultMemoryGenerationModel).toBe("openai:gpt-5.4");
  });

  test("treats an empty live memory generation model as an explicit clear", () => {
    const resolved = resolveWorkspaceMemoryDefaultsFromControl(
      workspace({ defaultMemoryGenerationModel: "google:gemini-saved" }),
      sessionConfig({ memoryGenerationModel: "   " }),
    );

    expect(resolved.defaultMemoryGenerationModel).toBeUndefined();
  });

  test("uses persisted workspace memory defaults for control session applies", () => {
    expect(
      resolveControlApplyMemoryDefaults(
        workspace({
          defaultAdvancedMemory: true,
          defaultMemoryGenerationModel: "  together:moonshotai/Kimi-K2.5  ",
        }),
      ),
    ).toEqual({
      advancedMemory: true,
      memoryGenerationModel: "together:moonshotai/Kimi-K2.5",
    });

    expect(resolveControlApplyMemoryDefaults(workspace({}))).toEqual({
      advancedMemory: undefined,
      memoryGenerationModel: null,
    });
  });

  test("lets thread applies inherit live memory defaults when persisted values are unset", () => {
    const resolved = resolveThreadApplyMemoryDefaults(
      workspace({ defaultAdvancedMemory: undefined, defaultMemoryGenerationModel: undefined }),
      sessionConfig({
        advancedMemory: true,
        memoryGenerationModel: "anthropic:claude-opus-4-8",
      }),
    );

    expect(resolved).toEqual({
      advancedMemory: true,
      memoryGenerationModel: "anthropic:claude-opus-4-8",
    });
  });

  test("clears stale thread memory generation overrides when no default exists", () => {
    expect(resolveThreadApplyMemoryDefaults(workspace({}), sessionConfig({}))).toEqual({
      advancedMemory: undefined,
      memoryGenerationModel: null,
    });
  });

  test("builds a global workspace record patch only for memory default changes", () => {
    const next = workspace({
      defaultAdvancedMemory: true,
      defaultMemoryGenerationModel: "openai:gpt-5.4",
    });

    expect(buildGlobalMemoryDefaultsPatch({ defaultAdvancedMemory: true }, next)).toEqual({
      defaultAdvancedMemory: true,
    });
    expect(
      buildGlobalMemoryDefaultsPatch({ defaultMemoryGenerationModel: "openai:gpt-5.4" }, next),
    ).toEqual({ defaultMemoryGenerationModel: "openai:gpt-5.4" });
    expect(buildGlobalMemoryDefaultsPatch({ defaultModel: "gpt-5.4" }, next)).toEqual({});
  });
});
