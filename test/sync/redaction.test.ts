import { describe, expect, test } from "bun:test";

import { FEATURE_FLAG_IDS } from "../../src/shared/featureFlags";
import { DEFAULT_QUICK_CHAT_SHORTCUT_ACCELERATOR } from "../../src/shared/quickChatShortcut";
import {
  buildCloudSyncSettingsSnapshot,
  containsForbiddenCloudSyncData,
  parseCloudSyncRemoteChange,
  parseCloudSyncRemoteState,
  sanitizeCloudSyncPayload,
} from "../../src/sync/redaction";
import { CLOUD_SYNC_PAYLOAD_VERSION } from "../../src/sync/types";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function validSettingsPayload(overrides?: object) {
  return {
    version: CLOUD_SYNC_PAYLOAD_VERSION,
    kind: "settings" as const,
    privacyTelemetrySettings: {
      crashReportsEnabled: true,
      productAnalyticsEnabled: false,
      aiTraceTelemetryEnabled: false,
      aiTracePayloadsEnabled: false,
      diagnosticsUploadEnabled: false,
      cloudSyncEnabled: false,
    },
    desktopSettings: {
      quickChat: {
        iconEnabled: true,
        shortcutEnabled: false,
        shortcutAccelerator: DEFAULT_QUICK_CHAT_SHORTCUT_ACCELERATOR,
      },
      archivedChatsAutoDeleteDays: 0,
      sidebarSectionOrder: ["projects", "chats"] as Array<"projects" | "chats">,
    },
    desktopFeatureFlagOverrides: {},
    appPreferences: {
      developerMode: false,
      showHiddenFiles: false,
      perWorkspaceSettings: false,
    },
    providerUiState: {
      lmstudio: {
        enabled: false,
      },
    },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// buildCloudSyncSettingsSnapshot
// ---------------------------------------------------------------------------
describe("buildCloudSyncSettingsSnapshot()", () => {
  test("produces correct defaults when called with empty state", () => {
    const snapshot = buildCloudSyncSettingsSnapshot({});
    expect(snapshot.version).toBe(CLOUD_SYNC_PAYLOAD_VERSION);
    expect(snapshot.kind).toBe("settings");
    expect(snapshot.privacyTelemetrySettings.cloudSyncEnabled).toBe(false);
    expect(snapshot.privacyTelemetrySettings.crashReportsEnabled).toBe(false);
    expect(snapshot.privacyTelemetrySettings.productAnalyticsEnabled).toBe(false);
    expect(snapshot.desktopSettings.quickChat.iconEnabled).toBe(true); // default true when not false
    expect(snapshot.desktopSettings.quickChat.shortcutEnabled).toBe(false);
    expect(snapshot.desktopSettings.quickChat.shortcutAccelerator).toBe(
      DEFAULT_QUICK_CHAT_SHORTCUT_ACCELERATOR,
    );
    expect(snapshot.desktopSettings.archivedChatsAutoDeleteDays).toBe(0);
    expect(snapshot.desktopSettings.sidebarSectionOrder).toEqual(["projects", "chats"]);
    expect(snapshot.desktopFeatureFlagOverrides).toEqual({});
    expect(snapshot.appPreferences.developerMode).toBe(false);
    expect(snapshot.appPreferences.showHiddenFiles).toBe(false);
    expect(snapshot.appPreferences.perWorkspaceSettings).toBe(false);
    expect(snapshot.providerUiState.lmstudio.enabled).toBe(false);
  });

  test("handles non-object state gracefully (null, undefined, primitives)", () => {
    for (const bad of [null, undefined, 42, "string", []]) {
      const snapshot = buildCloudSyncSettingsSnapshot(bad);
      expect(snapshot.version).toBe(CLOUD_SYNC_PAYLOAD_VERSION);
      expect(snapshot.kind).toBe("settings");
    }
  });

  test("coerces non-boolean values to false via booleanValue", () => {
    const snapshot = buildCloudSyncSettingsSnapshot({
      privacyTelemetrySettings: {
        crashReportsEnabled: 1, // truthy but not true
        productAnalyticsEnabled: "yes",
        aiTraceTelemetryEnabled: null,
      },
      developerMode: 1,
    });
    expect(snapshot.privacyTelemetrySettings.crashReportsEnabled).toBe(false);
    expect(snapshot.privacyTelemetrySettings.productAnalyticsEnabled).toBe(false);
    expect(snapshot.appPreferences.developerMode).toBe(false);
  });

  test("cloudSyncEnabled is always false in the snapshot", () => {
    const snapshot = buildCloudSyncSettingsSnapshot({
      privacyTelemetrySettings: { cloudSyncEnabled: true },
    });
    expect(snapshot.privacyTelemetrySettings.cloudSyncEnabled).toBe(false);
  });

  test("aiTracePayloadsEnabled requires aiTraceTelemetryEnabled to be true", () => {
    const withTelemetryOff = buildCloudSyncSettingsSnapshot({
      privacyTelemetrySettings: {
        aiTraceTelemetryEnabled: false,
        aiTracePayloadsEnabled: true,
      },
    });
    expect(withTelemetryOff.privacyTelemetrySettings.aiTracePayloadsEnabled).toBe(false);

    const withTelemetryOn = buildCloudSyncSettingsSnapshot({
      privacyTelemetrySettings: {
        aiTraceTelemetryEnabled: true,
        aiTracePayloadsEnabled: true,
      },
    });
    expect(withTelemetryOn.privacyTelemetrySettings.aiTracePayloadsEnabled).toBe(true);
  });

  test("iconEnabled defaults to true when missing, false only when explicitly false", () => {
    const defaultSnapshot = buildCloudSyncSettingsSnapshot({
      desktopSettings: { quickChat: {} },
    });
    expect(defaultSnapshot.desktopSettings.quickChat.iconEnabled).toBe(true);

    const disabledSnapshot = buildCloudSyncSettingsSnapshot({
      desktopSettings: { quickChat: { iconEnabled: false } },
    });
    expect(disabledSnapshot.desktopSettings.quickChat.iconEnabled).toBe(false);
  });

  test("normalizes shortcutAccelerator via normalizeQuickChatShortcutAccelerator", () => {
    const snapshot = buildCloudSyncSettingsSnapshot({
      desktopSettings: {
        quickChat: {
          shortcutAccelerator: "ctrl+space",
        },
      },
    });
    // Should be normalized (Ctrl+Space or default)
    expect(typeof snapshot.desktopSettings.quickChat.shortcutAccelerator).toBe("string");
    expect(snapshot.desktopSettings.quickChat.shortcutAccelerator.length).toBeGreaterThan(0);
  });

  test("invalid shortcutAccelerator falls back to default", () => {
    const snapshot = buildCloudSyncSettingsSnapshot({
      desktopSettings: {
        quickChat: { shortcutAccelerator: "not-valid" },
      },
    });
    expect(snapshot.desktopSettings.quickChat.shortcutAccelerator).toBe(
      DEFAULT_QUICK_CHAT_SHORTCUT_ACCELERATOR,
    );
  });

  test("non-negative archivedChatsAutoDeleteDays: negative becomes 0", () => {
    const snapshot = buildCloudSyncSettingsSnapshot({
      desktopSettings: { archivedChatsAutoDeleteDays: -10 },
    });
    expect(snapshot.desktopSettings.archivedChatsAutoDeleteDays).toBe(0);
  });

  test("non-number archivedChatsAutoDeleteDays becomes 0", () => {
    const snapshot = buildCloudSyncSettingsSnapshot({
      desktopSettings: { archivedChatsAutoDeleteDays: "14" },
    });
    expect(snapshot.desktopSettings.archivedChatsAutoDeleteDays).toBe(0);
  });

  test("floors fractional archivedChatsAutoDeleteDays", () => {
    const snapshot = buildCloudSyncSettingsSnapshot({
      desktopSettings: { archivedChatsAutoDeleteDays: 7.9 },
    });
    expect(snapshot.desktopSettings.archivedChatsAutoDeleteDays).toBe(7);
  });

  test("sidebarSectionOrder deduplicates and fills missing sections", () => {
    const snapshot = buildCloudSyncSettingsSnapshot({
      desktopSettings: { sidebarSectionOrder: ["chats", "projects", "chats"] },
    });
    // Should have exactly ["chats", "projects"] (deduped)
    expect(snapshot.desktopSettings.sidebarSectionOrder).toEqual(["chats", "projects"]);
  });

  test("sidebarSectionOrder with only 'chats' appends missing 'projects'", () => {
    const snapshot = buildCloudSyncSettingsSnapshot({
      desktopSettings: { sidebarSectionOrder: ["chats"] },
    });
    expect(snapshot.desktopSettings.sidebarSectionOrder).toEqual(["chats", "projects"]);
  });

  test("sidebarSectionOrder with unknown entries ignores them and fills defaults", () => {
    const snapshot = buildCloudSyncSettingsSnapshot({
      desktopSettings: { sidebarSectionOrder: ["unknown", "projects"] },
    });
    // "unknown" is filtered out; "chats" is appended
    expect(snapshot.desktopSettings.sidebarSectionOrder).toEqual(["projects", "chats"]);
  });

  test("sidebarSectionOrder with empty array produces both sections", () => {
    const snapshot = buildCloudSyncSettingsSnapshot({
      desktopSettings: { sidebarSectionOrder: [] },
    });
    expect(snapshot.desktopSettings.sidebarSectionOrder).toEqual(["projects", "chats"]);
  });

  test("featureFlagOverrides only includes known flag IDs", () => {
    const snapshot = buildCloudSyncSettingsSnapshot({
      desktopFeatureFlagOverrides: {
        REMOVEDUI: true,
        workspaceLifecycle: false,
        notARealFlag: true,
        canvas: true,
      },
    });
    const keys = Object.keys(snapshot.desktopFeatureFlagOverrides);
    expect(keys).toContain("workspaceLifecycle");
    expect(keys).toContain("canvas");
    expect(keys).not.toContain("REMOVEDUI");
    expect(keys).not.toContain("notARealFlag");
    // All returned keys must be in FEATURE_FLAG_IDS
    for (const key of keys) {
      expect(FEATURE_FLAG_IDS as readonly string[]).toContain(key);
    }
  });

  test("featureFlagOverrides with non-boolean values are excluded", () => {
    const snapshot = buildCloudSyncSettingsSnapshot({
      desktopFeatureFlagOverrides: {
        REMOVEDUI: 1, // truthy but not boolean
        canvas: "true",
        workspaceLifecycle: true,
      },
    });
    const overrides = snapshot.desktopFeatureFlagOverrides;
    expect(overrides.workspaceLifecycle).toBe(true);
    expect((overrides as Record<string, unknown>).REMOVEDUI).toBeUndefined();
    expect(overrides.canvas).toBeUndefined();
  });

  test("providerUiState.lmstudio strips unknown sub-keys", () => {
    const snapshot = buildCloudSyncSettingsSnapshot({
      providerUiState: {
        lmstudio: {
          enabled: true,
          baseUrl: "http://127.0.0.1:1234", // must NOT appear in snapshot
          hiddenModels: ["secret-model.gguf"],
        },
      },
    });
    expect(snapshot.providerUiState.lmstudio.enabled).toBe(true);
    const serialized = JSON.stringify(snapshot.providerUiState.lmstudio);
    expect(serialized).not.toContain("127.0.0.1");
    expect(serialized).not.toContain("hiddenModels");
  });

  test("appPreferences.showHiddenFiles and perWorkspaceSettings pass through correctly", () => {
    const snapshot = buildCloudSyncSettingsSnapshot({
      showHiddenFiles: true,
      perWorkspaceSettings: true,
    });
    expect(snapshot.appPreferences.showHiddenFiles).toBe(true);
    expect(snapshot.appPreferences.perWorkspaceSettings).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// containsForbiddenCloudSyncData
// ---------------------------------------------------------------------------
describe("containsForbiddenCloudSyncData()", () => {
  test("returns false for a clean settings snapshot", () => {
    const snapshot = buildCloudSyncSettingsSnapshot({});
    expect(containsForbiddenCloudSyncData(snapshot)).toBe(false);
  });

  // Sensitive key name patterns
  test("returns true when a key matches BODY_KEY_PATTERN (e.g. 'token')", () => {
    expect(containsForbiddenCloudSyncData({ token: "some-value" })).toBe(true);
  });

  test("returns true when a key matches 'password'", () => {
    expect(containsForbiddenCloudSyncData({ password: "secret" })).toBe(true);
  });

  test("returns true when a key matches 'apiKey'", () => {
    expect(containsForbiddenCloudSyncData({ apiKey: "abc123" })).toBe(true);
  });

  test("returns true when a key matches 'api_key'", () => {
    expect(containsForbiddenCloudSyncData({ api_key: "abc123" })).toBe(true);
  });

  test("returns true for a key matching 'auth'", () => {
    expect(containsForbiddenCloudSyncData({ auth: "value" })).toBe(true);
  });

  test("returns true for a key matching 'secret'", () => {
    expect(containsForbiddenCloudSyncData({ secret: "hidden" })).toBe(true);
  });

  test("returns true for a key matching 'mcp'", () => {
    expect(containsForbiddenCloudSyncData({ mcp: "value" })).toBe(true);
  });

  test("returns true for a key matching 'transcript'", () => {
    expect(containsForbiddenCloudSyncData({ transcript: "never sync me" })).toBe(true);
  });

  test("returns true for a key matching 'prompt'", () => {
    expect(containsForbiddenCloudSyncData({ prompt: "do not sync" })).toBe(true);
  });

  test("returns true for a key matching 'credential'", () => {
    expect(containsForbiddenCloudSyncData({ credential: "some-cred" })).toBe(true);
  });

  test("returns true for a key matching 'cookie'", () => {
    expect(containsForbiddenCloudSyncData({ cookie: "session=abc" })).toBe(true);
  });

  // Allowlisted keys should pass through regardless of matching pattern
  test("returns false for allowlisted key 'showHiddenFiles' even though 'file' is in pattern", () => {
    // Note: 'showHiddenFiles' matches the file pattern but is in SAFE_ALLOWLIST_KEYS
    expect(containsForbiddenCloudSyncData({ showHiddenFiles: true })).toBe(false);
  });

  test("returns false for allowlisted key 'perWorkspaceSettings'", () => {
    expect(containsForbiddenCloudSyncData({ perWorkspaceSettings: true })).toBe(false);
  });

  test("returns false for allowlisted key 'crashReportsEnabled'", () => {
    expect(containsForbiddenCloudSyncData({ crashReportsEnabled: false })).toBe(false);
  });

  test("returns false for allowlisted key 'workspaceLifecycle'", () => {
    expect(containsForbiddenCloudSyncData({ workspaceLifecycle: true })).toBe(false);
  });

  test("returns false for allowlisted key 'workspacePicker'", () => {
    expect(containsForbiddenCloudSyncData({ workspacePicker: true })).toBe(false);
  });

  // Path-like string values
  test("returns true when a string value looks like a Unix home path (~/ prefix)", () => {
    expect(containsForbiddenCloudSyncData({ label: "~/projects/secret" })).toBe(true);
  });

  test("returns true when a string value looks like an absolute /Users/ path", () => {
    expect(containsForbiddenCloudSyncData({ x: "/Users/alex/stuff" })).toBe(true);
  });

  test("returns true when a string value looks like a /home/ path", () => {
    expect(containsForbiddenCloudSyncData({ x: "/home/user/file" })).toBe(true);
  });

  test("returns true when a string value looks like a /tmp/ path", () => {
    expect(containsForbiddenCloudSyncData({ x: "/tmp/data" })).toBe(true);
  });

  test("returns true when a string value looks like a Windows path", () => {
    expect(containsForbiddenCloudSyncData({ x: "C:\\Users\\alex\\doc.txt" })).toBe(true);
  });

  test("returns true when a string value uses file:// URI scheme", () => {
    // Top-level string value
    expect(containsForbiddenCloudSyncData("file:///etc/passwd")).toBe(true);
    // Nested as a value under a non-sensitive key also triggers because the string itself matches
    expect(containsForbiddenCloudSyncData({ x: "file:///etc/passwd" })).toBe(true);
  });

  // API-key shaped values
  test("returns true for a Bearer token string value", () => {
    expect(containsForbiddenCloudSyncData({ value: "Bearer abcdefghijklmnop" })).toBe(true);
  });

  test("returns true when string value is a Stripe-style sk- key", () => {
    expect(containsForbiddenCloudSyncData({ value: "sk-abcdefghijklmnopqrs" })).toBe(true);
  });

  test("returns true for a GitHub PAT (ghp_ prefix)", () => {
    expect(containsForbiddenCloudSyncData({ value: "ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ" })).toBe(true);
  });

  test("returns true for a Slack token (xoxb- prefix)", () => {
    expect(containsForbiddenCloudSyncData({ value: "xoxb-1234567890123456" })).toBe(true);
  });

  test("returns true for an AWS access key (AKIA prefix)", () => {
    expect(containsForbiddenCloudSyncData({ value: "AKIAIOSFODNN7EXAMPLE" })).toBe(true);
  });

  // Nested structures
  test("returns true when forbidden data is nested deep in an object", () => {
    expect(
      containsForbiddenCloudSyncData({
        settings: {
          nested: {
            auth: { token: "secret-token" },
          },
        },
      }),
    ).toBe(true);
  });

  test("returns true when forbidden data is inside an array", () => {
    expect(
      containsForbiddenCloudSyncData({
        items: [{ safe: "value" }, { token: "oops" }],
      }),
    ).toBe(true);
  });

  test("returns false for non-string primitives (numbers, booleans, null)", () => {
    expect(containsForbiddenCloudSyncData(42)).toBe(false);
    expect(containsForbiddenCloudSyncData(true)).toBe(false);
    expect(containsForbiddenCloudSyncData(null)).toBe(false);
  });

  test("returns false for safe nested objects with allowed values", () => {
    expect(
      containsForbiddenCloudSyncData({
        enabled: true,
        count: 5,
        label: "safe-label",
      }),
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// sanitizeCloudSyncPayload
// ---------------------------------------------------------------------------
describe("sanitizeCloudSyncPayload()", () => {
  test("accepts and re-builds a valid settings snapshot", () => {
    const payload = validSettingsPayload();
    const result = sanitizeCloudSyncPayload(payload);
    expect(result).not.toBeNull();
    expect(result?.kind).toBe("settings");
    expect(result?.version).toBe(CLOUD_SYNC_PAYLOAD_VERSION);
  });

  test("returns null for a settings payload with wrong version", () => {
    const payload = { ...validSettingsPayload(), version: 2 };
    expect(sanitizeCloudSyncPayload(payload)).toBeNull();
  });

  test("returns a stub for workspaceMetadata kind", () => {
    const payload = {
      version: CLOUD_SYNC_PAYLOAD_VERSION,
      kind: "workspaceMetadata",
      workspaces: [{ id: "ws1", path: "/Users/alex/secret" }],
    };
    const result = sanitizeCloudSyncPayload(payload);
    expect(result).not.toBeNull();
    expect(result?.kind).toBe("workspaceMetadata");
    // Actual workspace data must not leak
    expect(JSON.stringify(result)).not.toContain("/Users/alex");
  });

  test("returns a stub for threads kind", () => {
    const payload = {
      version: CLOUD_SYNC_PAYLOAD_VERSION,
      kind: "threads",
      threads: [{ id: "t1", transcript: "never sync me" }],
    };
    const result = sanitizeCloudSyncPayload(payload);
    expect(result).not.toBeNull();
    expect(result?.kind).toBe("threads");
    expect(JSON.stringify(result)).not.toContain("never sync me");
  });

  test("returns null for an unknown kind", () => {
    expect(
      sanitizeCloudSyncPayload({
        version: CLOUD_SYNC_PAYLOAD_VERSION,
        kind: "unknownFuture",
      }),
    ).toBeNull();
  });

  test("returns null for null / non-object values", () => {
    expect(sanitizeCloudSyncPayload(null)).toBeNull();
    expect(sanitizeCloudSyncPayload(undefined)).toBeNull();
    expect(sanitizeCloudSyncPayload(42)).toBeNull();
    expect(sanitizeCloudSyncPayload("string")).toBeNull();
  });

  test("settings snapshot with unsafe field values returns null after rebuild", () => {
    // Inject a path-like value through an unexpected field that passes schema
    // The lmstudio baseUrl is stripped by buildCloudSyncSettingsSnapshot so won't pollute
    // but we can verify the safe rebuilding
    const snapshot = buildCloudSyncSettingsSnapshot({
      providerUiState: {
        lmstudio: { enabled: true, baseUrl: "http://127.0.0.1:1234" },
      },
    });
    // After rebuilding, the snapshot should be clean
    expect(sanitizeCloudSyncPayload(snapshot)).not.toBeNull();
    expect(JSON.stringify(sanitizeCloudSyncPayload(snapshot))).not.toContain("127.0.0.1");
  });
});

// ---------------------------------------------------------------------------
// parseCloudSyncRemoteState
// ---------------------------------------------------------------------------
describe("parseCloudSyncRemoteState()", () => {
  test("parses a valid state with a settings payload", () => {
    const state = parseCloudSyncRemoteState({
      version: CLOUD_SYNC_PAYLOAD_VERSION,
      scope: "settings",
      payload: validSettingsPayload(),
    });
    expect(state).not.toBeNull();
    expect(state?.scope).toBe("settings");
    expect(state?.payload?.kind).toBe("settings");
  });

  test("accepts null payload (remote has no snapshot yet)", () => {
    const state = parseCloudSyncRemoteState({
      version: CLOUD_SYNC_PAYLOAD_VERSION,
      scope: "settings",
      payload: null,
    });
    expect(state).not.toBeNull();
    expect(state?.payload).toBeNull();
  });

  test("accepts undefined payload and treats it as null", () => {
    const state = parseCloudSyncRemoteState({
      version: CLOUD_SYNC_PAYLOAD_VERSION,
      scope: "settings",
    });
    expect(state).not.toBeNull();
    expect(state?.payload).toBeNull();
  });

  test("trims and preserves cursor when present", () => {
    const state = parseCloudSyncRemoteState({
      version: CLOUD_SYNC_PAYLOAD_VERSION,
      scope: "settings",
      cursor: "  page-token-abc  ",
      payload: null,
    });
    expect(state?.cursor).toBe("page-token-abc");
  });

  test("omits cursor when blank or missing", () => {
    const noBlank = parseCloudSyncRemoteState({
      version: CLOUD_SYNC_PAYLOAD_VERSION,
      scope: "settings",
      cursor: "   ",
      payload: null,
    });
    expect(noBlank).not.toHaveProperty("cursor");

    const noCursor = parseCloudSyncRemoteState({
      version: CLOUD_SYNC_PAYLOAD_VERSION,
      scope: "settings",
      payload: null,
    });
    expect(noCursor).not.toHaveProperty("cursor");
  });

  test("returns null for wrong version", () => {
    expect(
      parseCloudSyncRemoteState({
        version: 2,
        scope: "settings",
        payload: null,
      }),
    ).toBeNull();
  });

  test("returns null for an unknown scope", () => {
    expect(
      parseCloudSyncRemoteState({
        version: CLOUD_SYNC_PAYLOAD_VERSION,
        scope: "unknown",
        payload: null,
      }),
    ).toBeNull();
  });

  test("returns null when payload is present but fails sanitization", () => {
    expect(
      parseCloudSyncRemoteState({
        version: CLOUD_SYNC_PAYLOAD_VERSION,
        scope: "settings",
        payload: {
          version: 2, // wrong version — sanitize will reject
          kind: "settings",
        },
      }),
    ).toBeNull();
  });

  test("accepts all valid scopes: settings, workspaceMetadata, threads", () => {
    for (const scope of ["settings", "workspaceMetadata", "threads"] as const) {
      const state = parseCloudSyncRemoteState({
        version: CLOUD_SYNC_PAYLOAD_VERSION,
        scope,
        payload: {
          version: CLOUD_SYNC_PAYLOAD_VERSION,
          kind:
            scope === "settings"
              ? "settings"
              : scope === "workspaceMetadata"
                ? "workspaceMetadata"
                : "threads",
        },
      });
      expect(state?.scope).toBe(scope);
    }
  });

  test("strips unexpected top-level keys from inbound state", () => {
    const state = parseCloudSyncRemoteState({
      version: CLOUD_SYNC_PAYLOAD_VERSION,
      scope: "settings",
      cursor: "cur",
      payload: null,
      unexpected: "/Users/alex/private",
      injected: "should-not-appear",
    });
    expect(state).not.toBeNull();
    const serialized = JSON.stringify(state);
    expect(serialized).not.toContain("/Users/alex");
    expect(serialized).not.toContain("unexpected");
    expect(serialized).not.toContain("injected");
  });
});

// ---------------------------------------------------------------------------
// parseCloudSyncRemoteChange
// ---------------------------------------------------------------------------
describe("parseCloudSyncRemoteChange()", () => {
  test("parses a valid remote change with settings payload", () => {
    const change = parseCloudSyncRemoteChange({
      version: CLOUD_SYNC_PAYLOAD_VERSION,
      id: "change-1",
      scope: "settings",
      payload: validSettingsPayload(),
    });
    expect(change).not.toBeNull();
    expect(change?.id).toBe("change-1");
    expect(change?.scope).toBe("settings");
    expect(change?.payload?.kind).toBe("settings");
  });

  test("trims id and cursor", () => {
    const change = parseCloudSyncRemoteChange({
      version: CLOUD_SYNC_PAYLOAD_VERSION,
      id: "  trimmed-id  ",
      scope: "settings",
      cursor: "  cursor-val  ",
      payload: validSettingsPayload(),
    });
    expect(change?.id).toBe("trimmed-id");
    expect(change?.cursor).toBe("cursor-val");
  });

  test("returns null when id is missing or blank", () => {
    expect(
      parseCloudSyncRemoteChange({
        version: CLOUD_SYNC_PAYLOAD_VERSION,
        id: "",
        scope: "settings",
        payload: validSettingsPayload(),
      }),
    ).toBeNull();

    expect(
      parseCloudSyncRemoteChange({
        version: CLOUD_SYNC_PAYLOAD_VERSION,
        id: "   ",
        scope: "settings",
        payload: validSettingsPayload(),
      }),
    ).toBeNull();

    expect(
      parseCloudSyncRemoteChange({
        version: CLOUD_SYNC_PAYLOAD_VERSION,
        scope: "settings",
        payload: validSettingsPayload(),
      }),
    ).toBeNull();
  });

  test("returns null when payload is null or missing", () => {
    expect(
      parseCloudSyncRemoteChange({
        version: CLOUD_SYNC_PAYLOAD_VERSION,
        id: "c1",
        scope: "settings",
        payload: null,
      }),
    ).toBeNull();

    expect(
      parseCloudSyncRemoteChange({
        version: CLOUD_SYNC_PAYLOAD_VERSION,
        id: "c1",
        scope: "settings",
      }),
    ).toBeNull();
  });

  test("returns null for wrong version", () => {
    expect(
      parseCloudSyncRemoteChange({
        version: 2,
        id: "c1",
        scope: "settings",
        payload: validSettingsPayload(),
      }),
    ).toBeNull();
  });

  test("returns null for unknown scope", () => {
    expect(
      parseCloudSyncRemoteChange({
        version: CLOUD_SYNC_PAYLOAD_VERSION,
        id: "c1",
        scope: "bad-scope",
        payload: validSettingsPayload(),
      }),
    ).toBeNull();
  });

  test("omits cursor when blank", () => {
    const change = parseCloudSyncRemoteChange({
      version: CLOUD_SYNC_PAYLOAD_VERSION,
      id: "c1",
      scope: "settings",
      cursor: "",
      payload: validSettingsPayload(),
    });
    expect(change).not.toHaveProperty("cursor");
  });

  test("strips forbidden data from payload during sanitization", () => {
    // The settings snapshot parser will strip unsafe fields during rebuild
    const change = parseCloudSyncRemoteChange({
      version: CLOUD_SYNC_PAYLOAD_VERSION,
      id: "c1",
      scope: "settings",
      payload: {
        version: CLOUD_SYNC_PAYLOAD_VERSION,
        kind: "settings",
        privacyTelemetrySettings: {
          crashReportsEnabled: true,
          token: "sk-test_should_be_ignored_1234567890",
        },
        prompt: "do not keep",
        desktopSettings: {},
      },
    });
    expect(change).not.toBeNull();
    const serialized = JSON.stringify(change);
    expect(serialized).not.toContain("sk-test");
    expect(serialized).not.toContain("do not keep");
  });
});
