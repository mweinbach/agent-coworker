import "@univerjs/preset-sheets-core/lib/index.css";
import "@univerjs/preset-sheets-sort/lib/index.css";
import "@univerjs/preset-sheets-find-replace/lib/index.css";

import {
  type ICommandInfo,
  type IDisposable,
  type IRange,
  type IWorkbookData,
  LocaleType,
  mergeLocales,
  type Workbook,
} from "@univerjs/core";
import { UniverSheetsCorePreset } from "@univerjs/preset-sheets-core";
import workerUrl from "@univerjs/preset-sheets-core/lib/worker.js?url";
import sheetsCoreEnUS from "@univerjs/preset-sheets-core/locales/en-US";
import { UniverSheetsFindReplacePreset } from "@univerjs/preset-sheets-find-replace";
import sheetsFindReplaceEnUS from "@univerjs/preset-sheets-find-replace/locales/en-US";
import { UniverSheetsSortPreset } from "@univerjs/preset-sheets-sort";
import sheetsSortEnUS from "@univerjs/preset-sheets-sort/locales/en-US";
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
import { registerCanvasDocumentTransitionHandler } from "../lib/canvasDocumentLifecycle";
import { reportSpreadsheetBackgroundSaveFailure } from "../lib/spreadsheetSaveNotifications";
import { buildUniverSheetsFooterConfig } from "../lib/univerCanvasConfig";
import {
  isWorkbookSnapshotForPath,
  shouldBlockSpreadsheetUnload,
  shouldDeferExternalWorkbookReload,
  type UniverSaveState,
} from "../lib/univerSaveState";
import {
  applySpreadsheetPatchOperationsToUniverData,
  buildUniverSpreadsheetPrompt,
  cloneUniverWorkbookData,
  diffUniverWorkbookPatches,
  selectionContextFromSnapshot,
  selectionContextFromWorkbook,
  spreadsheetSnapshotToUniverData,
  type UniverSelectionContext,
} from "../lib/univerSpreadsheet";
import { cn } from "../lib/utils";
import {
  canExecuteSpreadsheetCommand,
  hasUnsupportedXlsxTypedValues,
  isPersistedSpreadsheetMutation,
  univerSpreadsheetMenu,
} from "./univerCommandPolicy";

type UniverSpreadsheetCanvasProps = {
  path: string;
  compact?: boolean;
};

type SaveState = UniverSaveState;
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
  getWorkbook: () => Workbook;
  save: () => IWorkbookData;
  onSelectionChange: (callback: (selections: IRange[]) => void) => IDisposable;
  onCommandExecuted: (callback: (command: ICommandInfo) => void) => IDisposable;
};

type PendingConflictRebase = {
  path: string;
  fingerprint: string;
  initialData: IWorkbookData;
  baselineData: IWorkbookData;
  saveError: string;
};

const univerLocales = {
  [LocaleType.EN_US]: mergeLocales(sheetsCoreEnUS, sheetsSortEnUS, sheetsFindReplaceEnUS),
};

function isDiskVersionMismatchSaveFailure(message: string): boolean {
  return message.toLowerCase().includes("changed on disk");
}

