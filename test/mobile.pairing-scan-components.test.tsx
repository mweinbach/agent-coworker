import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { createRequire } from "node:module";
import path from "node:path";
import {
  act,
  type ComponentType,
  createElement,
  type ReactNode,
  useCallback,
  useState,
} from "react";
import { createRoot } from "react-dom/client";
import { setupJsdom } from "../apps/desktop/test/jsdomHarness";

type CameraPermission = { granted: boolean; canAskAgain: boolean };
let cameraPermission: CameraPermission = { granted: false, canAskAgain: true };
const requestPermission = mock(async () => cameraPermission);
const getPermission = mock(async () => cameraPermission);
const openSettings = mock(async () => undefined);
const alert = mock((_title: string, _message: string) => undefined);
const appStateListeners = new Set<(state: string) => void>();
const mobileRequire = createRequire(path.resolve("apps/mobile/package.json"));

function mockMobileModule(alias: string, factory: () => unknown) {
  mock.module(alias, factory);
  mock.module(mobileRequire.resolve(alias), factory);
}

function mockLocalModule(alias: string, relativePath: string, factory: () => unknown) {
  mock.module(alias, factory);
  const resolved = path.resolve(relativePath);
  mock.module(resolved, factory);
  mock.module(`${resolved}.ts`, factory);
  mock.module(`${resolved}.tsx`, factory);
}

const Container = ({ children }: { children?: ReactNode }) => createElement("div", null, children);
const Button = ({
  children,
  title,
  onPress,
  disabled,
}: {
  children?: ReactNode;
  title?: string;
  onPress?: () => void;
  disabled?: boolean;
}) => createElement("button", { onClick: onPress, disabled }, title ?? children);

mockMobileModule("react-native", () => ({
  Alert: { alert },
  AppState: {
    addEventListener: (_event: string, listener: (state: string) => void) => {
      appStateListeners.add(listener);
      return { remove: () => appStateListeners.delete(listener) };
    },
  },
  Linking: { openSettings },
  Pressable: Button,
  Text: Container,
  TextInput: ({ accessibilityLabel }: { accessibilityLabel?: string }) =>
    createElement("textarea", { "aria-label": accessibilityLabel }),
  View: Container,
}));
mockMobileModule("expo-camera", () => ({
  CameraView: ({ accessibilityLabel }: { accessibilityLabel: string }) =>
    createElement("div", { "aria-label": accessibilityLabel }),
  useCameraPermissions: () => {
    const [permission, setPermission] = useState(cameraPermission);
    const request = useCallback(async () => {
      const result = await requestPermission();
      setPermission(result);
      return result;
    }, []);
    const get = useCallback(async () => {
      const result = await getPermission();
      setPermission(result);
      return result;
    }, []);
    return [permission, request, get];
  },
}));
mockMobileModule("expo-router", () => ({
  Stack: { Screen: () => null },
  useRouter: () => ({ replace: () => undefined, back: () => undefined }),
}));
mockMobileModule("@expo/ui/swift-ui", () => ({
  ContentUnavailableView: ({ title, description }: { title: string; description: string }) =>
    createElement("div", null, title, description),
  Host: Container,
  List: Container,
  ProgressView: Container,
  RNHostView: Container,
  Section: Container,
  Text: Container,
}));
mockMobileModule("@expo/ui/swift-ui/modifiers", () => ({
  listStyle: () => undefined,
  padding: () => undefined,
  tint: () => undefined,
}));
mockLocalModule("@/components/ui/app-button", "apps/mobile/src/components/ui/app-button", () => ({
  AppButton: Button,
}));
mockLocalModule(
  "@/components/pairing/grouped-list",
  "apps/mobile/src/components/pairing/grouped-list",
  () => ({ GroupedScreen: Container, GroupedSection: Container }),
);
mockLocalModule(
  "@/components/pairing/pairing-ios-ui",
  "apps/mobile/src/components/pairing/pairing-ios-ui",
  () => ({ PairingActionButton: Button, SectionFooter: Container }),
);
mockLocalModule(
  "@/features/accessibility/mobile-accessibility",
  "apps/mobile/src/features/accessibility/mobile-accessibility",
  () => ({
    MAX_DYNAMIC_TYPE_MULTIPLIER: 2,
    minimumTouchTarget: () => 48,
    useAccessibilityAnnouncement: () => undefined,
  }),
);
const pairingState = {
  connectionState: { status: "disconnected", lastError: null },
  connectWithQr: async () => undefined,
};
mockLocalModule(
  "@/features/pairing/pairingStore",
  "apps/mobile/src/features/pairing/pairingStore",
  () => ({
    usePairingStore: (selector: (state: typeof pairingState) => unknown) => selector(pairingState),
  }),
);
mockLocalModule("@/theme/use-app-theme", "apps/mobile/src/theme/use-app-theme", () => ({
  useAppTheme: () => ({
    backgroundMuted: "#eee",
    border: "#ccc",
    isDark: false,
    primary: "#060",
    text: "#111",
    textSecondary: "#555",
    textTertiary: "#777",
  }),
}));

