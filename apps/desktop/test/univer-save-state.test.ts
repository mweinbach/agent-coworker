import { describe, expect, mock, test } from "bun:test";
import fs from "node:fs/promises";
import path from "node:path";
import {
  CellValueType,
  CommandType,
  HorizontalAlign,
  type ICommandInfo,
  ICommandService,
  type IWorkbookData,
  Univer,
  UniverInstanceType,
} from "@univerjs/core";
import { FUniver } from "@univerjs/core/facade";
import {
  AddWorksheetMergeMutation,
  SetRangeValuesMutation,
  SetWorksheetColWidthMutation,
  SetWorksheetRowHeightMutation,
} from "@univerjs/sheets";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import * as XLSX from "xlsx";

import { scratchRoots } from "../../../src/platform/sandbox/policy";
import { readSpreadsheetWorkbookSnapshot } from "../../../src/server/spreadsheet/read";
import { patchSpreadsheetBatch } from "../../../src/server/spreadsheet/write";
import type { SpreadsheetWorkbookSnapshot } from "../../../src/shared/spreadsheetPreview";
import { useAppStore } from "../src/app/store";
import {
  registerCanvasDocumentTransitionHandler,
  requestCanvasDocumentCloseApproval,
} from "../src/lib/canvasDocumentLifecycle";

import {
  isWorkbookSnapshotForPath,
  shouldBlockSpreadsheetUnload,
  shouldDeferExternalWorkbookReload,
} from "../src/lib/univerSaveState";
import {
  cloneUniverWorkbookData,
  diffUniverWorkbookPatches,
  spreadsheetSnapshotToUniverData,
} from "../src/lib/univerSpreadsheet";
import { canExecuteSpreadsheetCommand } from "../src/ui/univerCommandPolicy";
import { setupJsdom } from "./jsdomHarness";

for (const [packageName, presetName] of [
  ["core", "UniverSheetsCorePreset"],
  ["sort", "UniverSheetsSortPreset"],
  ["find-replace", "UniverSheetsFindReplacePreset"],
]) {
  mock.module(`@univerjs/preset-sheets-${packageName}`, () => ({
    [presetName!]: () => ({}),
  }));
}
mock.module("@univerjs/preset-sheets-core/lib/worker.js?url", () => ({
  default: "test-worker.js",
}));
const createUniverMock = mock();
mock.module("@univerjs/presets", () => ({ createUniver: createUniverMock }));

const { UniverSpreadsheetCanvas } = await import("../src/ui/UniverSpreadsheetCanvas");

const WORKBOOK: SpreadsheetWorkbookSnapshot = {
  kind: "xlsx",
  path: "/workspace/model.xlsx",
  filename: "model.xlsx",
  fileVersion: { modifiedAtMs: 1, changeTimeMs: 1, size: 1, fingerprint: "original" },
  activeSheetName: "Summary",
  warnings: [],
  sheets: [
    {
      id: "summary",
      name: "Summary",
      rowCount: 1,
      colCount: 1,
      hidden: false,
      cells: [{ row: 0, col: 0, address: "A1", value: "Original", rawValue: "Original" }],
      mergedCells: [],
      columnWidths: [],
      tables: [],
      charts: [],
    },
  ],
};

const UNSUPPORTED_XLSX_TYPED_VALUES = [
  { v: "001", t: CellValueType.FORCE_STRING },
  { v: "=1+2", t: CellValueType.FORCE_STRING },
  { v: " 001 ", t: CellValueType.STRING },
  { v: "-0.50", t: CellValueType.STRING },
  { v: true, t: CellValueType.BOOLEAN },
  { v: 0, t: CellValueType.BOOLEAN },
  { v: "TRUE" },
  { v: "false" },
];

type PreviewActions = Pick<
  ReturnType<typeof useAppStore.getState>,
  | "loadSpreadsheetWorkbook"
  | "loadSpreadsheetFileVersion"
  | "patchSpreadsheetWorkbook"
  | "sendMessage"
>;

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

