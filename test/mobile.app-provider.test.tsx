import { expect, spyOn, test } from "bun:test";
import { createRequire } from "node:module";
import path from "node:path";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";

import { setupJsdom } from "../apps/desktop/test/jsdomHarness";
import { clearAllOfflineWorkspaceCache } from "../apps/mobile/src/features/cowork/offlineCache";
import {
  clearLegacyOfflineCache,
  getOfflineCacheScope,
  setOfflineCacheDesktop,
} from "../apps/mobile/src/features/cowork/offlineCacheStorage";
import { getActiveCoworkJsonRpcClient } from "../apps/mobile/src/features/cowork/runtimeClient";
import { loadThreadOfflineCache } from "../apps/mobile/src/features/cowork/threadOfflineCache";
import {
  flushThreadOfflineCache,
  useThreadStore,
} from "../apps/mobile/src/features/cowork/threadStore";
import { clearWorkspaceBoundStores } from "../apps/mobile/src/features/cowork/workspaceBootstrap";
import { usePairingStore } from "../apps/mobile/src/features/pairing/pairingStore";
import { useDisplayPreferencesStore } from "../apps/mobile/src/features/preferences/displayPreferencesStore";
import type {
  SecureTransportClientEvents,
  SecureTransportSnapshot,
} from "../apps/mobile/src/features/relay/relayTypes";
import { defaultSecureTransportClient } from "../apps/mobile/src/features/relay/secureTransportClient";

const { MobileAppProvider } = await import("../apps/mobile/src/providers/MobileAppProvider");
const mobileRequire = createRequire(path.resolve("apps/mobile/package.json"));
const { AppState } = mobileRequire("react-native") as typeof import("react-native");
const secureStore = mobileRequire("expo-secure-store") as typeof import("expo-secure-store");

