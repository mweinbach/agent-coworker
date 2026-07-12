import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";

import { createEmptyComposerDraft } from "../src/app/composerDrafts";
import { useAppStore } from "../src/app/store";
import type { AppStoreState } from "../src/app/store.helpers";
import type { WorkspaceRecord } from "../src/app/types";
import { ResearchView } from "../src/ui/ResearchView";
import { NewResearchComposer } from "../src/ui/research/NewResearchComposer";
import { setupJsdom } from "./jsdomHarness";

const workspace: WorkspaceRecord = {
  id: "workspace-1",
  name: "Project",
  path: "/tmp/project",
  workspaceKind: "project",
  createdAt: "2026-07-12T00:00:00.000Z",
  lastOpenedAt: "2026-07-12T00:00:00.000Z",
  defaultEnableMcp: true,
  defaultBackupsEnabled: true,
  yolo: false,
};

async function flushEffects(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

describe("Research readiness", () => {
  let harness: ReturnType<typeof setupJsdom>;
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;
  let snapshot: AppStoreState;

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

  test("keeps Research visible with a Connect Google setup action", async () => {
    const repairCreationReadiness = mock(async () => {});
    useAppStore.setState({
      workspaces: [workspace],
      selectedWorkspaceId: workspace.id,
      selectedResearchId: null,
      researchById: {},
      researchOrder: [],
      researchListLoading: false,
      researchListError: null,
      refreshResearchList: async () => {},
      preflightCreation: async () => ({
        ready: false,
        checks: [
          {
            id: "research_credentials",
            status: "blocked",
            message: "Connect Google with an API key to use Deep Research.",
            repairAction: { type: "connectProvider", provider: "google" },
          },
        ],
      }),
      repairCreationReadiness,
    });

    act(() => root.render(createElement(ResearchView)));
    await flushEffects();

    expect(container.textContent).toContain("Research");
    expect(container.textContent).toContain("Connect Google with an API key");
    const connect = Array.from(container.querySelectorAll("button")).find((button) =>
      button.textContent?.includes("Connect Google"),
    );
    expect(connect).not.toBeNull();
    act(() => connect?.click());
    await flushEffects();
    expect(repairCreationReadiness).toHaveBeenCalledWith(
      { type: "connectProvider", provider: "google" },
      workspace.id,
    );
  });

  test("cancel returns the preserved research draft to an editable state", async () => {
    const startResearch: AppStoreState["startResearch"] = async ({ signal }) =>
      await new Promise((resolve) => {
        signal?.addEventListener(
          "abort",
          () =>
            resolve({
              ok: false,
              error: {
                code: "request_failed",
                message: "Cancelled",
                retryable: true,
              },
            }),
          { once: true },
        );
      });
    useAppStore.setState({
      workspaces: [workspace],
      selectedWorkspaceId: workspace.id,
      researchCreationDraft: {
        ...createEmptyComposerDraft("2026-07-12T00:00:00.000Z"),
        revision: 4,
        text: "Preserve this research draft",
      },
      researchCreationError: null,
      preflightCreation: async () => ({
        ready: true,
        checks: [
          { id: "project_access", status: "ok", message: "Workspace is accessible." },
          {
            id: "research_credentials",
            status: "ok",
            message: "Google credentials are available.",
          },
          { id: "runtime_ready", status: "ok", message: "Runtime is ready." },
        ],
      }),
      startResearch,
    });

    act(() => root.render(createElement(NewResearchComposer)));
    await flushEffects();
    const submit = container.querySelector<HTMLButtonElement>('button[aria-label="Send message"]');
    expect(submit?.disabled).toBe(false);
    act(() => submit?.click());
    await flushEffects();

    const cancel = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent === "Cancel",
    );
    expect(cancel).not.toBeNull();
    act(() => cancel?.click());
    await flushEffects();

    const textarea = container.querySelector<HTMLTextAreaElement>("textarea");
    expect(textarea?.disabled).toBe(false);
    expect(textarea?.value).toBe("Preserve this research draft");
  });

  test("Retry resubmits the preserved research draft", async () => {
    const startResearch = mock<AppStoreState["startResearch"]>(async () => ({
      ok: false,
      error: {
        code: "request_failed",
        message: "Still unavailable",
        retryable: true,
      },
    }));
    useAppStore.setState({
      workspaces: [workspace],
      selectedWorkspaceId: workspace.id,
      researchCreationDraft: {
        ...createEmptyComposerDraft("2026-07-12T00:00:00.000Z"),
        revision: 9,
        text: "Retry this exact brief",
      },
      researchCreationError: {
        revision: 9,
        message: "Google credentials expired.",
      },
      preflightCreation: async () => ({
        ready: true,
        checks: [
          { id: "project_access", status: "ok", message: "Workspace is accessible." },
          {
            id: "research_credentials",
            status: "ok",
            message: "Google credentials are available.",
          },
          { id: "runtime_ready", status: "ok", message: "Runtime is ready." },
        ],
      }),
      startResearch,
    });

    act(() => root.render(createElement(NewResearchComposer)));
    await flushEffects();
    const retry = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent?.trim() === "Retry",
    );
    expect(retry).not.toBeNull();
    act(() => retry?.click());
    await flushEffects();

    expect(startResearch).toHaveBeenCalledTimes(1);
    expect(startResearch.mock.calls[0]?.[0]).toMatchObject({
      input: "Retry this exact brief",
      draftRevision: 9,
    });
  });
});
