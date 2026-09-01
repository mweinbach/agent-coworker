import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import path from "node:path";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";

import { setupJsdom } from "../apps/desktop/test/jsdomHarness";

function mockLocalModule(alias: string, relativePath: string, factory: () => any) {
  mock.module(alias, factory);
  const resolved = path.resolve(relativePath);
  mock.module(resolved, factory);
  mock.module(`${resolved}.ts`, factory);
  mock.module(`${resolved}.tsx`, factory);
}

function normalizeStyle(style: any): any {
  return Array.isArray(style) ? Object.assign({}, ...style.filter(Boolean)) : style;
}

const actualReactNative = require("react-native");
mockLocalModule("react-native", "apps/mobile/node_modules/react-native", () => ({
  ...actualReactNative,
  ActivityIndicator: () => null,
  Text: ({ children, selectable: _selectable, style, ...props }: any) =>
    createElement("span", { ...props, style: normalizeStyle(style) }, children),
  View: ({ children, style, ...props }: any) =>
    createElement("div", { ...props, style: normalizeStyle(style) }, children),
  TextInput: ({ accessibilityLabel, onChangeText, secureTextEntry, value }: any) =>
    createElement("input", {
      "aria-label": accessibilityLabel,
      type: secureTextEntry ? "password" : "text",
      value,
      onInput: (event: { currentTarget: { value: string } }) => {
        onChangeText(event.currentTarget.value);
      },
    }),
  Pressable: ({
    accessibilityLabel,
    accessibilityRole: _accessibilityRole,
    accessibilityState: _accessibilityState,
    children,
    disabled,
    onPress,
    style,
    ...props
  }: any) =>
    createElement(
      "button",
      {
        ...props,
        "aria-label": accessibilityLabel,
        disabled,
        onClick: onPress,
        style: normalizeStyle(typeof style === "function" ? style({ pressed: false }) : style),
      },
      children,
    ),
}));

mockLocalModule(
  "@/features/accessibility/mobile-accessibility",
  "apps/mobile/src/features/accessibility/mobile-accessibility",
  () => ({
    minimumTouchTarget: () => 48,
    useAccessibilityAnnouncement: () => undefined,
  }),
);
mockLocalModule("@/components/ui/screen", "apps/mobile/src/components/ui/screen", () => ({
  Screen: ({ children }: { children?: any }) => createElement("div", null, children),
}));
mockLocalModule("@/components/ui/app-button", "apps/mobile/src/components/ui/app-button", () => ({
  AppButton: ({ accessibilityLabel, children, onPress }: any) =>
    createElement("button", { "aria-label": accessibilityLabel, onClick: onPress }, children),
}));
mockLocalModule(
  "@/components/ui/section-card",
  "apps/mobile/src/components/ui/section-card",
  () => ({
    SectionCard: ({ action, children, description, title }: any) =>
      createElement(
        "section",
        null,
        createElement("h2", null, title),
        description ? createElement("p", null, description) : null,
        action,
        children,
      ),
  }),
);
mockLocalModule("@/components/ui/status-pill", "apps/mobile/src/components/ui/status-pill", () => ({
  StatusPill: ({ label }: { label: string }) => createElement("span", null, label),
}));
mockLocalModule("@/theme/use-app-theme", "apps/mobile/src/theme/use-app-theme", () => ({
  useAppTheme: () => ({
    accent: "#246",
    border: "#ddd",
    danger: "#f33",
    dangerMuted: "#fbb",
    primary: "#36f",
    primaryText: "#fff",
    success: "#080",
    surfaceElevated: "#eee",
    surfaceMuted: "#ddd",
    text: "#111",
    textSecondary: "#555",
    textTertiary: "#777",
  }),
}));