async function mountSpreadsheet(overrides: Partial<PreviewActions> = {}) {
  const initialState = useAppStore.getState();
  const harness = setupJsdom({
    extraGlobals: {
      Worker: class {
        terminate() {}
      },
    },
  });
  const container = harness.dom.window.document.getElementById("root");
  if (!container) throw new Error("Missing test root");
  const root = createRoot(container);
  let currentData = spreadsheetSnapshotToUniverData(WORKBOOK);
  const saveSnapshot = mock(() => currentData);
  const lookupStyle = mock((id: string) => currentData.styles[id]);
  let onCommandExecuted = (_command: ICommandInfo) => {};
  let beforeCommand = (_command: ICommandInfo & { cancel?: boolean }) => {};
  const workbookApi = {
    getSheetByName: () => ({ getSheetName: () => "Summary" }),
    setActiveSheet: () => ({ getSheetName: () => "Summary" }),
    getActiveSheet: () => ({ getSheetName: () => "Summary" }),
    getActiveRange: () => null,
    getActiveCell: () => null,
    save: saveSnapshot,
    getWorkbook: () => ({ getStyles: () => ({ get: lookupStyle }) }),
    onSelectionChange: () => ({ dispose() {} }),
    onCommandExecuted: (callback: typeof onCommandExecuted) => {
      onCommandExecuted = callback;
      return { dispose() {} };
    },
  };
  const createWorkbook = mock((data: IWorkbookData) => {
    currentData = cloneUniverWorkbookData(data);
    return workbookApi;
  });
  const dispose = mock(() => {});
  createUniverMock.mockImplementation(() => ({
    univer: { dispose },
    univerAPI: {
      createWorkbook,
      Event: { BeforeCommandExecute: "BeforeCommandExecute" },
      addEvent: (_event: string, callback: typeof beforeCommand) => {
        beforeCommand = callback;
        return { dispose() {} };
      },
    },
  }));
  const actions: PreviewActions = {
    loadSpreadsheetWorkbook: async () => ({ ok: true, workbook: WORKBOOK }),
    loadSpreadsheetFileVersion: async () => ({ ok: true, version: WORKBOOK.fileVersion }),
    patchSpreadsheetWorkbook: async () => ({ ok: true }),
    sendMessage: async () => true,
    ...overrides,
  };
  useAppStore.setState({
    ...actions,
    selectedWorkspaceId: "workspace-a",
    selectedThreadId: "thread-a",
    workspaces: [
      {
        id: "workspace-a",
        name: "Workspace",
        path: "/workspace",
        createdAt: "2026-09-01T00:00:00.000Z",
        lastOpenedAt: "2026-09-01T00:00:00.000Z",
        defaultEnableMcp: true,
        defaultBackupsEnabled: true,
        yolo: false,
      },
    ],
    threads: ["thread-a", "thread-b"].map((id) => ({
      id,
      workspaceId: "workspace-a",
      title: id,
      createdAt: "2026-09-01T00:00:00.000Z",
      lastMessageAt: "2026-09-01T00:00:00.000Z",
      status: "active",
      sessionId: id,
      messageCount: 0,
      lastEventSeq: 0,
    })),
  });
  await act(async () => {
    root.render(createElement(UniverSpreadsheetCanvas, { path: WORKBOOK.path }));
  });

  return {
    container,
    createWorkbook,
    dispose,
    data: () => currentData,
    saveSnapshot,
    lookupStyle,
    beforeCommand,
    edit: async (value: string) => {
      const cell = currentData.sheets.summary?.cellData?.[0]?.[0];
      if (!cell) throw new Error("Missing editable cell");
      await act(async () => {
        cell.v = value;
        onCommandExecuted({ id: "sheet.mutation.set-range-values", type: CommandType.MUTATION });
      });
    },
    focus: async () => {
      await act(async () => {
        harness.dom.window.dispatchEvent(new harness.dom.window.Event("focus"));
      });
    },
    flush: async () => {
      await act(async () => {
        harness.dom.window.dispatchEvent(
          new harness.dom.window.Event("beforeunload", { cancelable: true }),
        );
      });
    },
    clickButton: async (label: string) => {
      const button = Array.from(container.querySelectorAll("button")).find(
        (candidate) =>
          candidate.textContent === label || candidate.getAttribute("aria-label") === label,
      );
      if (!button) throw new Error(`Missing button: ${label}`);
      await act(async () => button.click());
    },
    prompt: async (text: string) => {
      const input = container.querySelector<HTMLInputElement>(
        'input[aria-label="Spreadsheet prompt"]',
      );
      if (!input) throw new Error("Missing prompt input");
      const setValue = Object.getOwnPropertyDescriptor(
        harness.dom.window.HTMLInputElement.prototype,
        "value",
      )?.set;
      if (!setValue) throw new Error("Missing input setter");
      await act(async () => {
        setValue.call(input, text);
        // React is preloaded before jsdom, so drive the controlled-field prop too.
        const propsKey = Object.keys(input).find((key) => key.startsWith("__reactProps$"));
        const props = propsKey
          ? ((input as unknown as Record<string, unknown>)[propsKey] as {
              onChange?: (event: {
                target: HTMLInputElement;
                currentTarget: HTMLInputElement;
              }) => void;
            })
          : {};
        props.onChange?.({ target: input, currentTarget: input });
        input.dispatchEvent(new harness.dom.window.Event("input", { bubbles: true }));
      });
    },
    submit: async () => {
      const form = container.querySelector("form");
      if (!form) throw new Error("Missing prompt form");
      await act(async () => {
        form.dispatchEvent(
          new harness.dom.window.Event("submit", { bubbles: true, cancelable: true }),
        );
      });
    },
    render: async (path: string) => {
      await act(async () => root.render(createElement(UniverSpreadsheetCanvas, { path })));
    },
    unmount: async () => {
      await act(async () => root.unmount());
    },
    restore: async () => {
      await act(async () => root.unmount());
      useAppStore.setState(initialState);
      harness.restore();
    },
  };
}

