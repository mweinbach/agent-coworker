import { describe, expect, test } from "bun:test";

import { resolveFeatureFlags } from "../src/shared/featureFlags";

describe("resolveFeatureFlags", () => {
  test("applies persisted overrides in unpackaged (dev) builds", () => {
    const flags = resolveFeatureFlags({
      isPackaged: false,
      overrides: {
        remoteAccess: true,
        workspacePicker: false,
        workspaceLifecycle: false,
        tasks: true,
      },
    });
    expect(flags.remoteAccess).toBe(true);
    expect(flags.workspacePicker).toBe(false);
    expect(flags.workspaceLifecycle).toBe(false);
    expect(flags.tasks).toBe(true);
  });

  test("ignores persisted overrides in packaged (production) builds, using build-time defaults", () => {
    const flags = resolveFeatureFlags({
      isPackaged: true,
      overrides: {
        remoteAccess: true,
        workspacePicker: false,
        workspaceLifecycle: false,
        tasks: true,
      },
    });
    // Packaged builds intentionally drop locally flipped overrides and resolve to
    // each flag's compiled build-time default; a dev flip never leaks to production.
    expect(flags.remoteAccess).toBe(false);
    expect(flags.workspacePicker).toBe(true);
    expect(flags.workspaceLifecycle).toBe(true);
    expect(flags.tasks).toBe(false);
  });

  test("tasks flag: defaults off, dev override/env enable it, packaged ignores override", () => {
    expect(resolveFeatureFlags({ isPackaged: false }).tasks).toBe(false);
    expect(resolveFeatureFlags({ isPackaged: false, overrides: { tasks: true } }).tasks).toBe(true);
    expect(
      resolveFeatureFlags({ isPackaged: false, env: { COWORK_ENABLE_TASKS: "1" } }).tasks,
    ).toBe(true);
    // Packaged: persisted dev override ignored (build-time default), env still honored.
    expect(resolveFeatureFlags({ isPackaged: true, overrides: { tasks: true } }).tasks).toBe(false);
    expect(resolveFeatureFlags({ isPackaged: true, env: { COWORK_ENABLE_TASKS: "1" } }).tasks).toBe(
      true,
    );
  });

  test("unpackaged: persisted override wins over env for remote access (last write)", () => {
    const flags = resolveFeatureFlags({
      isPackaged: false,
      env: { COWORK_ENABLE_REMOTE_ACCESS: "1" },
      overrides: { remoteAccess: false },
    });
    expect(flags.remoteAccess).toBe(false);
  });

  test("unknown legacy overrides are ignored", () => {
    const flags = resolveFeatureFlags({
      isPackaged: false,
      overrides: { REMOVEDUI: true } as any,
    });
    expect((flags as Record<string, unknown>).REMOVEDUI).toBeUndefined();
  });

  test("packaged forced-off still wins over env for remote access", () => {
    const flags = resolveFeatureFlags({
      isPackaged: true,
      env: { COWORK_ENABLE_REMOTE_ACCESS: "1" },
      overrides: { remoteAccess: true },
    });
    expect(flags.remoteAccess).toBe(false);
  });
});
