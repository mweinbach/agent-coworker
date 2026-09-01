import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import { createComposerDraftAttachment, createEmptyComposerDraft } from "../src/app/composerDrafts";
import { DESKTOP_API_OVERRIDE_KEY } from "../src/lib/desktopApiOverride";
import { installDesktopCommandsBridge } from "./helpers/desktopCommandsBridge";
import { createDesktopApiMock } from "./helpers/mockDesktopCommands";

installDesktopCommandsBridge();

const savedStates: unknown[] = [];
const saveState = mock(async (state: unknown) => {
  savedStates.push(state);
});

const {
  __internal: persistenceInternal,
  flushPendingDesktopState,
  persist,
  persistNow,
  syncDesktopStateCache,
} = await import("../src/app/store.helpers/persistence");
const { createEmptyTaskCreationDraft } = await import("../src/app/creationDrafts");

// The real store always holds this; building it per call would mint a fresh
// idempotency key and make the persisted projection non-deterministic.
const taskCreationDraft = createEmptyTaskCreationDraft();

type MutableState = { developerMode: boolean; showHiddenFiles: boolean };

describe("persisted state writes", () => {
  let state: MutableState;

  beforeEach(() => {
    savedStates.length = 0;
    saveState.mockClear();
    persistenceInternal.resetPersistedStateCache();
    state = { developerMode: false, showHiddenFiles: false };
    (globalThis as Record<string, unknown>)[DESKTOP_API_OVERRIDE_KEY] = {
      ...createDesktopApiMock(),
      saveState,
    };
  });

  afterEach(() => {
    delete (globalThis as Record<string, unknown>)[DESKTOP_API_OVERRIDE_KEY];
    persistenceInternal.resetPersistedStateCache();
  });

  const getState = () =>
    ({
      workspaces: [],
      threads: [],
      developerMode: state.developerMode,
      showHiddenFiles: state.showHiddenFiles,
      providerStatusByName: {},
      providerStatusLastUpdatedAt: null,
      composerDraftsByKey: {},
      taskCreationDraft,
    }) as never;

  test("skips the write when the persisted projection is unchanged", async () => {
    await persistNow(getState);
    expect(saveState).toHaveBeenCalledTimes(1);

    // Store churn that leaves the persisted shape identical must not rewrite the
    // state file — this ran several times a second while the app sat idle.
    await persistNow(getState);
    await persistNow(getState);
    expect(saveState).toHaveBeenCalledTimes(1);
  });

  test("starts an idle durable write immediately without delaying dependent startup", async () => {
    const write = persistNow(getState);

    expect(saveState).toHaveBeenCalledTimes(1);

    await write;
    expect(savedStates).toHaveLength(1);
  });

  test("close flushing is a no-op without owned persistence work", async () => {
    await flushPendingDesktopState();
    expect(saveState).not.toHaveBeenCalled();
  });

  test("flushes a pending UI cache owner without creating a durable write", async () => {
    const readState = mock(getState);
    syncDesktopStateCache(readState);
    expect(readState).not.toHaveBeenCalled();

    await flushPendingDesktopState();

    expect(readState).toHaveBeenCalledTimes(1);
    expect(saveState).not.toHaveBeenCalled();
  });

  test("drains the existing debounce immediately and does not schedule a duplicate write", async () => {
    const readState = mock(getState);
    persist(readState);
    expect(readState).not.toHaveBeenCalled();

    await flushPendingDesktopState();
    await flushPendingDesktopState();

    expect(readState).toHaveBeenCalledTimes(1);
    expect(saveState).toHaveBeenCalledTimes(1);
  });

  test("observes an in-flight failure and retries its owned snapshot without reading a new store", async () => {
    let rejectWrite: (error: Error) => void = () => {};
    saveState.mockImplementationOnce(
      () =>
        new Promise<void>((_resolve, reject) => {
          rejectWrite = reject;
        }),
    );
    const write = persistNow(getState);
    const flushing = flushPendingDesktopState();
    void write.catch(() => {});
    void flushing.catch(() => {});
    rejectWrite(new Error("Storage write failed"));
    await expect(write).rejects.toThrow("Storage write failed");
    await expect(flushing).rejects.toThrow("Storage write failed");

    // This unrelated state was never submitted for persistence.
    state.developerMode = true;
    await flushPendingDesktopState();

    expect(saveState).toHaveBeenCalledTimes(2);
    expect(savedStates).toEqual([expect.objectContaining({ developerMode: false })]);
  });

  test("a queued latest projection supersedes an earlier failed write during close flushing", async () => {
    let rejectWrite: (error: Error) => void = () => {};
    saveState.mockImplementationOnce(
      () =>
        new Promise<void>((_resolve, reject) => {
          rejectWrite = reject;
        }),
    );
    const first = persistNow(getState);
    state.developerMode = true;
    const latest = persistNow(getState);
    const flushing = flushPendingDesktopState();
    rejectWrite(new Error("Earlier write failed"));
    await expect(first).rejects.toThrow("Earlier write failed");
    await latest;
    await flushing;

    expect(saveState).toHaveBeenCalledTimes(2);
    expect(savedStates).toEqual([expect.objectContaining({ developerMode: true })]);
  });

  test("writes again as soon as the projection actually changes", async () => {
    await persistNow(getState);
    expect(saveState).toHaveBeenCalledTimes(1);

    state.developerMode = true;
    await persistNow(getState);
    expect(saveState).toHaveBeenCalledTimes(2);

    // And settles back to quiet once it stops changing.
    await persistNow(getState);
    expect(saveState).toHaveBeenCalledTimes(2);
  });

  test("projects a large history in linear record reads while retaining the latest event sequence", () => {
    let identityReads = 0;
    const threads = Array.from({ length: 200 }, (_, index) => ({
      get id() {
        identityReads += 1;
        return `thread-${index}`;
      },
      lastEventSeq: index,
    }));
    const projected = persistenceInternal.buildPersistableThreads({
      threads,
      threadRuntimeById: {
        "thread-0": { lastEventSeq: 12 },
        "thread-199": { lastEventSeq: 4 },
      },
    } as never);

    expect(projected).toHaveLength(200);
    expect(projected[0]?.lastEventSeq).toBe(12);
    expect(projected[199]?.lastEventSeq).toBe(199);
    expect(identityReads).toBeLessThanOrEqual(threads.length * 3);
  });

  test("omits attachment payloads only from the UI cache, not the durable save or active draft", async () => {
    const attachment = await createComposerDraftAttachment(new File(["draft bytes"], "notes.txt"));
    const key = "new:oneOff";
    const draft = { ...createEmptyComposerDraft(), attachments: [attachment] };
    const draftState = Object.assign({}, getState(), { composerDraftsByKey: { [key]: draft } });
    const previousWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
    const previousStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
    const cacheWrites: string[] = [];
    const localStorage = {
      getItem: () => null,
      setItem: (_key: string, value: string) => cacheWrites.push(value),
    };
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: { localStorage },
    });
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      value: localStorage,
    });

    try {
      await persistNow(() => draftState as never);

      expect(savedStates[0]).toMatchObject({
        composerDrafts: { [key]: { attachments: [{ contentBase64: attachment.contentBase64 }] } },
      });
      expect(
        JSON.parse(cacheWrites[0] ?? "{}").persistedState.composerDrafts[key].attachments,
      ).toEqual([]);
      expect(draft.attachments).toEqual([attachment]);
    } finally {
      if (previousWindow) Object.defineProperty(globalThis, "window", previousWindow);
      else delete (globalThis as Record<string, unknown>).window;
      if (previousStorage) Object.defineProperty(globalThis, "localStorage", previousStorage);
      else delete (globalThis as Record<string, unknown>).localStorage;
    }
  });

  test("retries an unchanged projection after its previous write failed", async () => {
    saveState.mockImplementationOnce(async () => {
      throw new Error("The desktop state file is temporarily unavailable.");
    });

    await expect(persistNow(getState)).rejects.toThrow("temporarily unavailable");
    expect(saveState).toHaveBeenCalledTimes(1);

    await persistNow(getState);

    expect(saveState).toHaveBeenCalledTimes(2);
    expect(savedStates).toHaveLength(1);
    expect(savedStates[0]).toMatchObject({ developerMode: false });
  });

  test("serializes overlapping writes and preserves the most recent projection", async () => {
    let releaseFirstWrite: (() => void) | undefined;
    let notifyFirstWriteStarted: (() => void) | undefined;
    const firstWriteStarted = new Promise<void>((resolve) => {
      notifyFirstWriteStarted = resolve;
    });
    saveState.mockImplementationOnce(async (snapshot: unknown) => {
      notifyFirstWriteStarted?.();
      await new Promise<void>((resolve) => {
        releaseFirstWrite = resolve;
      });
      savedStates.push(snapshot);
    });

    const first = persistNow(getState);
    await firstWriteStarted;

    state.developerMode = true;
    const second = persistNow(getState);
    state.developerMode = false;
    const third = persistNow(getState);

    expect(saveState).toHaveBeenCalledTimes(1);

    releaseFirstWrite?.();
    await Promise.all([first, second, third]);

    expect(savedStates.map((snapshot) => (snapshot as MutableState).developerMode)).toEqual([
      false,
      true,
      false,
    ]);
  });
});
