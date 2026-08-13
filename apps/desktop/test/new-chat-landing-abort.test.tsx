import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";

import {
  composerDraftKeyForNewChatTarget,
  createEmptyComposerDraft,
} from "../src/app/composerDrafts";
import { useAppStore } from "../src/app/store";
import type { AppStoreState } from "../src/app/store.helpers";
import type { WorkspaceRecord } from "../src/app/types";
import { NewChatLanding } from "../src/ui/chat/NewChatLanding";
import { setupJsdom } from "./jsdomHarness";

const workspace: WorkspaceRecord = {
  id: "workspace-landing",
  name: "Project",
  path: "/tmp/project-landing",
  workspaceKind: "project",
  createdAt: "2026-07-12T00:00:00.000Z",
  lastOpenedAt: "2026-07-12T00:00:00.000Z",
  defaultProvider: "google",
  defaultModel: "gemini-2.5-flash",
  defaultEnableMcp: true,
  defaultBackupsEnabled: true,
  yolo: false,
};

async function flushEffects(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

describe("NewChatLanding creation abort guard", () => {
  let harness: ReturnType<typeof setupJsdom>;
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;
  let snapshot: AppStoreState;
  const target = { kind: "project" as const, workspaceId: workspace.id };
  const draftKey = composerDraftKeyForNewChatTarget(target);

  beforeEach(() => {
    harness = setupJsdom();
    container = harness.dom.window.document.getElementById("root") as HTMLDivElement;
    root = createRoot(container);
    snapshot = useAppStore.getState();
  });

  afterEach(() => {
    act(() => root.unmount());
    useAppStore.setState(snapshot, true);
    harness.restore();
  });

  function seedLandingState(submitComposerDraft: AppStoreState["submitComposerDraft"]) {
    useAppStore.setState({
      workspaces: [workspace],
      selectedWorkspaceId: workspace.id,
      selectedThreadId: null,
      newChatLandingTarget: target,
      composerDraftsByKey: {
        [draftKey]: {
          ...createEmptyComposerDraft("2026-07-12T00:00:00.000Z"),
          revision: 2,
          text: "Start this chat",
          provider: "google",
          model: "gemini-2.5-flash",
        },
      },
      composerSubmissionsByKey: {},
      preflightCreation: async () => ({
        ready: true,
        checks: [
          {
            id: "provider_credentials",
            status: "ok",
            message: "Ready",
          },
        ],
      }),
      submitComposerDraft,
      repairCreationReadiness: async () => {},
      providerCatalog: [],
    });
  }

  test("unmount after a committed chat selection does not abort creation", async () => {
    let capturedSignal: AbortSignal | undefined;
    const submitComposerDraft = mock<AppStoreState["submitComposerDraft"]>((_request, options) => {
      capturedSignal = options?.signal;
      return true;
    });
    seedLandingState(submitComposerDraft);

    act(() => root.render(createElement(NewChatLanding)));
    await flushEffects();

    const submit = container.querySelector('button[type="submit"]') as HTMLButtonElement | null;
    expect(submit).not.toBeNull();
    expect(submit?.disabled).toBe(false);
    act(() => submit?.click());
    await flushEffects();

    expect(submitComposerDraft).toHaveBeenCalledTimes(1);
    expect(capturedSignal?.aborted).toBe(false);

    act(() => {
      useAppStore.setState({ selectedThreadId: "thread-committed" });
      root.render(createElement("div"));
    });
    await flushEffects();

    expect(capturedSignal?.aborted).toBe(false);
  });

  test("unmount without a selected thread aborts the in-flight creation", async () => {
    let capturedSignal: AbortSignal | undefined;
    const submitComposerDraft = mock<AppStoreState["submitComposerDraft"]>((_request, options) => {
      capturedSignal = options?.signal;
      return true;
    });
    seedLandingState(submitComposerDraft);

    act(() => root.render(createElement(NewChatLanding)));
    await flushEffects();

    const submit = container.querySelector('button[type="submit"]') as HTMLButtonElement | null;
    expect(submit).not.toBeNull();
    act(() => submit?.click());
    await flushEffects();
    expect(capturedSignal?.aborted).toBe(false);

    act(() => root.render(createElement("div")));
    await flushEffects();
    expect(capturedSignal?.aborted).toBe(true);
  });
});
