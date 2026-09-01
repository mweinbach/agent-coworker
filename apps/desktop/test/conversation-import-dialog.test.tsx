import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import type { ConversationPreviewItem, ConversationSourceCandidate } from "../src/lib/wsProtocol";
import { createDesktopCommandsMock } from "./helpers/mockDesktopCommands";
import { setupJsdom } from "./jsdomHarness";

const pickDirectory = mock(async (): Promise<string | null> => null);

mock.module("../src/lib/desktopCommands", () =>
  createDesktopCommandsMock({
    loadState: async () => ({ version: 2, workspaces: [], threads: [] }),
    saveState: async () => {},
    pickDirectory,
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

function sourceCheckbox(source: string): HTMLButtonElement {
  const checkbox = document.getElementById(`conversation-import-source-${source}`);
  if (!(checkbox instanceof HTMLButtonElement)) throw new Error(`Missing source: ${source}`);
  return checkbox;
}

describe("ConversationImportDialog", () => {
  let harness: ReturnType<typeof setupDialogJsdom>;
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

  beforeEach(() => {
    pickDirectory.mockReset();
    pickDirectory.mockResolvedValue(null);
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

  test.each(["older-first", "newer-first"] as const)(
    "only accepts the current source preview when scans complete %s",
    async (completionOrder) => {
      const older = Promise.withResolvers<{ conversations: ConversationPreviewItem[] }>();
      const newer = Promise.withResolvers<{ conversations: ConversationPreviewItem[] }>();
      const olderConversation = previewFixture({
        status: "matched",
        workspaceId: "workspace-1",
        workspacePath: "/tmp/workspace",
      });
      const newerConversation: ConversationPreviewItem = {
        ...olderConversation,
        source: "claude-code",
        fingerprint: "claude-fingerprint",
        title: "Current Claude chat",
      };
      const previewConversationImports = mock<typeof defaultStoreState.previewConversationImports>()
        .mockReturnValueOnce(older.promise)
        .mockReturnValueOnce(newer.promise);
      const importConversations = mock(async () => ({
        imported: [],
        skipped: [],
        failed: [],
        createdWorkspaces: [],
      }));
      useAppStore.setState({
        listConversationImportSources: mock(async () => ({ sources: [sourceCandidate] })),
        previewConversationImports,
        importConversations,
      });

      await act(async () => {
        root.render(createElement(ConversationImportDialog, { defaultOpen: true }));
      });
      await act(async () => sourceCheckbox("codex").click());
      expect(previewConversationImports).toHaveBeenCalledTimes(2);

      if (completionOrder === "older-first") {
        await act(async () => older.resolve({ conversations: [olderConversation] }));
        expect(findButton("Import selected").disabled).toBe(true);
        expect(document.body.textContent).toContain("Scanning conversations…");
        expect(document.body.textContent).not.toContain(olderConversation.title);
      }

      await act(async () => newer.resolve({ conversations: [newerConversation] }));
      if (completionOrder === "newer-first") {
        await act(async () => older.resolve({ conversations: [olderConversation] }));
      }
      expect(document.body.textContent).toContain(newerConversation.title);
      expect(document.body.textContent).not.toContain(olderConversation.title);
      await act(async () => findButton("Import selected").click());
      expect(importConversations).toHaveBeenCalledWith({
        includeCodex: false,
        includeClaudeCode: true,
        includeCowork: false,
        selected: [{ source: "claude-code", fingerprint: "claude-fingerprint" }],
        mappings: {},
        mode: "skip-existing",
      });
    },
  );

  test("clears the accepted preview when no sources remain and ignores a pending scan", async () => {
    const conversation = previewFixture({
      status: "matched",
      workspaceId: "workspace-1",
      workspacePath: "/tmp/workspace",
    });
    const actions = await renderAndOpen(conversation);
    const pending = Promise.withResolvers<{ conversations: ConversationPreviewItem[] }>();
    actions.previewConversationImports.mockReturnValueOnce(pending.promise);

    await act(async () => sourceCheckbox("codex").click());
    await act(async () => sourceCheckbox("claude-code").click());
    expect(findButton("Import selected").disabled).toBe(true);
    expect(document.body.textContent).not.toContain(conversation.title);
    expect(document.body.textContent).not.toContain("Scanning conversations…");

    await act(async () => pending.resolve({ conversations: [conversation] }));
    expect(document.body.textContent).not.toContain(conversation.title);
    expect(findButton("Import selected").disabled).toBe(true);
  });

  test("keeps import inputs and the accepted preview locked until the import finishes", async () => {
    const conversation = previewFixture({
      status: "matched",
      workspaceId: "workspace-1",
      workspacePath: "/tmp/workspace",
    });
    const actions = await renderAndOpen(conversation);
    const pending =
      Promise.withResolvers<Awaited<ReturnType<typeof actions.importConversations>>>();
    const directory = Promise.withResolvers<string | null>();
    actions.importConversations.mockReturnValueOnce(pending.promise);
    pickDirectory.mockReturnValueOnce(directory.promise);

    await act(async () => findButton("Choose Cowork backup").click());
    await act(async () => findButton("Import selected").click());
    expect(document.body.textContent).toContain("Importing conversations…");
    for (const source of ["codex", "claude-code", "cowork"]) {
      expect(sourceCheckbox(source).disabled).toBe(true);
    }
    expect(findButton("Choose Cowork backup").disabled).toBe(true);
    expect(findButton("Refresh").disabled).toBe(true);
    expect(findButton("Close").disabled).toBe(true);

    await act(async () => {
      sourceCheckbox("codex").click();
      findButton("Choose Cowork backup").click();
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      directory.resolve("/tmp/late-cowork-backup");
    });
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();
    expect(sourceCheckbox("cowork").getAttribute("aria-checked")).toBe("false");
    expect(document.body.textContent).not.toContain("/tmp/late-cowork-backup");
    expect(actions.previewConversationImports).toHaveBeenCalledTimes(1);
    expect(pickDirectory).toHaveBeenCalledTimes(1);
    expect(actions.importConversations).toHaveBeenCalledWith({
      includeCodex: true,
      includeClaudeCode: true,
      includeCowork: false,
      selected: [{ source: "codex", fingerprint: conversation.fingerprint }],
      mappings: {},
      mode: "skip-existing",
    });

    await act(async () => {
      pending.resolve({ imported: [], skipped: [], failed: [], createdWorkspaces: [] });
    });
    expect(findButton("Close").disabled).toBe(false);
    expect(sourceCheckbox("codex").disabled).toBe(false);
    expect(document.body.textContent).toContain("Imported 0, skipped 0, failed 0.");
  });
});