const actualProviderStore = require("../apps/mobile/src/features/cowork/providerStore");
const actualWorkspaceStore = require("../apps/mobile/src/features/cowork/workspaceStore");
const actualPairingStore = require("../apps/mobile/src/features/pairing/pairingStore");
const realUseProviderStore = actualProviderStore.useProviderStore;
const realUseWorkspaceStore = actualWorkspaceStore.useWorkspaceStore;
const realUsePairingStore = actualPairingStore.usePairingStore;
const mockSaveApiKey = mock(async (_provider: string, _method: string, _value: string) => true);
const mockCompleteOauth = mock(async (_provider: string, _method: string, _value?: string) => true);
const mockRefresh = mock(async () => {});
let mockProviderState: any;

mockLocalModule(
  "@/features/cowork/providerStore",
  "apps/mobile/src/features/cowork/providerStore",
  () => ({
    useProviderStore: (selector: any) => selector(mockProviderState),
  }),
);
mockLocalModule(
  "@/features/cowork/workspaceStore",
  "apps/mobile/src/features/cowork/workspaceStore",
  () => ({
    useWorkspaceStore: (selector: any) =>
      selector({
        activeWorkspaceName: "Desktop project",
        activeWorkspaceCwd: "/workspace",
        controlSnapshot: { config: { provider: "google", model: "gemini" } },
      }),
  }),
);
mockLocalModule(
  "@/features/pairing/pairingStore",
  "apps/mobile/src/features/pairing/pairingStore",
  () => ({
    usePairingStore: (selector: any) =>
      selector({ connectionState: { status: "connected", transportMode: "native" } }),
  }),
);

const ProvidersScreen = (
  await import("../apps/mobile/src/app/(app)/(tabs)/(settings)/settings/providers")
).default;

async function changeInput(
  input: HTMLInputElement,
  value: string,
  dom: ReturnType<typeof setupJsdom>["dom"],
) {
  await act(async () => {
    const descriptor = Object.getOwnPropertyDescriptor(
      dom.window.HTMLInputElement.prototype,
      "value",
    );
    descriptor?.set?.call(input, value);
    input.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
  });
}