test.each([
  ["connected", false],
  ["idle", false],
  ["idle", true],
] as const)(
  "%s mobile app provider (legacy recovery: %s) bootstraps stores and releases its connection",
  async (status, recoverLegacy) => {
    const initialCacheDesktop = getOfflineCacheScope().desktopId;
    const initialThreadState = useThreadStore.getState();
    const initialPairingState = usePairingStore.getState();
    const initialDisplayPreferences = useDisplayPreferencesStore.getState();
    await flushThreadOfflineCache();
    await clearAllOfflineWorkspaceCache();
    clearWorkspaceBoundStores();
    useThreadStore.setState(useThreadStore.getInitialState(), true);
    useDisplayPreferencesStore.setState({ hydrated: false });

    if (recoverLegacy) {
      setOfflineCacheDesktop(null);
      await clearAllOfflineWorkspaceCache(null);
      await clearAllOfflineWorkspaceCache("desktop-1");
      await clearAllOfflineWorkspaceCache("desktop-2");
      await clearLegacyOfflineCache();
      await secureStore.deleteItemAsync("cowork.cache.lastDesktop.v1");
      await secureStore.setItemAsync(
        "cowork.cache.threadSnapshots",
        JSON.stringify({
          version: 3,
          threads: [
            {
              id: "old-remote-thread",
              title: "Old desktop conversation",
              composerDraft: "Recovered unsent text",
              composerAttachments: [
                {
                  type: "file",
                  filename: "draft.txt",
                  mimeType: "text/plain",
                  contentBase64: "ZHJhZnQ=",
                },
              ],
              composerSubmission: {
                clientMessageId: "interrupted",
                text: "Distinct interrupted text",
                attachments: [],
                status: "submitting",
              },
              feed: [
                {
                  id: "private",
                  kind: "message",
                  role: "assistant",
                  ts: "",
                  text: "Do not copy this old desktop transcript",
                },
              ],
              cwd: "/old-desktop",
            },
          ],
          snapshots: {},
        }),
      );
    }

    const transportSnapshot: SecureTransportSnapshot = {
      status,
      transportMode: "native",
      connectedMacDeviceId: recoverLegacy ? null : "desktop-1",
      relayUrl: "https://desktop.test",
      sessionId: "session-1",
      trustedDesktops: recoverLegacy
        ? (["desktop-1", "desktop-2"].map((macDeviceId) => ({
            macDeviceId,
          })) as SecureTransportSnapshot["trustedDesktops"])
        : [],
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
    let listedThread = remoteThread;
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
            result = { threads: [listedThread], total: 1 };
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
      } else if (recoverLegacy) {
        expect(getOfflineCacheScope().desktopId).toBeNull();
        expect(useThreadStore.getState().threads.map((thread) => thread.composerDraft)).toEqual([
          "Recovered unsent text",
          "Distinct interrupted text",
        ]);
      } else {
        expect(useThreadStore.getState().threads).toHaveLength(1);
        expect(useThreadStore.getState().threads[0]?.id).toStartWith("draft-");
        expect(sentMethods).toEqual([]);
      }
      expect(useDisplayPreferencesStore.getState().hydrated).toBe(true);
      expect(usePairingStore.getState().connectionState).toEqual(transportSnapshot);
      expect(transportListeners.size).toBe(2);
      expect(appStateListeners.size).toBe(1);

      if (recoverLegacy) {
        const recoveredId = useThreadStore.getState().threads[0]!.id;
        useThreadStore.getState().setComposerDraft(recoveredId, "Edited before choosing a desktop");
        const firstDesktop = {
          ...transportSnapshot,
          status: "connected" as const,
          connectedMacDeviceId: "desktop-1",
        };
        getSnapshot.mockResolvedValue(firstDesktop);
        await act(async () => {
          for (const listener of transportListeners) listener.onStateChanged?.(firstDesktop);
        });
        expect(useThreadStore.getState().getThread(recoveredId)).toMatchObject({
          composerDraft: "Edited before choosing a desktop",
          composerAttachments: [
            {
              type: "file",
              filename: "draft.txt",
              mimeType: "text/plain",
              contentBase64: "ZHJhZnQ=",
            },
          ],
          feed: [],
          cwd: null,
        });
        expect(
          useThreadStore
            .getState()
            .threads.some((thread) => thread.composerDraft === "Distinct interrupted text"),
        ).toBe(true);
        expect(
          (await loadThreadOfflineCache(null))?.threads.some(
            (thread) => thread.composerDraft.length > 0,
          ) ?? false,
        ).toBe(false);

        const secondDesktop = { ...firstDesktop, connectedMacDeviceId: "desktop-2" };
        getSnapshot.mockResolvedValue(secondDesktop);
        await act(async () => {
          for (const listener of transportListeners) listener.onStateChanged?.(secondDesktop);
        });
        expect(useThreadStore.getState().getThread(recoveredId)).toBeNull();
        expect(
          useThreadStore
            .getState()
            .threads.some((thread) => thread.composerDraft === "Distinct interrupted text"),
        ).toBe(false);

        getSnapshot.mockResolvedValue(firstDesktop);
        await act(async () => {
          for (const listener of transportListeners) listener.onStateChanged?.(firstDesktop);
        });
        expect(useThreadStore.getState().getThread(recoveredId)?.composerDraft).toBe(
          "Edited before choosing a desktop",
        );
      }

      if (status === "connected") {
        useThreadStore.getState().setComposerDraft(remoteThread.id, "Keep desktop one's draft");
        listedThread = { ...remoteThread, id: "desktop-two-thread", title: "Desktop two" };
        const nextDesktop = { ...transportSnapshot, connectedMacDeviceId: "desktop-2" };
        getSnapshot.mockResolvedValue(nextDesktop);
        await act(async () => {
          for (const listener of transportListeners) listener.onStateChanged?.(nextDesktop);
        });
        expect(useThreadStore.getState().getThread(remoteThread.id)).toBeNull();
        expect(useThreadStore.getState().getThread(listedThread.id)?.title).toBe("Desktop two");
        expect(
          (await loadThreadOfflineCache("desktop-1"))?.threads.find(
            (thread) => thread.id === remoteThread.id,
          )?.composerDraft,
        ).toBe("Keep desktop one's draft");

        listedThread = remoteThread;
        getSnapshot.mockResolvedValue(transportSnapshot);
        await act(async () => {
          for (const listener of transportListeners) listener.onStateChanged?.(transportSnapshot);
        });
        expect(useThreadStore.getState().getThread("desktop-two-thread")).toBeNull();
        expect(useThreadStore.getState().getThread(remoteThread.id)?.composerDraft).toBe(
          "Keep desktop one's draft",
        );
        useThreadStore.getState().setComposerDraft(remoteThread.id, "Last edit before background");
      }

      await act(async () => {
        for (const listener of appStateListeners) {
          listener("background");
          listener("active");
        }
      });
      expect(recover).toHaveBeenCalledTimes(1);
      if (status === "connected") {
        expect(
          (await loadThreadOfflineCache("desktop-1"))?.threads.find(
            (thread) => thread.id === remoteThread.id,
          )?.composerDraft,
        ).toBe("Last edit before background");
      }

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
      await flushThreadOfflineCache();
      await clearAllOfflineWorkspaceCache();
      await clearAllOfflineWorkspaceCache("desktop-2");
      if (recoverLegacy) {
        await clearAllOfflineWorkspaceCache(null);
        await clearLegacyOfflineCache();
      }
      clearWorkspaceBoundStores();
      useThreadStore.setState(initialThreadState, true);
      usePairingStore.setState(initialPairingState, true);
      useDisplayPreferencesStore.setState(initialDisplayPreferences, true);
      setOfflineCacheDesktop(initialCacheDesktop);
    }
  },
);
