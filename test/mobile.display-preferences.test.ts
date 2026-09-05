import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { createRequire } from "node:module";
import path from "node:path";

mock.restore();

let readPreferences: () => Promise<string | null> = async () => null;
let writePreferences: (value: string) => Promise<void> = async () => undefined;
const getItemAsync = mock((_key: string) => readPreferences());
const setItemAsync = mock((_key: string, value: string) => writePreferences(value));
const secureStore = () => ({ getItemAsync, setItemAsync });
const mobileRequire = createRequire(path.resolve("apps/mobile/package.json"));
mock.module("expo-secure-store", secureStore);
mock.module(mobileRequire.resolve("expo-secure-store"), secureStore);

const { filterFeedForDisplay } = await import("../apps/mobile/src/features/cowork/feedDisplay");
const { useDisplayPreferencesStore } = await import(
  "../apps/mobile/src/features/preferences/displayPreferencesStore"
);

import type { SessionFeedItem } from "../apps/mobile/src/features/cowork/protocolTypes";

function flushStorageWork(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

beforeEach(() => {
  readPreferences = async () => null;
  writePreferences = async () => undefined;
  getItemAsync.mockClear();
  setItemAsync.mockClear();
  useDisplayPreferencesStore.setState({ showDebugMessages: false, hydrated: false });
});

afterEach(flushStorageWork);
afterAll(() => mock.restore());

describe("mobile display preferences", () => {
  test("filterFeedForDisplay hides system and log items by default", () => {
    const feed: SessionFeedItem[] = [
      {
        id: "m1",
        kind: "message",
        role: "user",
        ts: "2024-01-01T00:00:00.000Z",
        text: "hello",
      },
      {
        id: "s1",
        kind: "system",
        ts: "2024-01-01T00:00:01.000Z",
        line: "Observability: enabled=yes",
      },
      {
        id: "l1",
        kind: "log",
        ts: "2024-01-01T00:00:02.000Z",
        line: "debug line",
      },
    ];

    expect(filterFeedForDisplay(feed, false)).toEqual([feed[0]]);
    expect(filterFeedForDisplay(feed, true)).toEqual(feed);
  });

  test("does not overwrite a newer user choice when hydration finishes", async () => {
    const stored = Promise.withResolvers<string | null>();
    readPreferences = () => stored.promise;

    const hydration = useDisplayPreferencesStore.getState().hydrate();
    useDisplayPreferencesStore.getState().setShowDebugMessages(true);
    stored.resolve(JSON.stringify({ showDebugMessages: false }));
    await hydration;

    expect(useDisplayPreferencesStore.getState()).toMatchObject({
      hydrated: true,
      showDebugMessages: true,
    });
  });

  test("keeps a user choice made before the initial hydration", async () => {
    readPreferences = async () => JSON.stringify({ showDebugMessages: false });
    useDisplayPreferencesStore.getState().setShowDebugMessages(true);

    await useDisplayPreferencesStore.getState().hydrate();

    expect(useDisplayPreferencesStore.getState()).toMatchObject({
      hydrated: true,
      showDebugMessages: true,
    });
  });

  test("shares an in-flight hydration read and does not reload hydrated preferences", async () => {
    const stored = Promise.withResolvers<string | null>();
    readPreferences = () => stored.promise;

    const first = useDisplayPreferencesStore.getState().hydrate();
    const second = useDisplayPreferencesStore.getState().hydrate();
    await flushStorageWork();
    stored.resolve(JSON.stringify({ showDebugMessages: true }));
    await Promise.all([first, second]);

    expect(getItemAsync).toHaveBeenCalledTimes(1);
    expect(useDisplayPreferencesStore.getState().showDebugMessages).toBe(true);
    await useDisplayPreferencesStore.getState().hydrate();
    expect(getItemAsync).toHaveBeenCalledTimes(1);
  });

  test("serializes writes so an older completion cannot replace the last choice", async () => {
    const firstWrite = Promise.withResolvers<void>();
    let persisted: string | null = null;
    writePreferences = async (value) => {
      if (JSON.parse(value).showDebugMessages) {
        await firstWrite.promise;
      }
      persisted = value;
    };

    try {
      useDisplayPreferencesStore.getState().setShowDebugMessages(true);
      await flushStorageWork();
      useDisplayPreferencesStore.getState().setShowDebugMessages(false);
      await flushStorageWork();
      expect(setItemAsync).toHaveBeenCalledTimes(1);
    } finally {
      firstWrite.resolve();
      await flushStorageWork();
    }

    expect(JSON.parse(persisted ?? "null")).toEqual({ showDebugMessages: false });
    expect(setItemAsync).toHaveBeenCalledTimes(2);
  });

  test("continues persisting later choices after one write fails", async () => {
    let persisted: string | null = null;
    writePreferences = async (value) => {
      if (JSON.parse(value).showDebugMessages) {
        throw new Error("Storage unavailable");
      }
      persisted = value;
    };

    useDisplayPreferencesStore.getState().setShowDebugMessages(true);
    useDisplayPreferencesStore.getState().setShowDebugMessages(false);
    await flushStorageWork();

    expect(JSON.parse(persisted ?? "null")).toEqual({ showDebugMessages: false });
  });
});