describe("mobile provider setup recovery", () => {
  beforeEach(() => {
    mockSaveApiKey.mockReset();
    mockSaveApiKey.mockImplementation(async () => true);
    mockCompleteOauth.mockReset();
    mockCompleteOauth.mockImplementation(async () => true);
    mockRefresh.mockClear();
    mockProviderState = {
      catalog: [
        {
          id: "google",
          name: "Google",
          defaultModel: "gemini",
          models: [
            {
              id: "gemini",
              displayName: "Gemini",
              knowledgeCutoff: "2025-01",
              supportsImageInput: false,
            },
          ],
        },
      ],
      authMethodsByProvider: {
        google: [
          { id: "api-key", type: "api", label: "API key" },
          { id: "oauth", type: "oauth", label: "Sign in with Google" },
        ],
      },
      statusByProvider: {
        google: {
          provider: "google",
          authorized: false,
          verified: false,
          mode: "missing",
          message: "Provider setup required",
          account: null,
          checkedAt: "2026-08-01T00:00:00.000Z",
        },
      },
      loading: false,
      error: null,
      refresh: mockRefresh,
      selectDefaultModel: async () => {},
      setApiKey: mockSaveApiKey,
      authorize: async () => {},
      callback: mockCompleteOauth,
      logout: async () => {},
      lastAuthChallenge: null,
      lastAuthResult: null,
    };
  });

  afterAll(() => {
    mockLocalModule(
      "@/features/cowork/providerStore",
      "apps/mobile/src/features/cowork/providerStore",
      () => ({ useProviderStore: realUseProviderStore }),
    );
    mockLocalModule(
      "@/features/cowork/workspaceStore",
      "apps/mobile/src/features/cowork/workspaceStore",
      () => ({ useWorkspaceStore: realUseWorkspaceStore }),
    );
    mockLocalModule(
      "@/features/pairing/pairingStore",
      "apps/mobile/src/features/pairing/pairingStore",
      () => ({ usePairingStore: realUsePairingStore }),
    );
  });

  test.each(["android", "ios"] as const)(
    "%s preserves an uncommitted provider key and retries its exact value",
    async (_platform) => {
      const fixtureValue = "fixture-provider-value";
      mockSaveApiKey.mockImplementationOnce(async () => {
        mockProviderState.error = "Desktop disconnected before saving provider configuration.";
        return false;
      });
      const harness = setupJsdom();
      let root: ReturnType<typeof createRoot> | null = null;

      try {
        const container = harness.dom.window.document.getElementById("root");
        if (!container) throw new Error("missing root container");
        root = createRoot(container);
        await act(async () => {
          root!.render(createElement(ProvidersScreen));
        });
        const expand = container.querySelector('[aria-label="Show Google details"]');
        if (!(expand instanceof harness.dom.window.HTMLElement)) {
          throw new Error("missing provider details action");
        }
        await act(async () => {
          expand.click();
        });
        const input = container.querySelector('[aria-label="Google API key"]');
        if (!(input instanceof harness.dom.window.HTMLInputElement)) {
          throw new Error("missing provider key input");
        }
        await changeInput(input, fixtureValue, harness.dom);
        const save = container.querySelector('[aria-label="Save Google API key"]');
        if (!(save instanceof harness.dom.window.HTMLButtonElement)) {
          throw new Error("missing provider save action");
        }

        await act(async () => {
          save.click();
          await Promise.resolve();
          await Promise.resolve();
        });
        expect(input.value).toBe(fixtureValue);
        expect(save.disabled).toBe(false);
        expect(container.textContent).toContain(
          "Desktop disconnected before saving provider configuration.",
        );

        await act(async () => {
          save.click();
          await Promise.resolve();
          await Promise.resolve();
        });
        expect(mockSaveApiKey.mock.calls).toEqual([
          ["google", "api-key", fixtureValue],
          ["google", "api-key", fixtureValue],
        ]);
        expect(input.value).toBe("");
      } finally {
        if (root) {
          await act(async () => {
            root!.unmount();
          });
        }
        harness.restore();
      }
    },
  );

  test.each(["android", "ios"] as const)(
    "%s retains an OAuth code and challenge after a rejected authorization attempt",
    async (_platform) => {
      const fixtureCode = "fixture-oauth-code";
      mockProviderState.lastAuthChallenge = {
        provider: "google",
        methodId: "oauth",
        instructions: "Paste the authorization code from your browser.",
      };
      mockCompleteOauth.mockImplementationOnce(async () => {
        mockProviderState.error = "Authorization code expired. Try again.";
        return false;
      });
      const harness = setupJsdom();
      let root: ReturnType<typeof createRoot> | null = null;

      try {
        const container = harness.dom.window.document.getElementById("root");
        if (!container) throw new Error("missing root container");
        root = createRoot(container);
        await act(async () => {
          root!.render(createElement(ProvidersScreen));
        });
        const expand = container.querySelector('[aria-label="Show Google details"]');
        if (!(expand instanceof harness.dom.window.HTMLElement)) {
          throw new Error("missing provider details action");
        }
        await act(async () => {
          expand.click();
        });
        const input = container.querySelector('[aria-label="Google authorization code"]');
        if (!(input instanceof harness.dom.window.HTMLInputElement)) {
          throw new Error("missing OAuth code input");
        }
        await changeInput(input, fixtureCode, harness.dom);
        const complete = container.querySelector('[aria-label="Complete Google sign-in"]');
        if (!(complete instanceof harness.dom.window.HTMLButtonElement)) {
          throw new Error("missing OAuth completion action");
        }

        await act(async () => {
          complete.click();
          await Promise.resolve();
          await Promise.resolve();
        });

        expect(input.value).toBe(fixtureCode);
        expect(container.textContent).toContain("Authorization code expired. Try again.");
        expect(container.textContent).toContain("Paste the authorization code from your browser.");

        await act(async () => {
          complete.click();
          await Promise.resolve();
          await Promise.resolve();
        });
        expect(mockCompleteOauth.mock.calls).toEqual([
          ["google", "oauth", fixtureCode],
          ["google", "oauth", fixtureCode],
        ]);
      } finally {
        if (root) {
          await act(async () => {
            root!.unmount();
          });
        }
        harness.restore();
      }
    },
  );
});
