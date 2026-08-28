import { expect, spyOn, test } from "bun:test";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { AppState } from "react-native";

import { setupJsdom } from "../apps/desktop/test/jsdomHarness";
import { clearAllOfflineWorkspaceCache } from "../apps/mobile/src/features/cowork/offlineCache";
import { getActiveCoworkJsonRpcClient } from "../apps/mobile/src/features/cowork/runtimeClient";
import { useThreadStore } from "../apps/mobile/src/features/cowork/threadStore";
import { clearWorkspaceBoundStores } from "../apps/mobile/src/features/cowork/workspaceBootstrap";
import { usePairingStore } from "../apps/mobile/src/features/pairing/pairingStore";
import { useDisplayPreferencesStore } from "../apps/mobile/src/features/preferences/displayPreferencesStore";
import type {
  SecureTransportClientEvents,
  SecureTransportSnapshot,
} from "../apps/mobile/src/features/relay/relayTypes";
import { defaultSecureTransportClient } from "../apps/mobile/src/features/relay/secureTransportClient";

const { MobileAppProvider } = await import("../apps/mobile/src/providers/MobileAppProvider");

test.each(["connected", "idle"] as const)(
  "%s mobile app provider renders children, bootstraps stores, and releases its connection",
  async (status) => {
    const initialThreadState = useThreadStore.getState();
    const initialPairingState = usePairingStore.getState();
    const initialDisplayPreferences = useDisplayPreferencesStore.getState();
    await clearAllOfflineWorkspaceCache();
    clearWorkspaceBoundStores();
    useThreadStore.setState(useThreadStore.getInitialState(), true);
    useDisplayPreferencesStore.setState({ hydrated: false });

    const transportSnapshot: SecureTransportSnapshot = {
      status,
      transportMode: "native",
      connectedMacDeviceId: "desktop-1",
      relayUrl: "https://desktop.test",
      sessionId: "session-1",
      trustedDesktops: [],
      lastError: null,
    };
    const remoteThread = {
      id: "remote-thread",
      title: "Desktop conversation",
      preview: "From the desktop",
      modelProvider: "openai",
      model: "test-model",
      cwd: "/workspace",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      messageCount: 1,
      lastEventSeq: 1,
      status: { type: "idle" },
    };
    const transportListeners = new Set<SecureTransportClientEvents>();
    const appStateListeners = new Set<(state: "background" | "active") => void>();
    const sentMethods: string[] = [];
    const addAppStateListener = spyOn(AppState, "addEventListener").mockImplementation(
      (_event, listener) => {
        appStateListeners.add(listener);
        return { remove: () => appStateListeners.delete(listener) };
      },
    );
    const getSnapshot = spyOn(defaultSecureTransportClient, "getSnapshot").mockResolvedValue(
      transportSnapshot,
    );
    const subscribe = spyOn(defaultSecureTransportClient, "subscribe").mockImplementation(
      (events) => {
        transportListeners.add(events);
        return () => transportListeners.delete(events);
      },
    );
    const recover = spyOn(
      defaultSecureTransportClient,
      "recoverForegroundSession",
    ).mockResolvedValue(transportSnapshot);
    const send = spyOn(defaultSecureTransportClient, "sendPlaintext").mockImplementation(
      async (text) => {
        const request = JSON.parse(text) as { id?: number; method: string };
        sentMethods.push(request.method);
        if (request.id === undefined || request.method === "test/unanswered") return;
        let result: unknown;
        switch (request.method) {
          case "initialize":
            result = {};
            break;
          case "workspace/list":
            result = { workspaces: [], activeWorkspaceId: null };
            break;
          case "thread/list":
            result = { threads: [remoteThread], total: 1 };
            break;
          default:
            throw new Error(`Unexpected JSON-RPC method: ${request.method}`);
        }
        for (const listener of transportListeners) {
          listener.onPlaintextMessage?.(JSON.stringify({ id: request.id, result }));
        }
      },
    );

    const harness = setupJsdom();
    const container = harness.dom.window.document.getElementById("root")!;
    const root = createRoot(container);
    try {
      await act(async () => {
        root.render(
          createElement(MobileAppProvider, null, createElement("p", null, "Mobile child")),
        );
      });

      expect(container.textContent).toBe("Mobile child");
      if (status === "connected") {
        expect(useThreadStore.getState().getThread(remoteThread.id)?.title).toBe(
          remoteThread.title,
        );
        expect(sentMethods.filter((method) => method === "initialize")).toHaveLength(1);
        expect(sentMethods).toContain("workspace/list");
        expect(sentMethods).toContain("thread/list");
      } else {
        expect(useThreadStore.getState().threads).toHaveLength(1);
        expect(useThreadStore.getState().threads[0]?.id).toStartWith("draft-");
        expect(sentMethods).toEqual([]);
      }
      expect(useDisplayPreferencesStore.getState().hydrated).toBe(true);
      expect(usePairingStore.getState().connectionState).toEqual(transportSnapshot);
      expect(transportListeners.size).toBe(2);
      expect(appStateListeners.size).toBe(1);

      await act(async () => {
        for (const listener of appStateListeners) {
          listener("background");
          listener("active");
        }
      });
      expect(recover).toHaveBeenCalledTimes(1);

      const client = getActiveCoworkJsonRpcClient();
      expect(client).not.toBeNull();
      const pending = client!.call("test/unanswered").catch((error: unknown) => error);
      await act(async () => root.unmount());
      expect(await pending).toEqual(new Error("Transport disconnected."));

      expect(getActiveCoworkJsonRpcClient()).toBeNull();
      expect(transportListeners.size).toBe(0);
      expect(appStateListeners.size).toBe(0);
      expect(usePairingStore.getState().listenerCleanup).toEqual([]);
    } finally {
      await act(async () => root.unmount());
      harness.restore();
      for (const spy of [addAppStateListener, getSnapshot, subscribe, recover, send])
        spy.mockRestore();
      await clearAllOfflineWorkspaceCache();
      clearWorkspaceBoundStores();
      useThreadStore.setState(initialThreadState, true);
      usePairingStore.setState(initialPairingState, true);
      useDisplayPreferencesStore.setState(initialDisplayPreferences, true);
    }
  },
);