describe("Univer save state helpers", () => {
  test("defers external reload while local edits may be unsaved", () => {
    expect(shouldDeferExternalWorkbookReload("dirty")).toBe(true);
    expect(shouldDeferExternalWorkbookReload("saving")).toBe(true);
    expect(shouldDeferExternalWorkbookReload("error")).toBe(true);
  });

  test("allows external reload when there are no pending local edits", () => {
    expect(shouldDeferExternalWorkbookReload("idle")).toBe(false);
    expect(shouldDeferExternalWorkbookReload("saved")).toBe(false);
  });

  test("blocks window unload while failed saves may still hold local edits", () => {
    expect(shouldBlockSpreadsheetUnload("dirty", null)).toBe(true);
    expect(shouldBlockSpreadsheetUnload("saving", null)).toBe(true);
    expect(shouldBlockSpreadsheetUnload("error", null)).toBe(true);
    expect(shouldBlockSpreadsheetUnload("idle", Promise.resolve(true))).toBe(true);
    expect(shouldBlockSpreadsheetUnload("idle", null)).toBe(false);
    expect(shouldBlockSpreadsheetUnload("saved", null)).toBe(false);
  });

  test("identifies workbook snapshots that belong to the current canvas path", () => {
    expect(isWorkbookSnapshotForPath({ path: "/tmp/model.xlsx" }, "/tmp/model.xlsx")).toBe(true);
    expect(isWorkbookSnapshotForPath({ path: "/tmp/old.xlsx" }, "/tmp/model.xlsx")).toBe(false);
    expect(isWorkbookSnapshotForPath(null, "/tmp/model.xlsx")).toBe(false);
  });

  test.serial(
    "keeps local edits and the original version when a conflict removes their sheet",
    async () => {
      const diskWorkbook: SpreadsheetWorkbookSnapshot = {
        ...WORKBOOK,
        fileVersion: { modifiedAtMs: 2, changeTimeMs: 2, size: 2, fingerprint: "sheet-removed" },
        activeSheetName: "Other",
        sheets: [{ ...WORKBOOK.sheets[0]!, id: "other", name: "Other", cells: [] }],
      };
      const loadWorkbook = mock(async () => ({ ok: true as const, workbook: diskWorkbook }));
      loadWorkbook.mockResolvedValueOnce({ ok: true, workbook: WORKBOOK });
      const patchWorkbook = mock(async () => ({
        ok: false as const,
        error: { kind: "write_error" as const, message: "The workbook changed on disk." },
      }));
      const canvas = await mountSpreadsheet({
        loadSpreadsheetWorkbook: loadWorkbook,
        loadSpreadsheetFileVersion: async () => ({ ok: true, version: diskWorkbook.fileVersion }),
        patchSpreadsheetWorkbook: patchWorkbook,
      });

      try {
        await canvas.edit("Local edit");
        await canvas.focus();
        await canvas.flush();

        expect(canvas.createWorkbook).toHaveBeenCalledTimes(1);
        expect(canvas.dispose).not.toHaveBeenCalled();
        expect(canvas.data().sheets.summary?.cellData?.[0]?.[0]?.v).toBe("Local edit");
        expect(canvas.container.querySelector('[role="alert"]')?.textContent).toContain("Summary");
        expect(canvas.container.querySelector('[role="alert"]')?.textContent).toContain(
          "still open",
        );

        await canvas.clickButton("Retry save");
        expect(patchWorkbook).toHaveBeenCalledTimes(2);
        expect(patchWorkbook.mock.calls[1]).toEqual([
          WORKBOOK.path,
          [{ type: "cell", sheetName: "Summary", address: "A1", rawInput: "Local edit" }],
          WORKBOOK.fileVersion,
          "workspace-a",
        ]);
        expect(canvas.createWorkbook).toHaveBeenCalledTimes(1);
      } finally {
        await canvas.restore();
      }
    },
  );

  test.serial("reports rejected saves and retries the same pending edits", async () => {
    const patchWorkbook = mock<PreviewActions["patchSpreadsheetWorkbook"]>(async () => ({
      ok: true,
    }));
    patchWorkbook.mockRejectedValueOnce(new Error("Workspace connection disconnected"));
    const canvas = await mountSpreadsheet({ patchSpreadsheetWorkbook: patchWorkbook });
    try {
      await canvas.edit("Unsaved value");
      await canvas.flush();

      expect(canvas.container.textContent).toContain("Save failed");
      expect(canvas.container.querySelector('[role="alert"]')?.textContent).toContain(
        "disconnected",
      );
      expect(canvas.data().sheets.summary?.cellData?.[0]?.[0]?.v).toBe("Unsaved value");
      await canvas.clickButton("Retry save");
      expect(patchWorkbook).toHaveBeenCalledTimes(2);
      expect(patchWorkbook.mock.calls[1]?.[1]).toEqual(patchWorkbook.mock.calls[0]?.[1]);
      expect(canvas.container.textContent).not.toContain("Save failed");
    } finally {
      await canvas.restore();
    }
  });

  test.serial("retries rejected disk-version polling without discarding the editor", async () => {
    const loadVersion = mock<PreviewActions["loadSpreadsheetFileVersion"]>(async () => ({
      ok: true,
      version: WORKBOOK.fileVersion,
    }));
    loadVersion.mockRejectedValueOnce(new Error("Version request disconnected"));
    const canvas = await mountSpreadsheet({ loadSpreadsheetFileVersion: loadVersion });
    try {
      await canvas.focus();
      expect(canvas.container.textContent).toContain("Retrying disk sync");
      await canvas.focus();
      expect(loadVersion).toHaveBeenCalledTimes(2);
      expect(canvas.createWorkbook).toHaveBeenCalledTimes(1);
      expect(canvas.container.textContent).not.toContain("Retrying disk sync");
    } finally {
      await canvas.restore();
    }
  });

  test.serial(
    "deduplicates prompt submits and keeps the original thread after context loading",
    async () => {
      const pendingContext =
        deferred<Awaited<ReturnType<PreviewActions["loadSpreadsheetWorkbook"]>>>();
      const loadWorkbook = mock<PreviewActions["loadSpreadsheetWorkbook"]>(
        () => pendingContext.promise,
      );
      loadWorkbook.mockResolvedValueOnce({ ok: true, workbook: WORKBOOK });
      const sendMessage = mock<PreviewActions["sendMessage"]>(async () => true);
      const canvas = await mountSpreadsheet({ loadSpreadsheetWorkbook: loadWorkbook, sendMessage });
      try {
        await canvas.prompt("Explain this selection");
        await canvas.submit();
        await canvas.submit();
        expect(loadWorkbook).toHaveBeenCalledTimes(2);
        await act(async () => {
          useAppStore.setState({ selectedThreadId: "thread-b" });
          pendingContext.resolve({ ok: true, workbook: WORKBOOK });
        });
        expect(sendMessage).toHaveBeenCalledTimes(1);
        expect(sendMessage.mock.calls[0]?.[4]).toMatchObject({ targetThreadId: "thread-a" });
      } finally {
        pendingContext.resolve({ ok: true, workbook: WORKBOOK });
        await canvas.restore();
      }
    },
  );

  test.serial(
    "cancels prompt handoff when its workspace changes while loading context",
    async () => {
      const pendingContext =
        deferred<Awaited<ReturnType<PreviewActions["loadSpreadsheetWorkbook"]>>>();
      const loadWorkbook = mock<PreviewActions["loadSpreadsheetWorkbook"]>(
        () => pendingContext.promise,
      );
      loadWorkbook.mockResolvedValueOnce({ ok: true, workbook: WORKBOOK });
      const sendMessage = mock<PreviewActions["sendMessage"]>(async () => true);
      const canvas = await mountSpreadsheet({ loadSpreadsheetWorkbook: loadWorkbook, sendMessage });
      try {
        await canvas.prompt("Explain this selection");
        await canvas.submit();
        await act(async () => {
          useAppStore.setState({ selectedWorkspaceId: "workspace-b" });
          pendingContext.resolve({ ok: true, workbook: WORKBOOK });
        });
        expect(sendMessage).not.toHaveBeenCalled();
      } finally {
        pendingContext.resolve({ ok: true, workbook: WORKBOOK });
        await canvas.restore();
      }
    },
  );

  test.serial(
    "flushes edits made during close approval without disposing the workbook",
    async () => {
      const pendingPatch =
        deferred<Awaited<ReturnType<PreviewActions["patchSpreadsheetWorkbook"]>>>();
      const patchWorkbook = mock<PreviewActions["patchSpreadsheetWorkbook"]>(async () => ({
        ok: true,
      }));
      patchWorkbook.mockImplementationOnce(() => pendingPatch.promise);
      const canvas = await mountSpreadsheet({ patchSpreadsheetWorkbook: patchWorkbook });
      const unregisterVeto = registerCanvasDocumentTransitionHandler(async () => false);
      let approval: Promise<boolean> | undefined;
      try {
        await canvas.edit("First edit");
        await act(async () => {
          approval = requestCanvasDocumentCloseApproval();
        });
        expect(patchWorkbook).toHaveBeenCalledTimes(1);
        expect(canvas.dispose).not.toHaveBeenCalled();
        await canvas.edit("Edit during save");
        await act(async () => {
          pendingPatch.resolve({ ok: true });
          expect(await approval).toBe(false);
        });
        expect(patchWorkbook).toHaveBeenCalledTimes(2);
        expect(patchWorkbook.mock.calls[1]?.[1]).toEqual([
          { type: "cell", sheetName: "Summary", address: "A1", rawInput: "Edit during save" },
        ]);
        expect(canvas.createWorkbook).toHaveBeenCalledTimes(1);
        expect(canvas.dispose).not.toHaveBeenCalled();

        unregisterVeto();
        patchWorkbook.mockRejectedValueOnce(new Error("Save unavailable"));
        await canvas.edit("Still editable after canceled close");
        await act(async () => expect(await requestCanvasDocumentCloseApproval()).toBe(false));
        expect(canvas.data().sheets.summary?.cellData?.[0]?.[0]?.v).toBe(
          "Still editable after canceled close",
        );
        expect(canvas.dispose).not.toHaveBeenCalled();
      } finally {
        pendingPatch.resolve({ ok: true });
        unregisterVeto();
        await canvas.restore();
      }
    },
  );

  test.serial(
    "does not mark an accepted write as failed when its version refresh rejects",
    async () => {
      const loadVersion = mock<PreviewActions["loadSpreadsheetFileVersion"]>(async () => ({
        ok: true,
        version: WORKBOOK.fileVersion,
      }));
      loadVersion.mockRejectedValueOnce(new Error("Version refresh disconnected"));
      const patchWorkbook = mock<PreviewActions["patchSpreadsheetWorkbook"]>(async () => ({
        ok: true,
      }));
      const canvas = await mountSpreadsheet({
        loadSpreadsheetFileVersion: loadVersion,
        patchSpreadsheetWorkbook: patchWorkbook,
      });
      try {
        await canvas.edit("Saved value");
        await canvas.clickButton("Save workbook");
        expect(patchWorkbook).toHaveBeenCalledTimes(1);
        expect(canvas.container.textContent).toContain("Edits saved. Retrying disk sync");
        expect(canvas.container.textContent).not.toContain("Save failed");
        expect(canvas.container.querySelector('[role="alert"]')).toBeNull();
      } finally {
        await canvas.restore();
      }
    },
  );

  test.serial("retains a prompt when sending rejects and lets the user retry", async () => {
    const sendMessage = mock<PreviewActions["sendMessage"]>(async () => true);
    sendMessage.mockRejectedValueOnce(new Error("Chat disconnected"));
    const canvas = await mountSpreadsheet({ sendMessage });
    try {
      await canvas.prompt("Keep this request");
      await canvas.submit();
      const input = canvas.container.querySelector<HTMLInputElement>(
        'input[aria-label="Spreadsheet prompt"]',
      );
      expect(input?.value).toBe("Keep this request");
      expect(input?.disabled).toBe(false);
      expect(canvas.container.querySelector('[role="alert"]')?.textContent).toContain(
        "Chat disconnected",
      );
      await canvas.submit();
      expect(sendMessage).toHaveBeenCalledTimes(2);
      expect(input?.value).toBe("");
    } finally {
      await canvas.restore();
    }
  });

  test.serial(
    "finishes an unmounted save in its original workspace without replaying accepted edits",
    async () => {
      const pendingPatch =
        deferred<Awaited<ReturnType<PreviewActions["patchSpreadsheetWorkbook"]>>>();
      const patchWorkbook = mock<PreviewActions["patchSpreadsheetWorkbook"]>(async () => ({
        ok: true,
      }));
      patchWorkbook.mockImplementationOnce(() => pendingPatch.promise);
      const canvas = await mountSpreadsheet({ patchSpreadsheetWorkbook: patchWorkbook });
      try {
        await canvas.edit("Accepted value");
        await canvas.flush();
        await canvas.unmount();
        await act(async () => {
          useAppStore.setState({ selectedWorkspaceId: "workspace-b" });
          pendingPatch.resolve({ ok: true });
        });
        expect(patchWorkbook).toHaveBeenCalledTimes(1);
        expect(patchWorkbook.mock.calls[0]?.[3]).toBe("workspace-a");
        expect(canvas.dispose).toHaveBeenCalledTimes(1);
      } finally {
        pendingPatch.resolve({ ok: true });
        await canvas.restore();
      }
    },
  );

  test.serial(
    "does not replace edits made while an external workbook reload is pending",
    async () => {
      const pendingReload =
        deferred<Awaited<ReturnType<PreviewActions["loadSpreadsheetWorkbook"]>>>();
      const loadWorkbook = mock<PreviewActions["loadSpreadsheetWorkbook"]>(
        () => pendingReload.promise,
      );
      loadWorkbook.mockResolvedValueOnce({ ok: true, workbook: WORKBOOK });
      const nextVersion = { ...WORKBOOK.fileVersion, fingerprint: "external-change" };
      const canvas = await mountSpreadsheet({
        loadSpreadsheetWorkbook: loadWorkbook,
        loadSpreadsheetFileVersion: async () => ({ ok: true, version: nextVersion }),
      });
      try {
        await canvas.focus();
        expect(loadWorkbook).toHaveBeenCalledTimes(2);
        await canvas.edit("Edit while reloading");
        await act(async () =>
          pendingReload.resolve({
            ok: true,
            workbook: { ...WORKBOOK, fileVersion: nextVersion },
          }),
        );
        expect(canvas.createWorkbook).toHaveBeenCalledTimes(1);
        expect(canvas.data().sheets.summary?.cellData?.[0]?.[0]?.v).toBe("Edit while reloading");
        expect(canvas.container.textContent).toContain("Unsaved changes");
      } finally {
        pendingReload.resolve({ ok: true, workbook: WORKBOOK });
        await canvas.restore();
      }
    },
  );
  test.serial(
    "cancels unsupported workbook commands before they can mark the editor dirty",
    async () => {
      const patchWorkbook = mock<PreviewActions["patchSpreadsheetWorkbook"]>(async () => ({
        ok: true,
      }));
      const canvas = await mountSpreadsheet({ patchSpreadsheetWorkbook: patchWorkbook });
      try {
        for (const command of [
          { id: "sheet.command.set-range-underline", type: CommandType.COMMAND },
          { id: "sheet.command.insert-row-after", type: CommandType.COMMAND },
          { id: "sheet.command.move-range", type: CommandType.COMMAND },
          {
            id: "sheet.command.set-style",
            type: CommandType.COMMAND,
            params: { style: { type: "ff", value: "Comic Sans" } },
          },
          { id: "sheet.mutation.set-worksheet-row-height", type: CommandType.MUTATION },
          { id: "sheet.mutation.insert-sheet", type: CommandType.MUTATION },
          { id: "sheet.mutation.set-frozen", type: CommandType.MUTATION },
          { id: "sheet.mutation.unknown-future-edit", type: CommandType.MUTATION },
          {
            id: "sheet.mutation.set-range-values",
            type: CommandType.MUTATION,
            params: { cellValue: { 0: { 0: { s: { bd: {} } } } } },
          },
          {
            id: "sheet.mutation.set-range-values",
            type: CommandType.MUTATION,
            params: { cellValue: { 0: { 0: { s: { bg: { theme: 1 } } } } } },
          },
          {
            id: "sheet.mutation.set-range-values",
            type: CommandType.MUTATION,
            params: { cellValue: { 0: { 0: { p: { body: { dataStream: "rich text\r\n" } } } } } },
          },
          {
            id: "sheet.mutation.set-range-values",
            type: CommandType.MUTATION,
            params: { cellValue: { 0: { 0: { v: "", p: { drawingsOrder: ["drawing-id"] } } } } },
          },
          {
            id: "sheet.mutation.set-range-values",
            type: CommandType.MUTATION,
            params: { cellValue: { 0: { 0: { f: "=SUM(A1:A5)", ref: "B1:B5" } } } },
          },
        ]) {
          const event: ICommandInfo & { cancel?: boolean } = { ...command };
          await act(async () => canvas.beforeCommand(event));
          expect(event.cancel).toBe(true);
        }
        expect(canvas.container.textContent).toContain("cannot be saved");
        expect(canvas.container.textContent).not.toContain("Unsaved changes");
        await act(async () => expect(await requestCanvasDocumentCloseApproval()).toBe(true));
        expect(patchWorkbook).not.toHaveBeenCalled();
      } finally {
        await canvas.restore();
      }
    },
  );
  test.serial("rejects XLSX typed values that the save bridge would reinterpret", async () => {
    const patchWorkbook = mock<PreviewActions["patchSpreadsheetWorkbook"]>(async () => ({
      ok: true,
    }));
    const canvas = await mountSpreadsheet({ patchSpreadsheetWorkbook: patchWorkbook });
    try {
      for (const cell of UNSUPPORTED_XLSX_TYPED_VALUES) {
        const event: ICommandInfo & { cancel?: boolean } = {
          id: "sheet.mutation.set-range-values",
          type: CommandType.MUTATION,
          params: { cellValue: { 0: { 0: cell } } },
        };
        await act(async () => canvas.beforeCommand(event));
        expect(event.cancel).toBe(true);
      }
      for (const cell of [
        { v: "Invoice", t: CellValueType.STRING },
        { v: 42, t: CellValueType.NUMBER },
        { f: "=1+2", t: CellValueType.BOOLEAN },
      ]) {
        const event: ICommandInfo & { cancel?: boolean } = {
          id: "sheet.mutation.set-range-values",
          type: CommandType.MUTATION,
          params: { cellValue: { 0: { 0: cell } } },
        };
        await act(async () => canvas.beforeCommand(event));
        expect(event.cancel).not.toBe(true);
      }
      expect(canvas.container.textContent).toContain(
        "Literal numeric or formula-like text and Boolean values cannot be saved here",
      );
      expect(canvas.data().sheets.summary?.cellData?.[0]?.[0]?.v).toBe("Original");
      expect(canvas.container.textContent).not.toContain("Unsaved changes");
      await act(async () => expect(await requestCanvasDocumentCloseApproval()).toBe(true));
      expect(patchWorkbook).not.toHaveBeenCalled();
    } finally {
      await canvas.restore();
    }
  });

  test.serial("validates styled paste without cloning the workbook for each cell", async () => {
    const canvas = await mountSpreadsheet();
    try {
      canvas.data().styles.supported = { bl: 1 };
      canvas.data().styles.unsupported = { ff: "Comic Sans" };
      const pastedRow = Object.fromEntries(
        Array.from({ length: 500 }, (_, index) => [index, { v: `Cell ${index}`, s: "supported" }]),
      );
      for (const blocked of [false, true]) {
        canvas.saveSnapshot.mockClear();
        canvas.lookupStyle.mockClear();
        const event: ICommandInfo & { cancel?: boolean } = {
          id: "sheet.mutation.set-range-values",
          type: CommandType.MUTATION,
          params: {
            cellValue: { 0: { ...pastedRow, ...(blocked ? { 500: { s: "unsupported" } } : {}) } },
          },
        };
        await act(async () => canvas.beforeCommand(event));
        expect(event.cancel === true).toBe(blocked);
        expect(canvas.saveSnapshot).not.toHaveBeenCalled();
        expect(canvas.lookupStyle).toHaveBeenCalledTimes(blocked ? 2 : 1);
      }
    } finally {
      await canvas.restore();
    }
  });

  test.each(["csv", "xlsx"] as const)(
    "round-trips supported %s commands through the real save bridge",
    async (kind) => {
      const dir = await fs.mkdtemp(path.join(scratchRoots()[0]!, "cowork-univer-roundtrip-"));
      const filePath = path.join(dir, `model.${kind}`);
      const univer = new Univer();
      const api = FUniver.newAPI(univer);
      try {
        if (kind === "csv") {
          await fs.writeFile(filePath, "Original,\n");
        } else {
          const workbook = XLSX.utils.book_new();
          XLSX.utils.book_append_sheet(
            workbook,
            XLSX.utils.aoa_to_sheet([["Original", ""]]),
            "Summary",
          );
          await fs.writeFile(filePath, XLSX.write(workbook, { type: "buffer", bookType: "xlsx" }));
        }
        const initial = await readSpreadsheetWorkbookSnapshot({ cwd: dir, filePath });
        if (!initial.ok) throw new Error(initial.error.message);
        const baseline = spreadsheetSnapshotToUniverData(initial.workbook);
        const workbook = univer.createUnit(
          UniverInstanceType.UNIVER_SHEET,
          cloneUniverWorkbookData(baseline),
        );
        const commands = univer.__getInjector().get(ICommandService);
        for (const mutation of [
          SetRangeValuesMutation,
          SetWorksheetColWidthMutation,
          SetWorksheetRowHeightMutation,
          AddWorksheetMergeMutation,
        ]) {
          commands.registerCommand(mutation);
        }
        api.addEvent(api.Event.BeforeCommandExecute, (event) => {
          if (
            !canExecuteSpreadsheetCommand(
              event,
              kind,
              (id) => workbook.getSnapshot().styles[id] ?? null,
            )
          )
            event.cancel = true;
        });
        const target = { unitId: baseline.id, subUnitId: baseline.sheetOrder[0] };
        const range = { startRow: 0, endRow: 0, startColumn: 0, endColumn: 0 };
        commands.registerCommand({
          id: "test.command.resize-row-shortcut",
          type: CommandType.COMMAND,
          handler: () =>
            commands.syncExecuteCommand(SetWorksheetRowHeightMutation.id, {
              ...target,
              ranges: [range],
              rowHeight: 99,
            }),
        });
        expect(commands.syncExecuteCommand("test.command.resize-row-shortcut")).toBe(false);
        if (kind === "xlsx") {
          for (const cell of UNSUPPORTED_XLSX_TYPED_VALUES) {
            expect(
              commands.syncExecuteCommand(SetRangeValuesMutation.id, {
                ...target,
                cellValue: { 0: { 0: cell } },
              }),
            ).toBe(false);
            expect(workbook.getSnapshot().sheets[target.subUnitId!]?.cellData?.[0]?.[0]?.v).toBe(
              "Original",
            );
          }
          expect(
            diffUniverWorkbookPatches(baseline, workbook.getSnapshot(), {
              includeFormatting: true,
            }),
          ).toEqual([]);
          const unchanged = await readSpreadsheetWorkbookSnapshot({ cwd: dir, filePath });
          if (!unchanged.ok) throw new Error(unchanged.error.message);
          expect(unchanged.workbook.fileVersion).toEqual(initial.workbook.fileVersion);
          expect(unchanged.workbook.sheets[0]?.cells[0]?.value).toBe("Original");
        }
        expect(
          commands.syncExecuteCommand(SetRangeValuesMutation.id, {
            ...target,
            cellValue: { 0: { 0: { v: 42, t: CellValueType.NUMBER } } },
          }),
        ).toBe(true);
        expect(workbook.getSnapshot().sheets[target.subUnitId!]?.cellData?.[0]?.[0]?.v).toBe(42);
        expect(
          commands.syncExecuteCommand(SetRangeValuesMutation.id, {
            ...target,
            cellValue: { 0: { 0: { v: "Typed value" } } },
          }),
        ).toBe(true);
        expect(
          commands.syncExecuteCommand(SetRangeValuesMutation.id, {
            ...target,
            cellValue: {
              1: {
                0: { v: "Pasted value" },
                1: kind === "xlsx" ? { f: "=1+2" } : { v: "001", t: CellValueType.STRING },
              },
            },
          }),
        ).toBe(true);
        const style = {
          bl: 1,
          it: 1,
          fs: 14,
          bg: { rgb: "#FFEEDD" },
          cl: { rgb: "#112233" },
          n: { pattern: "0.00" },
          ht: HorizontalAlign.CENTER,
        };
        expect(
          commands.syncExecuteCommand(SetRangeValuesMutation.id, {
            ...target,
            cellValue: { 0: { 0: { s: style } } },
          }),
        ).toBe(kind === "xlsx");
        if (kind === "xlsx") {
          expect(
            commands.syncExecuteCommand(SetWorksheetColWidthMutation.id, {
              ...target,
              ranges: [range],
              colWidth: 140,
            }),
          ).toBe(true);
          expect(
            commands.syncExecuteCommand(AddWorksheetMergeMutation.id, {
              ...target,
              ranges: [{ startRow: 2, endRow: 2, startColumn: 0, endColumn: 1 }],
            }),
          ).toBe(true);
        }
        const operations = diffUniverWorkbookPatches(baseline, workbook.getSnapshot(), {
          includeFormatting: kind === "xlsx",
        });
        expect(
          await patchSpreadsheetBatch({
            cwd: dir,
            filePath,
            operations,
            expectedFileVersion: initial.workbook.fileVersion,
          }),
        ).toEqual({ ok: true });
        const reloaded = await readSpreadsheetWorkbookSnapshot({ cwd: dir, filePath });
        if (!reloaded.ok) throw new Error(reloaded.error.message);
        const sheet = reloaded.workbook.sheets[0];
        expect(sheet?.cells.find((cell) => cell.address === "A1")?.value).toBe("Typed value");
        expect(sheet?.cells.find((cell) => cell.address === "A2")?.value).toBe("Pasted value");
        if (kind === "xlsx") {
          expect(sheet?.cells.find((cell) => cell.address === "B2")?.formula).toBe("1+2");
          expect(sheet?.cells.find((cell) => cell.address === "A1")?.style).toMatchObject({
            bold: true,
            italic: true,
            fontSize: 14,
            fillColor: "#FFEEDD",
            textColor: "#112233",
            numberFormat: "0.00",
            horizontalAlign: "center",
          });
          expect(sheet?.mergedCells[0]?.ref).toBe("A3:B3");
          const saved = spreadsheetSnapshotToUniverData(reloaded.workbook);
          expect(saved.sheets[saved.sheetOrder[0]!]?.columnData?.[0]?.w).toBeCloseTo(140, 0);
        } else {
          expect(sheet?.cells.find((cell) => cell.address === "B2")?.value).toBe("001");
          expect(sheet?.cells.find((cell) => cell.address === "A1")?.style).toBeUndefined();
        }
      } finally {
        api.dispose();
        univer.dispose();
        await fs.rm(dir, { recursive: true, force: true });
      }
    },
  );
});
