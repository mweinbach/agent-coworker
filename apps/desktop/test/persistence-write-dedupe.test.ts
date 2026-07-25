import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import { DESKTOP_API_OVERRIDE_KEY } from "../src/lib/desktopApiOverride";
import { installDesktopCommandsBridge } from "./helpers/desktopCommandsBridge";
import { createDesktopApiMock } from "./helpers/mockDesktopCommands";

installDesktopCommandsBridge();

const savedStates: unknown[] = [];
const saveState = mock(async (state: unknown) => {
  savedStates.push(state);
});

const { __internal: persistenceInternal, persistNow } = await import(
  "../src/app/store.helpers/persistence"
);
const { createEmptyComposerDraft } = await import("../src/app/composerDrafts");
const { createEmptyTaskCreationDraft } = await import("../src/app/creationDrafts");

// The real store always holds these; building them per call would mint a fresh
// idempotency key and make the persisted projection non-deterministic.
const researchCreationDraft = createEmptyComposerDraft();
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
      researchCreationDraft,
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
});