export function UniverSpreadsheetCanvas({ path, compact = false }: UniverSpreadsheetCanvasProps) {
  const loadSpreadsheetWorkbook = useAppStore((s) => s.loadSpreadsheetWorkbook);
  const loadSpreadsheetFileVersion = useAppStore((s) => s.loadSpreadsheetFileVersion);
  const patchSpreadsheetWorkbook = useAppStore((s) => s.patchSpreadsheetWorkbook);
  const sendMessage = useAppStore((s) => s.sendMessage);
  const selectedThreadId = useAppStore((s) => s.selectedThreadId);
  const selectedWorkspaceId = useAppStore((s) => s.selectedWorkspaceId);
  const documentScope = useMemo(
    () => ({ path, workspaceId: selectedWorkspaceId ?? undefined }),
    [path, selectedWorkspaceId],
  );
  const documentScopeRef = useRef<typeof documentScope | null>(documentScope);

  const [workbook, setWorkbook] = useState<SpreadsheetWorkbookSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [selection, setSelection] = useState<UniverSelectionContext | null>(null);
  const [promptText, setPromptText] = useState("");
  const [promptError, setPromptError] = useState<string | null>(null);
  const [promptSubmitting, setPromptSubmitting] = useState(false);
  const promptSubmissionRef = useRef<object | null>(null);
  const [saveState, setSaveState] = useState<SaveState>("idle");
  const [saveError, setSaveError] = useState<string | null>(null);
  const [reloadNotice, setReloadNotice] = useState<string | null>(null);
  const [editNotice, setEditNotice] = useState<string | null>(null);

  const containerRef = useRef<HTMLDivElement>(null);
  const workbookApiRef: { current: UniverWorkbookApi | null } = useRef(null);
  const workbookRef: { current: SpreadsheetWorkbookSnapshot | null } = useRef(null);
  const selectionRef = useRef<UniverSelectionContext | null>(null);
  const saveStateRef = useRef<SaveState>("idle");
  const sourceVersionRef: { current: SpreadsheetFileVersion | null } = useRef(null);
  const saveTimerRef = useRef<number | null>(null);
  const saveInFlightRef: { current: Promise<boolean> | null } = useRef(null);
  const reloadNoticeTimerRef = useRef<number | null>(null);
  const externalReloadPendingRef: { current: boolean } = useRef(false);
  const reloadInFlightRef: { current: boolean } = useRef(false);
  const pendingConflictRebaseRef: { current: PendingConflictRebase | null } = useRef(null);
  const skipNextUnmountSaveRef: { current: boolean } = useRef(false);
  const flushSaveRef: { current: () => Promise<boolean> } = useRef(async () => true);

  const updateSaveState = useCallback((next: SaveState | ((current: SaveState) => SaveState)) => {
    const resolved = typeof next === "function" ? next(saveStateRef.current) : next;
    saveStateRef.current = resolved;
    setSaveState(resolved);
  }, []);

  useEffect(() => {
    documentScopeRef.current = documentScope;
    return () => {
      if (documentScopeRef.current === documentScope) documentScopeRef.current = null;
    };
  }, [documentScope]);

  const isCurrentDocument = useCallback(
    () =>
      documentScopeRef.current === documentScope &&
      (useAppStore.getState().selectedWorkspaceId ?? undefined) === documentScope.workspaceId,
    [documentScope],
  );

  useEffect(() => registerCanvasDocumentTransitionHandler(() => flushSaveRef.current()), []);

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
    const handleBeforeUnload = (event: BeforeUnloadEvent) => {
      if (!shouldBlockSpreadsheetUnload(saveStateRef.current, saveInFlightRef.current)) return;
      void flushSaveRef.current();
      event.preventDefault();
      event.stopImmediatePropagation();
      event.returnValue = "";
    };

    window.addEventListener("beforeunload", handleBeforeUnload, { capture: true });
    return () => {
      window.removeEventListener("beforeunload", handleBeforeUnload, { capture: true });
    };
  }, []);

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
        const response = await loadSpreadsheetWorkbook(path, {
          ...(sheetName ? { sheetName } : {}),
          workspaceId: documentScope.workspaceId,
        });
        if (!isCurrentDocument()) return;
        if (saveInFlightRef.current || shouldDeferExternalWorkbookReload(saveStateRef.current)) {
          externalReloadPendingRef.current = true;
          return;
        }
        if (!response.ok) {
          updateSaveState("error");
          setSaveError(`Reload failed: ${response.error.message}`);
          return;
        }
        if (!isWorkbookSnapshotForPath(response.workbook, path)) {
          updateSaveState("error");
          setSaveError("Reload failed: loaded workbook did not match the selected file.");
          return;
        }
        sourceVersionRef.current = response.workbook.fileVersion;
        externalReloadPendingRef.current = false;
        setWorkbook(response.workbook);
        setSaveError(null);
        updateSaveState("idle");
        showReloadNotice(notice);
      } catch (error) {
        if (isCurrentDocument()) {
          showReloadNotice(
            `Retrying disk sync: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      } finally {
        reloadInFlightRef.current = false;
      }
    },
    [
      documentScope,
      isCurrentDocument,
      loadSpreadsheetWorkbook,
      path,
      showReloadNotice,
      updateSaveState,
    ],
  );

  // biome-ignore lint/correctness/useExhaustiveDependencies: loadAttempt retries the same document after a failed load.
  useEffect(() => {
    let active = true;
    setLoading(true);
    setLoadError(null);
    promptSubmissionRef.current = null;
    setPromptSubmitting(false);
    setPromptText("");
    setPromptError(null);
    setWorkbook(null);
    workbookRef.current = null;
    setSelection(null);
    selectionRef.current = null;
    pendingConflictRebaseRef.current = null;
    skipNextUnmountSaveRef.current = false;
    updateSaveState("idle");
    setSaveError(null);
    setReloadNotice(null);
    setEditNotice(null);
    sourceVersionRef.current = null;
    externalReloadPendingRef.current = false;

    void (async () => {
      try {
        const response = await loadSpreadsheetWorkbook(path, {
          workspaceId: documentScope.workspaceId,
        });
        if (!active) return;
        if (!response.ok) {
          setLoadError(response.error.message);
          return;
        }
        if (!isWorkbookSnapshotForPath(response.workbook, path)) {
          setLoadError("Loaded workbook did not match the selected file.");
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
  }, [documentScope, loadAttempt, loadSpreadsheetWorkbook, path, updateSaveState]);

  useEffect(() => {
    if (!workbook || !isWorkbookSnapshotForPath(workbook, path)) return;
    let active = true;
    let checking = false;
    let hadSyncError = false;

    const checkForExternalUpdate = async () => {
      if (checking || !active) return;
      checking = true;
      try {
        const result = await loadSpreadsheetFileVersion(path, documentScope.workspaceId);
        if (!active || !isCurrentDocument()) return;
        if (!result.ok) throw new Error(result.error.message);
        if (hadSyncError) {
          hadSyncError = false;
          setReloadNotice(null);
        }
        const currentVersion = sourceVersionRef.current;
        if (!currentVersion) {
          sourceVersionRef.current = result.version;
          return;
        }
        if (
          result.version.fingerprint === currentVersion.fingerprint &&
          !externalReloadPendingRef.current
        )
          return;

        if (saveInFlightRef.current || shouldDeferExternalWorkbookReload(saveStateRef.current)) {
          externalReloadPendingRef.current = true;
          showReloadNotice("File changed on disk; syncing after save");
          return;
        }

        await reloadWorkbookFromDisk("Updated from disk");
      } catch (error) {
        if (active && isCurrentDocument()) {
          hadSyncError = true;
          showReloadNotice(
            `Retrying disk sync: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      } finally {
        checking = false;
      }
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
  }, [
    documentScope,
    isCurrentDocument,
    loadSpreadsheetFileVersion,
    path,
    reloadWorkbookFromDisk,
    showReloadNotice,
    workbook,
  ]);

  useEffect(() => {
    if (!workbook || !isWorkbookSnapshotForPath(workbook, path) || !containerRef.current) return;
    let active = true;
    let saveInFlight: Promise<boolean> | null = null;
    let saveRequestedDuringFlight = false;
    let fileVersion = workbook.fileVersion;
    const container = containerRef.current;
    container.innerHTML = "";
    const conflictRebase =
      pendingConflictRebaseRef.current?.path === path &&
      pendingConflictRebaseRef.current.fingerprint === workbook.fileVersion.fingerprint
        ? pendingConflictRebaseRef.current
        : null;
    pendingConflictRebaseRef.current = null;
    updateSaveState(conflictRebase ? "dirty" : "idle");
    setSaveError(conflictRebase?.saveError ?? null);
    const supportsWorkbookFormatting = workbook.kind === "xlsx";

    const initialData = conflictRebase?.initialData ?? spreadsheetSnapshotToUniverData(workbook);
    const savedBaselineData = conflictRebase?.baselineData ?? initialData;
    let lastSavedData = cloneUniverWorkbookData(savedBaselineData);
    const formulaWorker = new Worker(workerUrl, { type: "module" });
    const { univer, univerAPI } = createUniver({
      locale: LocaleType.EN_US,
      locales: univerLocales,
      presets: [
        UniverSheetsCorePreset({
          container,
          workerURL: formulaWorker,
          header: true,
          toolbar: supportsWorkbookFormatting,
          ribbonType: "simple",
          contextMenu: false,
          menu: univerSpreadsheetMenu,
          formulaBar: true,
          sheets: {
            disableForceStringAlert: true,
            disableForceStringMark: true,
          },
          footer: buildUniverSheetsFooterConfig(),
        }),
        UniverSheetsSortPreset(),
        UniverSheetsFindReplacePreset(),
      ],
    });
    const fWorkbook = univerAPI.createWorkbook(initialData) as UniverWorkbookApi;
    const activeSheet = fWorkbook.getSheetByName(workbook.activeSheetName);
    if (activeSheet) fWorkbook.setActiveSheet(activeSheet);
    workbookApiRef.current = fWorkbook;

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
      if (!active) return [];
      return diffUniverWorkbookPatches(lastSavedData, cloneUniverWorkbookData(fWorkbook.save()), {
        includeFormatting: supportsWorkbookFormatting,
      });
    };

    const refreshSourceVersion = async (): Promise<SpreadsheetFileVersion | null> => {
      const result = await loadSpreadsheetFileVersion(path, documentScope.workspaceId);
      if (!result.ok) return null;
      fileVersion = result.version;
      if (active && isCurrentDocument()) {
        sourceVersionRef.current = result.version;
        const currentWorkbook = workbookRef.current;
        if (currentWorkbook && isWorkbookSnapshotForPath(currentWorkbook, path)) {
          workbookRef.current = { ...currentWorkbook, fileVersion: result.version };
        }
      }
      return result.version;
    };

    const rebasePendingOperationsOnLatestDisk = async (
      saveErrorMessage: string,
    ): Promise<{ ok: true } | { ok: false; error: string }> => {
      const activeSheetName =
        workbookApiRef.current?.getActiveSheet()?.getSheetName() ??
        selectionRef.current?.sheetName ??
        workbook.activeSheetName;
      const response = await loadSpreadsheetWorkbook(path, {
        ...(activeSheetName ? { sheetName: activeSheetName } : {}),
        workspaceId: documentScope.workspaceId,
      });
      if (
        !active ||
        !isCurrentDocument() ||
        !response.ok ||
        !isWorkbookSnapshotForPath(response.workbook, path)
      ) {
        return { ok: false, error: saveErrorMessage };
      }

      const baselineData = spreadsheetSnapshotToUniverData(response.workbook);
      const rebaseResult = applySpreadsheetPatchOperationsToUniverData(
        baselineData,
        getPendingOperations(),
      );
      if (!rebaseResult.ok) {
        const missingSheets = rebaseResult.missingSheetNames.length
          ? rebaseResult.missingSheetNames.map((name) => `"${name}"`).join(", ")
          : "the edited sheets";
        return {
          ok: false,
          error: `The file on disk no longer contains ${missingSheets}. Your unsaved edits are still open. Restore the missing sheets on disk, then retry save.`,
        };
      }
      pendingConflictRebaseRef.current = {
        path,
        fingerprint: response.workbook.fileVersion.fingerprint,
        initialData: rebaseResult.data,
        baselineData,
        saveError: `${saveErrorMessage} Review the synced workbook, then retry save to keep canvas edits.`,
      };
      skipNextUnmountSaveRef.current = true;
      sourceVersionRef.current = response.workbook.fileVersion;
      workbookRef.current = response.workbook;
      externalReloadPendingRef.current = false;
      setWorkbook(response.workbook);
      showReloadNotice("File changed on disk; synced latest copy with local edits");
      return { ok: true };
    };

    const persistWorkbook = async (): Promise<boolean> => {
      const activeSave = saveInFlight;
      if (activeSave) {
        saveRequestedDuringFlight = true;
        return activeSave;
      }

      const persistOnce = async (): Promise<boolean> => {
        if (!active) return false;
        const currentData = cloneUniverWorkbookData(fWorkbook.save());
        const operations = diffUniverWorkbookPatches(lastSavedData, currentData, {
          includeFormatting: supportsWorkbookFormatting,
        });
        if (operations.length === 0) {
          updateSaveState("idle");
          setSaveError(null);
          return true;
        }

        updateSaveState("saving");
        setSaveError(null);
        const result = await patchSpreadsheetWorkbook(
          path,
          operations,
          fileVersion,
          documentScope.workspaceId,
        );
        if (!result.ok) {
          if (!active) return false;
          if (isDiskVersionMismatchSaveFailure(result.error.message)) {
            const rebased = await rebasePendingOperationsOnLatestDisk(result.error.message);
            if (!active) return false;
            if (rebased.ok) {
              updateSaveState("dirty");
            } else {
              updateSaveState("error");
              setSaveError(rebased.error);
            }
            return false;
          }
          updateSaveState("error");
          setSaveError(result.error.message);
          return false;
        }
        lastSavedData = currentData;
        let refreshedVersion: SpreadsheetFileVersion | null = null;
        try {
          refreshedVersion = await refreshSourceVersion();
        } catch {
          // The write succeeded; keep its baseline and retry disk sync independently.
        }
        if (!active) return true;
        if (!refreshedVersion) {
          externalReloadPendingRef.current = true;
          showReloadNotice("Edits saved. Retrying disk sync…");
        }
        updateSaveState("saved");
        window.setTimeout(() => {
          if (active) updateSaveState((current) => (current === "saved" ? "idle" : current));
        }, 1_800);
        if (externalReloadPendingRef.current) {
          void reloadWorkbookFromDisk("Updated from disk after save");
        }
        return true;
      };

      const savePromise = (async (): Promise<boolean> => {
        try {
          let saved = await persistOnce();
          while (
            saved &&
            active &&
            (saveRequestedDuringFlight || getPendingOperations().length > 0)
          ) {
            saveRequestedDuringFlight = false;
            saved = await persistOnce();
          }
          return saved;
        } catch (error) {
          if (active) {
            updateSaveState("error");
            setSaveError(error instanceof Error ? error.message : String(error));
          }
          return false;
        }
      })();

      saveInFlight = savePromise;
      saveInFlightRef.current = savePromise;
      try {
        return await savePromise;
      } finally {
        if (saveInFlight === savePromise) saveInFlight = null;
        if (saveInFlightRef.current === savePromise) {
          saveInFlightRef.current = null;
        }
      }
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
      updateSaveState((current) => (current === "saving" ? "saving" : "dirty"));
      if (saveInFlight) {
        saveRequestedDuringFlight = true;
        return;
      }
      if (saveTimerRef.current !== null) {
        window.clearTimeout(saveTimerRef.current);
      }
      saveTimerRef.current = window.setTimeout(() => {
        saveTimerRef.current = null;
        void persistWorkbook();
      }, 900);
    };

    const disposables: IDisposable[] = [
      univerAPI.addEvent(univerAPI.Event.BeforeCommandExecute, (event) => {
        if (
          canExecuteSpreadsheetCommand(
            event,
            workbook.kind,
            (id) => fWorkbook.getWorkbook().getStyles().get(id) ?? null,
          )
        )
          return;
        event.cancel = true;
        setEditNotice(
          workbook.kind === "xlsx" && hasUnsupportedXlsxTypedValues(event)
            ? "Literal numeric or formula-like text and Boolean values cannot be saved here. Open this workbook in your spreadsheet app to keep those value types."
            : workbook.kind === "csv"
              ? "This edit cannot be saved in CSV. Edit or paste cell values instead."
              : "This edit cannot be saved yet. Values, basic cell formatting, merges, and column widths are supported.",
        );
      }),
      fWorkbook.onSelectionChange(updateSelection),
      fWorkbook.onCommandExecuted((command) => {
        updateSelection();
        if (isPersistedSpreadsheetMutation(command.id)) {
          setEditNotice(null);
          scheduleSave();
        }
      }),
    ];
    updateSelection();

    return () => {
      if (saveTimerRef.current !== null) {
        window.clearTimeout(saveTimerRef.current);
        saveTimerRef.current = null;
      }
      const finalData = cloneUniverWorkbookData(fWorkbook.save());
      active = false;
      const shouldSkipUnmountSave = skipNextUnmountSaveRef.current;
      skipNextUnmountSaveRef.current = false;
      if (!shouldSkipUnmountSave) {
        const patchPendingOperations = async () => {
          const pendingOperations = diffUniverWorkbookPatches(lastSavedData, finalData, {
            includeFormatting: supportsWorkbookFormatting,
          });
          if (pendingOperations.length === 0) return;
          const result = await patchSpreadsheetWorkbook(
            path,
            pendingOperations,
            fileVersion,
            documentScope.workspaceId,
          );
          if (!result.ok) {
            reportSpreadsheetBackgroundSaveFailure(path, result.error.message);
          }
        };
        const activeSave = saveInFlight;
        const patchAfterActiveSave = activeSave
          ? activeSave.then(() => patchPendingOperations())
          : patchPendingOperations();
        void patchAfterActiveSave.catch((error: unknown) => {
          const message = error instanceof Error ? error.message : "The save request failed.";
          reportSpreadsheetBackgroundSaveFailure(path, message);
        });
      }
      flushSaveRef.current = async () => true;
      for (const disposable of disposables) {
        disposable.dispose();
      }
      workbookApiRef.current = null;
      univer.dispose();
      formulaWorker.terminate();
      container.innerHTML = "";
    };
  }, [
    documentScope,
    isCurrentDocument,
    loadSpreadsheetFileVersion,
    loadSpreadsheetWorkbook,
    patchSpreadsheetWorkbook,
    path,
    reloadWorkbookFromDisk,
    showReloadNotice,
    updateSaveState,
    workbook,
  ]);

  const activeWorkbook = isWorkbookSnapshotForPath(workbook, path) ? workbook : null;
  const activeSelection = activeWorkbook ? selection : null;

  const statusLabel = useMemo(() => {
    if (reloadNotice) return reloadNotice;
    if (saveState === "dirty") return "Unsaved changes";
    if (saveState === "saving") return "Saving";
    if (saveState === "saved") return "Saved";
    if (saveState === "error") return "Save failed";
    return activeSelection?.rangeA1 ?? activeWorkbook?.activeSheetName ?? "";
  }, [reloadNotice, saveState, activeSelection?.rangeA1, activeWorkbook?.activeSheetName]);

  const handlePromptSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const request = promptText.trim();
    if (!request || !activeWorkbook || promptSubmissionRef.current || !isCurrentDocument()) return;
    const targetThreadId = selectedThreadId;
    const targetThreadIsAvailable = () =>
      useAppStore
        .getState()
        .threads.some(
          (thread) =>
            thread.id === targetThreadId && thread.workspaceId === documentScope.workspaceId,
        );
    if (!targetThreadId || !targetThreadIsAvailable()) {
      setPromptError("Please select or start a chat thread to collaborate with the agent.");
      return;
    }
    const submission = {};
    promptSubmissionRef.current = submission;
    const isCurrentSubmission = () =>
      promptSubmissionRef.current === submission && isCurrentDocument();
    const requestedSelection = selectionRef.current ?? activeSelection;
    setPromptSubmitting(true);
    setPromptError(null);
    try {
      const saved = await flushSaveRef.current();
      if (!saved || !isCurrentSubmission()) return;
      const latestWorkbookResult = await loadSpreadsheetWorkbook(path, {
        ...(requestedSelection?.sheetName ? { sheetName: requestedSelection.sheetName } : {}),
        workspaceId: documentScope.workspaceId,
      });
      if (!isCurrentSubmission()) return;
      if (!latestWorkbookResult.ok) {
        setPromptError(`Could not refresh workbook context: ${latestWorkbookResult.error.message}`);
        return;
      }
      if (!isWorkbookSnapshotForPath(latestWorkbookResult.workbook, path)) {
        setPromptError(
          "The refreshed workbook did not match this file. Your request is still here.",
        );
        return;
      }
      if (!targetThreadIsAvailable()) {
        setPromptError("The original chat is no longer available. Choose a chat and try again.");
        return;
      }
      const prompt = buildUniverSpreadsheetPrompt({
        path,
        workbook: latestWorkbookResult.workbook,
        selection: selectionContextFromSnapshot(latestWorkbookResult.workbook, requestedSelection),
        request,
      });
      const accepted = await sendMessage(prompt, "reject", undefined, undefined, {
        targetThreadId,
      });
      if (!isCurrentSubmission()) return;
      if (accepted) {
        setPromptText("");
      } else {
        setPromptError("The message was not accepted. Your request is still here; try again.");
      }
    } catch (error) {
      if (isCurrentSubmission()) {
        setPromptError(error instanceof Error ? error.message : String(error));
      }
    } finally {
      if (promptSubmissionRef.current === submission) {
        promptSubmissionRef.current = null;
        setPromptSubmitting(false);
      }
    }
  };

  if (loading) {
    return (
      <div
        role="status"
        aria-live="polite"
        className="flex h-full min-h-[360px] items-center justify-center bg-[var(--surface-spreadsheet)] text-sm text-muted-foreground"
      >
        <Loader2Icon className="mr-2 size-4 animate-spin" />
        Loading workbook
      </div>
    );
  }

  if (loadError) {
    return (
      <div className="flex h-full min-h-[360px] items-center justify-center bg-[var(--surface-spreadsheet)] p-6">
        <div className="flex max-w-md flex-col items-start gap-3">
          <div
            role="alert"
            className="flex items-start gap-3 rounded-md border border-destructive/25 bg-destructive/5 p-4 text-sm text-destructive"
          >
            <AlertCircleIcon className="mt-0.5 size-4 shrink-0" />
            <span>{loadError}</span>
          </div>
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => setLoadAttempt((attempt) => attempt + 1)}
          >
            Try again
          </Button>
        </div>
      </div>
    );
  }

  return (
    <section
      className={cn(
        "flex h-full min-h-[420px] flex-col overflow-hidden bg-[var(--surface-spreadsheet)] text-foreground",
        compact ? "min-h-0" : "min-h-[680px]",
      )}
      data-cowork-univer-canvas="true"
    >
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border bg-[var(--surface-spreadsheet)] px-3 py-2">
        <div className="flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
          <SaveStateIcon state={saveState} />
          <span className="truncate">{statusLabel}</span>
        </div>
        {saveError ? (
          <span role="alert" className="text-xs text-destructive">
            {saveError}
          </span>
        ) : null}
        <Button
          type="button"
          size="sm"
          variant="outline"
          aria-label={saveError ? "Retry save" : "Save workbook"}
          onClick={() => void flushSaveRef.current()}
          disabled={saveState === "saving" || saveState === "idle" || saveState === "saved"}
        >
          {saveError ? "Retry save" : "Save"}
        </Button>
        {promptError ? (
          <span
            role="alert"
            data-testid="univer-prompt-error"
            className="truncate text-xs text-destructive"
          >
            {promptError}
          </span>
        ) : null}
        {editNotice ? (
          <span role="status" className="text-xs text-muted-foreground">
            {editNotice}
          </span>
        ) : null}
        <form
          className={cn(
            "ml-auto flex min-w-0 flex-1 items-center gap-2",
            compact ? "order-last basis-full max-w-none" : "max-w-[560px] basis-[260px]",
          )}
          onSubmit={handlePromptSubmit}
          aria-busy={promptSubmitting}
        >
          <Input
            className="h-8 border-border bg-[var(--surface-spreadsheet)] text-sm shadow-none"
            value={promptText}
            disabled={promptSubmitting}
            onChange={(event) => setPromptText(event.currentTarget.value)}
            aria-label="Spreadsheet prompt"
            placeholder="Ask agent about this selection..."
          />
          <Button
            type="submit"
            size="icon"
            className="size-8"
            disabled={!promptText.trim() || promptSubmitting}
          >
            {promptSubmitting ? (
              <Loader2Icon className="animate-spin" aria-hidden="true" data-icon="inline-start" />
            ) : (
              <SparklesIcon aria-hidden="true" data-icon="inline-start" />
            )}
            <span className="sr-only">Ask agent</span>
          </Button>
        </form>
      </div>
      <div ref={containerRef} className="min-h-0 flex-1 bg-[var(--surface-spreadsheet)]" />
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