const { PairingScanIos } = await import("../apps/mobile/src/components/pairing/pairing-scan.ios");
const { PairingScanFallback } = await import(
  "../apps/mobile/src/components/pairing/pairing-scan.fallback"
);

beforeEach(() => {
  cameraPermission = { granted: false, canAskAgain: true };
  requestPermission.mockReset();
  requestPermission.mockImplementation(async () => cameraPermission);
  getPermission.mockReset();
  getPermission.mockImplementation(async () => cameraPermission);
  openSettings.mockReset();
  openSettings.mockImplementation(async () => undefined);
  alert.mockClear();
});
afterAll(() => mock.restore());

async function withScanner(
  Scanner: ComponentType,
  verify: (container: HTMLElement) => Promise<void>,
) {
  const harness = setupJsdom();
  const container = harness.dom.window.document.getElementById("root");
  if (!container) throw new Error("Missing root container");
  const root = createRoot(container);
  try {
    await act(async () => root.render(createElement(Scanner)));
    await verify(container);
  } finally {
    await act(async () => root.unmount());
    harness.restore();
  }
}

async function press(container: HTMLElement, title: string) {
  const button = Array.from(container.querySelectorAll("button")).find(
    (candidate) => candidate.textContent === title,
  );
  if (!button) throw new Error(`Missing button: ${title}`);
  await act(async () => button.click());
}

describe.each([
  ["ios", PairingScanIos],
  ["android", PairingScanFallback],
] as const)("pairing scanner camera permissions on %s", (_platform, Scanner) => {
  test("opens Settings when the OS will not show another permission prompt", async () => {
    cameraPermission = { granted: false, canAskAgain: false };
    await withScanner(Scanner, async (container) => {
      expect(container.textContent).not.toContain("Allow Camera Access");
      await press(container, "Open Settings");
      expect(openSettings).toHaveBeenCalledTimes(1);
      expect(requestPermission).not.toHaveBeenCalled();
    });
  });

  test("requests camera access while the OS can still ask", async () => {
    await withScanner(Scanner, async (container) => {
      await press(container, "Allow Camera Access");
      expect(requestPermission).toHaveBeenCalledTimes(1);
      expect(openSettings).not.toHaveBeenCalled();
    });
  });

  test("reports a Settings launch failure", async () => {
    cameraPermission = { granted: false, canAskAgain: false };
    openSettings.mockRejectedValueOnce(new Error("Settings unavailable"));
    await withScanner(Scanner, async (container) => {
      await press(container, "Open Settings");
      expect(alert).toHaveBeenCalledWith("Unable to open Settings", "Settings unavailable");
    });
  });

  test("reports a camera permission request failure", async () => {
    requestPermission.mockRejectedValueOnce(new Error("Camera unavailable"));
    await withScanner(Scanner, async (container) => {
      await press(container, "Allow Camera Access");
      expect(alert).toHaveBeenCalledWith("Camera access unavailable", "Camera unavailable");
    });
  });

  test("refreshes camera permission when returning from Settings", async () => {
    cameraPermission = { granted: false, canAskAgain: false };
    await withScanner(Scanner, async (container) => {
      cameraPermission = { granted: true, canAskAgain: true };
      await act(async () => {
        for (const listener of appStateListeners) listener("active");
      });
      expect(getPermission).toHaveBeenCalledTimes(1);
      expect(container.querySelector('[aria-label="QR code scanner camera"]')).not.toBeNull();
      expect(container.textContent).not.toContain("Open Settings");
    });
    expect(appStateListeners.size).toBe(0);
  });

  test("reports a foreground permission refresh failure", async () => {
    getPermission.mockRejectedValueOnce(new Error("Permission status unavailable"));
    await withScanner(Scanner, async () => {
      await act(async () => {
        for (const listener of appStateListeners) listener("active");
      });
      expect(alert).toHaveBeenCalledWith(
        "Camera access unavailable",
        "Permission status unavailable",
      );
    });
  });
});
