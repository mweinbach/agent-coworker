import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import type { ConversationPreviewItem, ConversationSourceCandidate } from "../src/lib/wsProtocol";
import { createDesktopCommandsMock } from "./helpers/mockDesktopCommands";
import { setupJsdom } from "./jsdomHarness";

mock.module("../src/lib/desktopCommands", () =>
  createDesktopCommandsMock({
    loadState: async () => ({ version: 2, workspaces: [], threads: [] }),
    saveState: async () => {},
    pickDirectory: async () => null,
  }),
);

const { useAppStore } = await import("../src/app/store");
const { ConversationImportDialog } = await import(
  "../src/ui/settings/import/ConversationImportDialog"
);

const defaultStoreState = useAppStore.getState();

const sourceCandidate: ConversationSourceCandidate = {
  source: "codex",
  id: "codex:/tmp/state.sqlite",
  path: "/tmp/state.sqlite",
  available: true,
  conversationCount: 1,
};

function previewFixture(mapping: ConversationPreviewItem["mapping"]): ConversationPreviewItem {
  return {
    source: "codex",
    sourceId: "codex-thread-1",
    sourcePath: "/tmp/state.sqlite",
    fingerprint: "fingerprint-1",
    title: "Imported Codex chat",
    cwd: "/tmp/workspace",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:01.000Z",
    originalProvider: "openai",
    originalModel: "gpt-5.5",
    messageCount: 2,
    toolCount: 0,
    warnings: [],
    mapping,
    alreadyImportedThreadId: null,
  };
}

function setupDialogJsdom() {
  return setupJsdom({ includeAnimationFrame: true });
}

function findButton(label: string): HTMLButtonElement {
  const button = Array.from(document.querySelectorAll<HTMLButtonElement>("button")).find((node) =>
    node.textContent?.includes(label),
  );
  if (!button) throw new Error(`Missing button: ${label}`);
  return button;
}

describe("ConversationImportDialog", () => {
  let harness: ReturnType<typeof setupDialogJsdom>;
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

  beforeEach(() => {
    harness = setupDialogJsdom();
    container = harness.dom.window.document.getElementById("root") as HTMLDivElement;
    root = createRoot(container);
    useAppStore.setState({
      workspaces: [
        {
          id: "workspace-1",
          name: "Workspace",
          path: "/tmp/workspace",
          createdAt: "2026-01-01T00:00:00.000Z",
          lastOpenedAt: "2026-01-01T00:00:00.000Z",
          defaultEnableMcp: true,
          defaultBackupsEnabled: false,
          yolo: false,
        },
      ],
    });
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    useAppStore.setState(defaultStoreState);
    harness.restore();
  });

  async function renderAndOpen(conversation: ConversationPreviewItem) {
    const listConversationImportSources = mock(async () => ({ sources: [sourceCandidate] }));
    const previewConversationImports = mock(async () => ({ conversations: [conversation] }));
    const importConversations = mock(async () => ({
      imported: [
        {
          source: conversation.source,
          fingerprint: conversation.fingerprint,
          threadId: "thread-imported",
          workspaceId: "workspace-1",
          workspacePath: "/tmp/workspace",
          title: conversation.title,
        },
      ],
      skipped: [],
      failed: [],
      createdWorkspaces: [],
    }));
    const selectThread = mock(async () => {});
    useAppStore.setState({
      listConversationImportSources,
      previewConversationImports,
      importConversations,
      selectThread,
    });

    await act(async () => {
      root.render(createElement(ConversationImportDialog, { defaultOpen: true }));
    });
    await act(async () => {
      await Promise.resolve();
    });
    return { listConversationImportSources, previewConversationImports, importConversations };
  }

  test("renders preview rows and blocks import until missing mappings are resolved", async () => {
    await renderAndOpen(
      previewFixture({ status: "missing", originalPath: "/tmp/missing", reason: "path_missing" }),
    );

    expect(document.body.textContent).toContain("Imported Codex chat");
    expect(document.body.textContent).toContain("Needs workspace mapping");
    expect(findButton("Import selected").disabled).toBe(true);
  });

  test("imports selected mapped conversations", async () => {
    const actions = await renderAndOpen(
      previewFixture({
        status: "matched",
        workspaceId: "workspace-1",
        workspacePath: "/tmp/workspace",
      }),
    );

    expect(findButton("Import selected").disabled).toBe(false);
    await act(async () => {
      findButton("Import selected").click();
    });

    expect(actions.importConversations).toHaveBeenCalledWith(
      expect.objectContaining({
        selected: [{ source: "codex", fingerprint: "fingerprint-1" }],
        mode: "skip-existing",
      }),
    );
  });
});
