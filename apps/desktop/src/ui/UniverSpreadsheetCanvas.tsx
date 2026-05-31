import "@univerjs/preset-sheets-core/lib/index.css";
import "@univerjs/preset-sheets-filter/lib/index.css";
import "@univerjs/preset-sheets-sort/lib/index.css";
import "@univerjs/preset-sheets-data-validation/lib/index.css";
import "@univerjs/preset-sheets-conditional-formatting/lib/index.css";
import "@univerjs/preset-sheets-find-replace/lib/index.css";
import "@univerjs/preset-sheets-note/lib/index.css";
import "@univerjs/preset-sheets-hyper-link/lib/index.css";
import "@univerjs/preset-sheets-table/lib/index.css";
import "@univerjs/preset-sheets-thread-comment/lib/index.css";

import {
  type IDisposable,
  type IRange,
  type IWorkbookData,
  LocaleType,
  mergeLocales,
} from "@univerjs/core";
import { UniverSheetsConditionalFormattingPreset } from "@univerjs/preset-sheets-conditional-formatting";
import sheetsConditionalFormattingEnUS from "@univerjs/preset-sheets-conditional-formatting/locales/en-US";
import { UniverSheetsCorePreset } from "@univerjs/preset-sheets-core";
import workerUrl from "@univerjs/preset-sheets-core/lib/worker.js?url";
import sheetsCoreEnUS from "@univerjs/preset-sheets-core/locales/en-US";
import { UniverSheetsDataValidationPreset } from "@univerjs/preset-sheets-data-validation";
import sheetsDataValidationEnUS from "@univerjs/preset-sheets-data-validation/locales/en-US";
import { UniverSheetsFilterPreset } from "@univerjs/preset-sheets-filter";
import sheetsFilterEnUS from "@univerjs/preset-sheets-filter/locales/en-US";
import { UniverSheetsFindReplacePreset } from "@univerjs/preset-sheets-find-replace";
import sheetsFindReplaceEnUS from "@univerjs/preset-sheets-find-replace/locales/en-US";
import { UniverSheetsHyperLinkPreset } from "@univerjs/preset-sheets-hyper-link";
import sheetsHyperLinkEnUS from "@univerjs/preset-sheets-hyper-link/locales/en-US";
import { UniverSheetsNotePreset } from "@univerjs/preset-sheets-note";
import sheetsNoteEnUS from "@univerjs/preset-sheets-note/locales/en-US";
import { UniverSheetsSortPreset } from "@univerjs/preset-sheets-sort";
import sheetsSortEnUS from "@univerjs/preset-sheets-sort/locales/en-US";
import { UniverSheetsTablePreset } from "@univerjs/preset-sheets-table";
import sheetsTableEnUS from "@univerjs/preset-sheets-table/locales/en-US";
import { UniverSheetsThreadCommentPreset } from "@univerjs/preset-sheets-thread-comment";
import sheetsThreadCommentEnUS from "@univerjs/preset-sheets-thread-comment/locales/en-US";
import { createUniver } from "@univerjs/presets";
import { AlertCircleIcon, CheckIcon, Loader2Icon, SaveIcon, SparklesIcon } from "lucide-react";
import { type FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";

import type {
  SpreadsheetFileVersion,
  SpreadsheetWorkbookSnapshot,
} from "../../../../src/shared/spreadsheetPreview";
import { useAppStore } from "../app/store";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { openExternalUrl } from "../lib/desktopCommands";
import {
  buildUniverSpreadsheetPrompt,
  cloneUniverWorkbookData,
  diffUniverWorkbookPatches,
  selectionContextFromWorkbook,
  spreadsheetSnapshotToUniverData,
  type UniverSelectionContext,
} from "../lib/univerSpreadsheet";
import { cn } from "../lib/utils";

type UniverSpreadsheetCanvasProps = {
  path: string;
  compact?: boolean;
};

type SaveState = "idle" | "dirty" | "saving" | "saved" | "error";
type UniverWorksheetApi = {
  getSheetName: () => string;
};
type UniverRangeApi = {
  getRange: () => IRange;
  getA1Notation: (withSheet?: boolean) => string;
};
type UniverWorkbookApi = {
  getSheetByName: (name: string) => UniverWorksheetApi | null;
  setActiveSheet: (sheet: UniverWorksheetApi | string) => UniverWorksheetApi;
  getActiveSheet: () => UniverWorksheetApi;
  getActiveRange: () => UniverRangeApi | null;
  getActiveCell: () => UniverRangeApi | null;
  save: () => IWorkbookData;
  onSelectionChange: (callback: (selections: IRange[]) => void) => IDisposable;
  onCommandExecuted: (callback: () => void) => IDisposable;
};

const univerLocales = {
  [LocaleType.EN_US]: mergeLocales(
    sheetsCoreEnUS,
    sheetsFilterEnUS,
    sheetsSortEnUS,
    sheetsDataValidationEnUS,
    sheetsConditionalFormattingEnUS,
    sheetsFindReplaceEnUS,
    sheetsNoteEnUS,
    sheetsHyperLinkEnUS,
    sheetsTableEnUS,
    sheetsThreadCommentEnUS,
  ),
};

export function UniverSpreadsheetCanvas({ path, compact = false }: UniverSpreadsheetCanvasProps) {
  const loadSpreadsheetWorkbook = useAppStore((s) => s.loadSpreadsheetWorkbook);
  const loadSpreadsheetFileVersion = useAppStore((s) => s.loadSpreadsheetFileVersion);
  const patchSpreadsheetWorkbook = useAppStore((s) => s.patchSpreadsheetWorkbook);
  const sendMessage = useAppStore((s) => s.sendMessage);
  const selectedThreadId = useAppStore((s) => s.selectedThreadId);

  const [workbook, setWorkbook] = useState<SpreadsheetWorkbookSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [selection, setSelection] = useState<UniverSelectionContext | null>(null);
  const [promptText, setPromptText] = useState("");
  const [saveState, setSaveState] = useState<SaveState>("idle");
  const [saveError, setSaveError] = useState<string | null>(null);
  const [reloadNotice, setReloadNotice] = useState<string | null>(null);

  const containerRef = useRef<HTMLDivElement>(null);
  const workbookApiRef = useRef<UniverWorkbookApi | null>(null);
  const workbookRef = useRef<SpreadsheetWorkbookSnapshot | null>(null);
  const selectionRef = useRef<UniverSelectionContext | null>(null);
  const saveStateRef = useRef<SaveState>("idle");
  const sourceVersionRef = useRef<SpreadsheetFileVersion | null>(null);
  const lastSavedDataRef = useRef<IWorkbookData | null>(null);
  const saveTimerRef = useRef<number | null>(null);
  const reloadNoticeTimerRef = useRef<number | null>(null);
  const externalReloadPendingRef = useRef(false);
  const reloadInFlightRef = useRef(false);
  const flushSaveRef = useRef<() => Promise<boolean>>(async () => true);

  useEffect(() => {
    workbookRef.current = workbook;
    if (workbook) sourceVersionRef.current = workbook.fileVersion;
  }, [workbook]);

  useEffect(() => {
    selectionRef.current = selection;
  }, [selection]);

  useEffect(() => {
    saveStateRef.current = saveState;
  }, [saveState]);

  useEffect(() => {
    return () => {
      if (reloadNoticeTimerRef.current !== null) {
        window.clearTimeout(reloadNoticeTimerRef.current);
        reloadNoticeTimerRef.current = null;
      }
    };
  }, []);

  const showReloadNotice = useCallback((message: string) => {
    setReloadNotice(message);
    if (reloadNoticeTimerRef.current !== null) {
      window.clearTimeout(reloadNoticeTimerRef.current);
    }
    reloadNoticeTimerRef.current = window.setTimeout(() => {
      reloadNoticeTimerRef.current = null;
      setReloadNotice(null);
    }, 2_500);
  }, []);

  const reloadWorkbookFromDisk = useCallback(
    async (notice = "Updated from disk") => {
      if (reloadInFlightRef.current) return;
      reloadInFlightRef.current = true;
      try {
        const currentWorkbook = workbookRef.current;
        const sheetName = selectionRef.current?.sheetName ?? currentWorkbook?.activeSheetName;
        const response = await loadSpreadsheetWorkbook(path, sheetName ? { sheetName } : undefined);
        if (!response.ok) {
          setSaveState("error");
          setSaveError(`Reload failed: ${response.error.message}`);
          return;
        }
        sourceVersionRef.current = response.workbook.fileVersion;
        externalReloadPendingRef.current = false;
        setWorkbook(response.workbook);
        setSaveError(null);
        setSaveState("idle");
        showReloadNotice(notice);
      } finally {
        reloadInFlightRef.current = false;
      }
    },
    [loadSpreadsheetWorkbook, path, showReloadNotice],
  );

  useEffect(() => {
    let active = true;
    setLoading(true);
    setLoadError(null);
    setWorkbook(null);
    setSelection(null);
    setSaveState("idle");
    setSaveError(null);
    setReloadNotice(null);
    sourceVersionRef.current = null;
    externalReloadPendingRef.current = false;

    void (async () => {
      try {
        const response = await loadSpreadsheetWorkbook(path);
        if (!active) return;
        if (!response.ok) {
          setLoadError(response.error.message);
          return;
        }
        sourceVersionRef.current = response.workbook.fileVersion;
        setWorkbook(response.workbook);
      } catch (error) {
        if (active) setLoadError(error instanceof Error ? error.message : String(error));
      } finally {
        if (active) setLoading(false);
      }
    })();

    return () => {
      active = false;
    };
  }, [loadSpreadsheetWorkbook, path]);

  useEffect(() => {
    if (!workbook) return;
    let active = true;

    const checkForExternalUpdate = async () => {
      const result = await loadSpreadsheetFileVersion(path);
      if (!active || !result.ok) return;
      const currentVersion = sourceVersionRef.current;
      if (!currentVersion) {
        sourceVersionRef.current = result.version;
        return;
      }
      if (result.version.fingerprint === currentVersion.fingerprint) return;

      if (saveStateRef.current === "dirty" || saveStateRef.current === "saving") {
        externalReloadPendingRef.current = true;
        showReloadNotice("File changed on disk; syncing after save");
        return;
      }

      await reloadWorkbookFromDisk("Updated from disk");
    };

    const intervalId = window.setInterval(() => {
      void checkForExternalUpdate();
    }, 2_000);
    window.addEventListener("focus", checkForExternalUpdate);

    return () => {
      active = false;
      window.clearInterval(intervalId);
      window.removeEventListener("focus", checkForExternalUpdate);
    };
  }, [loadSpreadsheetFileVersion, path, reloadWorkbookFromDisk, showReloadNotice, workbook]);

  useEffect(() => {
    if (!workbook || !containerRef.current) return;
    const container = containerRef.current;
    container.innerHTML = "";
    setSaveState("idle");
    setSaveError(null);

    const initialData = spreadsheetSnapshotToUniverData(workbook);
    const formulaWorker = new Worker(workerUrl, { type: "module" });
    const { univer, univerAPI } = createUniver({
      locale: LocaleType.EN_US,
      locales: univerLocales,
      presets: [
        UniverSheetsCorePreset({
          container,
          workerURL: formulaWorker,
          header: true,
          toolbar: true,
          ribbonType: "simple",
          contextMenu: true,
          formulaBar: true,
          sheets: {
            disableForceStringAlert: true,
            disableForceStringMark: true,
          },
          footer: {
            sheetBar: true,
            statisticBar: true,
            menus: true,
            zoomSlider: true,
          },
        }),
        UniverSheetsFilterPreset(),
        UniverSheetsSortPreset(),
        UniverSheetsDataValidationPreset(),
        UniverSheetsConditionalFormattingPreset(),
        UniverSheetsFindReplacePreset(),
        UniverSheetsNotePreset(),
        UniverSheetsHyperLinkPreset({
          urlHandler: {
            navigateToOtherWebsite: (url: string) => {
              void openExternalUrl({ url }).catch(() => {});
            },
          },
        }),
        UniverSheetsTablePreset(),
        UniverSheetsThreadCommentPreset(),
      ],
    });
    const fWorkbook = univerAPI.createWorkbook(initialData) as UniverWorkbookApi;
    const activeSheet = fWorkbook.getSheetByName(workbook.activeSheetName);
    if (activeSheet) fWorkbook.setActiveSheet(activeSheet);
    workbookApiRef.current = fWorkbook;
    lastSavedDataRef.current = cloneUniverWorkbookData(fWorkbook.save());

    const updateSelection = () => {
      const currentWorkbook = workbookApiRef.current;
      if (!currentWorkbook) return;
      const activeSheetApi = currentWorkbook.getActiveSheet();
      const range = currentWorkbook.getActiveRange()?.getRange() ?? null;
      const activeCell = currentWorkbook.getActiveCell()?.getA1Notation(false) ?? null;
      const data = currentWorkbook.save();
      setSelection(
        selectionContextFromWorkbook(
          workbook,
          data,
          activeSheetApi.getSheetName(),
          range,
          activeCell,
        ),
      );
    };

    const getPendingOperations = () => {
      const currentWorkbook = workbookApiRef.current;
      const previousData = lastSavedDataRef.current;
      if (!currentWorkbook || !previousData) return [];
      return diffUniverWorkbookPatches(
        previousData,
        cloneUniverWorkbookData(currentWorkbook.save()),
      );
    };

    const refreshSourceVersion = async () => {
      const result = await loadSpreadsheetFileVersion(path);
      if (result.ok) sourceVersionRef.current = result.version;
    };

    const persistWorkbook = async (): Promise<boolean> => {
      const currentWorkbook = workbookApiRef.current;
      const previousData = lastSavedDataRef.current;
      if (!currentWorkbook || !previousData) return true;

      const currentData = cloneUniverWorkbookData(currentWorkbook.save());
      const operations = diffUniverWorkbookPatches(previousData, currentData);
      if (operations.length === 0) {
        setSaveState("idle");
        return true;
      }

      setSaveState("saving");
      setSaveError(null);
      const result = await patchSpreadsheetWorkbook(path, operations);
      if (!result.ok) {
        setSaveState("error");
        setSaveError(result.error.message);
        return false;
      }
      lastSavedDataRef.current = currentData;
      await refreshSourceVersion();
      setSaveState("saved");
      window.setTimeout(() => {
        setSaveState((current) => (current === "saved" ? "idle" : current));
      }, 1_800);
      if (externalReloadPendingRef.current) {
        void reloadWorkbookFromDisk("Updated from disk after save");
      }
      return true;
    };

    const flushPendingSave = async (): Promise<boolean> => {
      if (saveTimerRef.current !== null) {
        window.clearTimeout(saveTimerRef.current);
        saveTimerRef.current = null;
      }
      return persistWorkbook();
    };
    flushSaveRef.current = flushPendingSave;

    const scheduleSave = () => {
      if (getPendingOperations().length === 0) {
        setSaveState("idle");
        return;
      }
      setSaveState((current) => (current === "saving" ? "saving" : "dirty"));
      if (saveTimerRef.current !== null) {
        window.clearTimeout(saveTimerRef.current);
      }
      saveTimerRef.current = window.setTimeout(() => {
        saveTimerRef.current = null;
        void persistWorkbook();
      }, 900);
    };

    const disposables: IDisposable[] = [
      fWorkbook.onSelectionChange(updateSelection),
      fWorkbook.onCommandExecuted(() => {
        updateSelection();
        scheduleSave();
      }),
    ];
    updateSelection();

    return () => {
      if (saveTimerRef.current !== null) {
        window.clearTimeout(saveTimerRef.current);
        saveTimerRef.current = null;
      }
      const pendingOperations = getPendingOperations();
      if (pendingOperations.length > 0) {
        void patchSpreadsheetWorkbook(path, pendingOperations)
          .then((result) => {
            if (result.ok) return loadSpreadsheetFileVersion(path);
            return null;
          })
          .then((result) => {
            if (result?.ok) sourceVersionRef.current = result.version;
          })
          .catch((error: unknown) => {
            void error;
          });
      }
      flushSaveRef.current = async () => true;
      for (const disposable of disposables) {
        disposable.dispose();
      }
      workbookApiRef.current = null;
      lastSavedDataRef.current = null;
      univer.dispose();
      formulaWorker.terminate();
      container.innerHTML = "";
    };
  }, [
    loadSpreadsheetFileVersion,
    patchSpreadsheetWorkbook,
    path,
    reloadWorkbookFromDisk,
    workbook,
  ]);

  const statusLabel = useMemo(() => {
    if (reloadNotice) return reloadNotice;
    if (saveState === "dirty") return "Unsaved changes";
    if (saveState === "saving") return "Saving";
    if (saveState === "saved") return "Saved";
    if (saveState === "error") return "Save failed";
    return selection?.rangeA1 ?? workbook?.activeSheetName ?? "";
  }, [reloadNotice, saveState, selection?.rangeA1, workbook?.activeSheetName]);

  const handlePromptSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const request = promptText.trim();
    if (!request || !workbook) return;
    if (!selectedThreadId) {
      alert("Please select or start a chat thread to collaborate with the agent.");
      return;
    }
    const saved = await flushSaveRef.current();
    if (!saved) return;
    const currentWorkbook = workbookRef.current ?? workbook;
    const prompt = buildUniverSpreadsheetPrompt({
      path,
      workbook: currentWorkbook,
      selection: selectionRef.current ?? selection,
      request,
    });
    const originalPrompt = promptText;
    setPromptText("");
    const accepted = await sendMessage(prompt);
    if (!accepted) {
      setPromptText(originalPrompt);
      alert("Please select or start a chat thread to collaborate with the agent.");
    }
  };

  if (loading) {
    return (
      <div className="flex h-full min-h-[360px] items-center justify-center bg-white text-sm text-muted-foreground">
        <Loader2Icon className="mr-2 size-4 animate-spin" />
        Loading workbook
      </div>
    );
  }

  if (loadError) {
    return (
      <div className="flex h-full min-h-[360px] items-center justify-center bg-white p-6">
        <div className="flex max-w-md items-start gap-3 rounded-md border border-destructive/25 bg-destructive/5 p-4 text-sm text-destructive">
          <AlertCircleIcon className="mt-0.5 size-4 shrink-0" />
          <span>{loadError}</span>
        </div>
      </div>
    );
  }

  return (
    <section
      className={cn(
        "flex h-full min-h-[420px] flex-col overflow-hidden bg-white text-foreground",
        compact ? "min-h-0" : "min-h-[680px]",
      )}
      data-cowork-univer-canvas="true"
    >
      <div className="flex shrink-0 items-center gap-3 border-b border-border bg-white px-3 py-2">
        <div className="flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
          <SaveStateIcon state={saveState} />
          <span className="truncate">{statusLabel}</span>
        </div>
        {saveError ? <span className="truncate text-xs text-destructive">{saveError}</span> : null}
        <form
          className="ml-auto flex min-w-[260px] max-w-[560px] flex-1 items-center gap-2"
          onSubmit={handlePromptSubmit}
        >
          <Input
            className="h-8 border-border bg-white text-sm shadow-none"
            value={promptText}
            onChange={(event) => setPromptText(event.currentTarget.value)}
            placeholder="Ask agent about this selection..."
          />
          <Button type="submit" size="icon" className="size-8" disabled={!promptText.trim()}>
            <SparklesIcon aria-hidden="true" data-icon="inline-start" />
            <span className="sr-only">Ask agent</span>
          </Button>
        </form>
      </div>
      <div ref={containerRef} className="min-h-0 flex-1 bg-white" />
    </section>
  );
}

function SaveStateIcon({ state }: { state: SaveState }) {
  if (state === "saving") return <Loader2Icon className="size-3.5 animate-spin" />;
  if (state === "saved") return <CheckIcon className="size-3.5 text-success" />;
  if (state === "dirty") return <SaveIcon className="size-3.5 text-primary" />;
  if (state === "error") return <AlertCircleIcon className="size-3.5 text-destructive" />;
  return <SaveIcon className="size-3.5 text-muted-foreground" />;
}
