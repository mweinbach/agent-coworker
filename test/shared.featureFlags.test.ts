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
        a2ui: true,
      },
    });
    expect(flags.remoteAccess).toBe(true);
    expect(flags.workspacePicker).toBe(false);
    expect(flags.workspaceLifecycle).toBe(false);
    expect(flags.a2ui).toBe(true);
  });

  test("preserves supported persisted overrides in packaged (production) builds", () => {
    const flags = resolveFeatureFlags({
      isPackaged: true,
      overrides: {
        remoteAccess: true,
        workspacePicker: false,
        workspaceLifecycle: false,
        a2ui: true,
      },
    });
    expect(flags.remoteAccess).toBe(false);
    expect(flags.workspacePicker).toBe(false);
    expect(flags.workspaceLifecycle).toBe(false);
    expect(flags.a2ui).toBe(true);
  });

  test("unpackaged: persisted override wins over env for remote access (last write)", () => {
    const flags = resolveFeatureFlags({
      isPackaged: false,
      env: { COWORK_ENABLE_REMOTE_ACCESS: "1" },
      overrides: { remoteAccess: false },
    });
    expect(flags.remoteAccess).toBe(false);
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
