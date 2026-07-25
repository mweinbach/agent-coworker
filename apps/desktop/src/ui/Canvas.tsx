import {
  AlertTriangleIcon,
  BoldIcon,
  CheckIcon,
  ExternalLinkIcon,
  EyeIcon,
  FileTextIcon,
  FolderOpenIcon,
  ItalicIcon,
  ListIcon,
  Loader2Icon,
  MoreVerticalIcon,
  PenIcon,
  RefreshCwIcon,
  SaveIcon,
  SparklesIcon,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { useAppStore } from "../app/store";
import { Badge } from "../components/ui/badge";
import { AccessibleIconButton, Button } from "../components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "../components/ui/dropdown-menu";
import { Input } from "../components/ui/input";
import { ScrollArea } from "../components/ui/scroll-area";
import { Tabs, TabsContent } from "../components/ui/tabs";
import { Textarea } from "../components/ui/textarea";
import { CanvasDocumentController } from "../lib/canvasDocumentController";
import { registerCanvasDocumentTransitionHandler } from "../lib/canvasDocumentLifecycle";
import { applyMarkdownFormat, type MarkdownFormatKind } from "../lib/canvasMarkdownFormat";
import { buildCanvasDocumentPrompt } from "../lib/canvasRequest";
import { runCanvasSaveAs } from "../lib/canvasSaveAs";
import { confirmAction, openPath, pickCanvasSavePath, revealPath } from "../lib/desktopCommands";
import { getDesktopPlatformInfo } from "../lib/desktopPlatform";
import { getFilePreviewKind, isSlideModule } from "../lib/filePreviewKind";
import { isEnterWithoutIme, isImeComposing } from "../lib/keyboard";
import { useFileChangeRevision } from "../lib/useFileChangeRevision";
import { cn } from "../lib/utils";
import { getDesktopWindowMode } from "../lib/windowMode";
import { CanvasElectronTitlebar } from "./canvas/CanvasElectronTitlebar";
import { CanvasFilePreviewLayout } from "./canvas/CanvasFilePreviewLayout";
import { LazyUniverSpreadsheetCanvas } from "./LazyUniverSpreadsheetCanvas";
import { DesktopMarkdown } from "./markdown";
import { useOverlayOwner } from "./OverlayStack";
import { PptxPreview } from "./PptxPreview";
import { SlidePreview } from "./SlidePreview";

function basenamePath(p: string): string {
  const parts = p.replace(/\\/g, "/").split("/").filter(Boolean);
  return parts[parts.length - 1] ?? p;
}

const CANVAS_PREVIEW_MAX_BYTES = 256 * 1024;

type CanvasSaveBadgeProps = {
  status: "saved" | "dirty" | "saving" | "error" | "conflict";
};

function CanvasSaveBadge({ status }: CanvasSaveBadgeProps) {
  const label =
    status === "saved"
      ? "Saved"
      : status === "dirty"
        ? "Unsaved"
        : status === "saving"
          ? "Saving"
          : status === "conflict"
            ? "Changed on disk"
            : "Save failed";
  return (
    <Badge
      data-slot="canvas-save-status"
      role="status"
      aria-live="polite"
      aria-atomic="true"
      variant={status === "error" || status === "conflict" ? "destructive" : "outline"}
      className="text-xs uppercase tracking-wide"
    >
      {label}
    </Badge>
  );
}

function CanvasTruncationBanner({ path }: { path: string }) {
  const revealLabel =
    getDesktopPlatformInfo().platform === "macos" ? "Reveal in Finder" : "Reveal in Explorer";

  const openFullFile = useCallback(() => {
    void openPath({ path }).catch((error) => {
      console.error("Failed to open truncated preview externally:", error);
    });
  }, [path]);

  const revealFile = useCallback(() => {
    void revealPath({ path }).catch((error) => {
      console.error("Failed to reveal truncated preview:", error);
    });
  }, [path]);

  return (
    <div
      role="status"
      data-testid="canvas-truncated-warning"
      className="mx-3 mt-3 flex shrink-0 flex-wrap items-start gap-3 rounded-md border border-warning/35 bg-warning/10 px-3 py-2.5 text-sm"
    >
      <AlertTriangleIcon className="mt-0.5 size-4 shrink-0 text-warning" />
      <div className="min-w-[220px] flex-1">
        <div className="font-medium text-foreground">Editing disabled for large preview</div>
        <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">
          This file is larger than the Canvas preview limit and only the first 256 KB were loaded.
          Editing is disabled to avoid overwriting the full file with partial content.
        </p>
      </div>
      <div className="flex shrink-0 items-center gap-1.5">
        <Button type="button" variant="ghost" size="sm" onClick={openFullFile}>
          <ExternalLinkIcon data-icon="inline-start" />
          Open externally
        </Button>
        <Button type="button" variant="ghost" size="sm" onClick={revealFile}>
          <FolderOpenIcon data-icon="inline-start" />
          {revealLabel}
        </Button>
      </div>
    </div>
  );
}

export function Canvas({ path }: { path: string }) {
  const isCanvasMode = getDesktopWindowMode() === "canvas";
  const pxClass = isCanvasMode ? "px-5" : "px-3";
  const workspaces = useAppStore((s) => s.workspaces);
  const selectedWorkspaceId = useAppStore((s) => s.selectedWorkspaceId);
  const activeWorkspace = useMemo(() => {
    return workspaces.find((w) => w.id === selectedWorkspaceId) ?? null;
  }, [workspaces, selectedWorkspaceId]);
  const projectTitle = activeWorkspace?.name || "Cowork";

  const selectedThreadId = useAppStore((s) => s.selectedThreadId);
  const threadRuntime = useAppStore((s) =>
    selectedThreadId ? s.threadRuntimeById[selectedThreadId] : null,
  );
  const sendMessage = useAppStore((s) => s.sendMessage);
  const closeFilePreview = useAppStore((s) => s.closeFilePreview);

  const activeTab = useAppStore((s) => s.canvasActiveTab);
  const setActiveTab = useAppStore((s) => s.setCanvasActiveTab);
  const showFormattingBar = useAppStore((s) => s.canvasShowFormattingBar);
  const setShowFormattingBar = useAppStore((s) => s.setCanvasShowFormattingBar);
  const [previewRefreshTrigger, setPreviewRefreshTrigger] = useState<number>(0);
  const [promptText, setPromptText] = useState<string>("");
  const [selectedText, setSelectedText] = useState<string>("");
  const [floatingCoords, setFloatingCoords] = useState<{ x: number; y: number } | null>(null);
  const [floatingPromptText, setFloatingPromptText] = useState<string>("");
  const [promptError, setPromptError] = useState<string | null>(null);
  const [promptSending, setPromptSending] = useState(false);

  const contentRef = useRef<string>("");
  const isEditingRef = useRef<boolean>(false);
  const isInteractingRef = useRef<boolean>(false);
  const floatingRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<HTMLDivElement | null>(null);
  const savedSelectionRangeRef = useRef<Range | null>(null);

  const previewKind = getFilePreviewKind(path);
  const isMarkdown = previewKind === "markdown";
  const isSpreadsheet = useMemo(() => {
    return previewKind === "csv" || previewKind === "xlsx";
  }, [previewKind]);
  const isPptx = useMemo(() => {
    return previewKind === "pptx";
  }, [previewKind]);
  const isSlide = useMemo(() => {
    return isSlideModule(path);
  }, [path]);

  const controllerRef = useRef<CanvasDocumentController | null>(null);
  if (!controllerRef.current) {
    controllerRef.current = new CanvasDocumentController(
      {
        open: async (workspaceId, input) =>
          await useAppStore.getState().openCanvasDocument(workspaceId, input),
        revision: async (workspaceId, input) =>
          await useAppStore.getState().readCanvasDocumentRevision(workspaceId, input),
        save: async (workspaceId, input) =>
          await useAppStore.getState().saveCanvasDocument(workspaceId, input),
        saveAs: async (workspaceId, input) =>
          await useAppStore.getState().saveCanvasDocumentAs(workspaceId, input),
        close: async (workspaceId, input) =>
          await useAppStore.getState().closeCanvasDocument(workspaceId, input),
      },
      { maxBytes: CANVAS_PREVIEW_MAX_BYTES },
    );
  }
  const controller = controllerRef.current;
  const canvasState = useSyncExternalStore(
    controller.subscribe,
    controller.getState,
    controller.getState,
  );
  const content = canvasState.content;
  const contentTruncated = canvasState.document?.truncated ?? false;
  const loading = canvasState.phase === "idle" || canvasState.phase === "loading";
  const error =
    canvasState.phase === "error" && canvasState.problem?.source === "load"
      ? canvasState.problem.message
      : null;
  const saveStatus = canvasState.saveStatus;
  const fileChangeRevision = useFileChangeRevision(canvasState.document?.path ?? path);

  useEffect(() => {
    contentRef.current = content;
  }, [content]);

  useEffect(() => {
    if (isSpreadsheet || isPptx) {
      void controller.prepareForTransition(null);
      return;
    }
    const workspaceId = activeWorkspace?.id ?? selectedWorkspaceId;
    if (!workspaceId) return;
    void controller.open(workspaceId, path);
  }, [activeWorkspace?.id, controller, isPptx, isSpreadsheet, path, selectedWorkspaceId]);

  useEffect(() => {
    if (isSpreadsheet || isPptx) return;
    return registerCanvasDocumentTransitionHandler(async (nextPath) => {
      return await controller.prepareForTransition(nextPath);
    });
  }, [controller, isPptx, isSpreadsheet]);

  useEffect(() => {
    return () => controller.dispose();
  }, [controller]);

  useEffect(() => {
    if (!canvasState.document || isSpreadsheet || isPptx) return;
    let active = true;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const pollAndSchedule = async () => {
      await controller.poll();
      if (active) {
        timer = setTimeout(() => {
          void pollAndSchedule();
        }, 1500);
      }
    };
    timer = setTimeout(() => {
      void pollAndSchedule();
    }, 1500);
    const pollOnFocus = () => {
      void controller.poll();
    };
    window.addEventListener("focus", pollOnFocus);
    return () => {
      active = false;
      if (timer) clearTimeout(timer);
      window.removeEventListener("focus", pollOnFocus);
    };
  }, [canvasState.document, controller, isPptx, isSpreadsheet]);

  useEffect(() => {
    if (fileChangeRevision === 0 || !canvasState.document || isSpreadsheet || isPptx) return;
    void controller.poll();
  }, [canvasState.document, controller, fileChangeRevision, isPptx, isSpreadsheet]);

  useEffect(() => {
    if (canvasState.document?.revision.fingerprint) {
      setPreviewRefreshTrigger((trigger) => trigger + 1);
    }
  }, [canvasState.document?.revision.fingerprint]);

  useEffect(() => {
    const handleBeforeUnload = (event: BeforeUnloadEvent) => {
      if (controller.getState().saveStatus === "saved") return;
      void controller.flush();
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", handleBeforeUnload);
    return () => window.removeEventListener("beforeunload", handleBeforeUnload);
  }, [controller]);

  useEffect(() => {
    if (activeTab === "preview") {
      setPreviewRefreshTrigger((t) => t + 1);
    }
  }, [activeTab]);

  const documentPath = canvasState.document?.path ?? path;
  const fileName = basenamePath(documentPath);
  const isAgentBusy = threadRuntime?.busy === true;

  // NOTE: All hooks must be declared unconditionally before any early return.
  // Canvas is mounted unkeyed (see App.tsx), so the same instance re-renders
  // across file-type switches — bailing out above a hook would change the hook
  // count between renders and crash React. The spreadsheet/pptx returns live
  // below, after every hook. Editor-only effects guard on isSpreadsheet/isPptx
  // so they stay inert for preview-only file kinds.
  useEffect(() => {
    if (isSpreadsheet || isPptx) return;
    if (!floatingCoords) {
      if ("Highlight" in window) {
        try {
          (CSS as any).highlights.delete("canvas-temp-highlight");
        } catch (_e) {}
      }
      savedSelectionRangeRef.current = null;
    }
  }, [floatingCoords, isSpreadsheet, isPptx]);

  const sourceTextareaRef = useRef<HTMLTextAreaElement | null>(null);

  /**
   * Apply formatting against the markdown source (selection-aware). Prefer this
   * over document.execCommand so WYSIWYG and source stay one representation.
   */
  const applyFormat = (kind: MarkdownFormatKind) => {
    if (contentTruncated) return;
    if (activeTab !== "edit") return;
    const textarea = sourceTextareaRef.current;
    if (!textarea) return;
    const start = textarea.selectionStart;
    const end = textarea.selectionEnd;
    const result = applyMarkdownFormat(contentRef.current, start, end, kind);
    handleContentChange(result.next);
    requestAnimationFrame(() => {
      textarea.focus();
      textarea.setSelectionRange(result.selectionStart, result.selectionEnd);
    });
  };

  const handleContentChange = (val: string) => {
    controller.edit(val);
    contentRef.current = val;
    isEditingRef.current = true;
  };

  const handleBlur = () => {
    isEditingRef.current = false;
  };

  const handleRetryPersistence = () => {
    void controller.retry();
  };

  const handleSaveAs = async () => {
    const sourcePath = canvasState.document?.path ?? path;
    const savedPath = await runCanvasSaveAs({
      sourcePath,
      pickPath: pickCanvasSavePath,
      saveAs: async (targetPath) => await controller.saveAs(targetPath),
      reportFailure: (message) => controller.reportPersistenceFailure(message),
    });
    if (savedPath) {
      await useAppStore.getState().openFilePreview({ path: savedPath });
    }
  };

  const handleReloadAfterConflict = async () => {
    const confirmed = await confirmAction({
      title: "Reload changed file?",
      message: "Reload the version on disk and discard your unsaved Canvas changes?",
      detail: "Use Save As first if you want to keep a copy of your current edits.",
      kind: "warning",
      confirmLabel: "Reload from disk",
      cancelLabel: "Keep editing",
      defaultAction: "cancel",
    });
    if (confirmed) {
      await controller.discardLocalChangesAndReload();
    }
  };

  const applyTempHighlight = useCallback(() => {
    const selection = window.getSelection();
    if (selection && selection.rangeCount > 0 && !selection.isCollapsed) {
      const range = selection.getRangeAt(0);
      savedSelectionRangeRef.current = range.cloneRange();

      if ("Highlight" in window) {
        try {
          const highlight = new (window as any).Highlight(range);
          (CSS as any).highlights.set("canvas-temp-highlight", highlight);
        } catch (e) {
          console.error(e);
        }
      }
    }
  }, []);

  const removeTempHighlight = useCallback(() => {
    if ("Highlight" in window) {
      try {
        (CSS as any).highlights.delete("canvas-temp-highlight");
      } catch (_e) {}
    }

    if (savedSelectionRangeRef.current && editorRef.current) {
      const selection = window.getSelection();
      if (selection) {
        selection.removeAllRanges();
        selection.addRange(savedSelectionRangeRef.current);
      }
      savedSelectionRangeRef.current = null;
    }
  }, []);

  useEffect(() => {
    if (isSpreadsheet || isPptx) return;
    const handleSelection = () => {
      // Don't wipe out coordinates if the user is interacting with the floating bar
      if (isInteractingRef.current) {
        return;
      }

      const selection = window.getSelection();
      const activeElement = document.activeElement;
      const isFocusedInInputs =
        activeElement &&
        (activeElement.tagName === "INPUT" ||
          activeElement.tagName === "TEXTAREA" ||
          floatingRef.current?.contains(activeElement));

      // Only show the floating bar if there's an actual text selection
      if (selection && selection.rangeCount > 0 && !selection.isCollapsed) {
        const text = selection.toString().trim();
        const canvasEl = document.querySelector(".app-canvas");

        // Ensure the selection is actually inside our canvas
        const selectionInCanvas =
          canvasEl?.contains(activeElement || null) ||
          (selection.anchorNode && canvasEl?.contains(selection.anchorNode)) ||
          (selection.focusNode && canvasEl?.contains(selection.focusNode));

        // Let the user edit the prompt box without wiping out the floating menu coordinates.
        if (activeElement && floatingRef.current?.contains(activeElement)) {
          return;
        }

        if (text && (selectionInCanvas || activeTab === "preview")) {
          setSelectedText(text);

          try {
            const range = selection.getRangeAt(0);
            const rect = range.getBoundingClientRect();
            if (rect.width > 0 && rect.height > 0) {
              setFloatingCoords({
                x: rect.left + rect.width / 2,
                y: rect.top,
              });
            }
          } catch (e) {
            console.error("Failed to get bounding rect of selection", e);
          }
          return;
        }
      }

      // If selection is lost/collapsed, and we are not focused on our inputs,
      // fully clear the saved selection and temp highlight so they don't stick or leak!
      if (!isFocusedInInputs) {
        if ("Highlight" in window) {
          try {
            (CSS as any).highlights.delete("canvas-temp-highlight");
          } catch (_e) {}
        }
        savedSelectionRangeRef.current = null;
      }

      // ONLY clear the floating bar if we actually lost selection
      setSelectedText("");
      setFloatingCoords(null);
    };

    document.addEventListener("selectionchange", handleSelection);
    return () => document.removeEventListener("selectionchange", handleSelection);
  }, [activeTab, isSpreadsheet, isPptx]);

  const clearSelectionState = useCallback(() => {
    setSelectedText("");
    setFloatingCoords(null);
    isInteractingRef.current = false;
    // Always remove temp highlight when clearing selection state
    if ("Highlight" in window) {
      try {
        (CSS as any).highlights.delete("canvas-temp-highlight");
      } catch (_e) {}
    }
    savedSelectionRangeRef.current = null;
  }, []);

  const clearSelection = useCallback(() => {
    clearSelectionState();
    window.getSelection()?.removeAllRanges();
  }, [clearSelectionState]);
  const selectionEditorOwner = useOverlayOwner({
    active: floatingCoords !== null,
    label: "Canvas selection editor",
    onDismiss: clearSelection,
    restoreFocus: () => sourceTextareaRef.current,
  });

  useEffect(() => {
    if (isSpreadsheet || isPptx) return;
    const handleWindowPointerDown = (e: MouseEvent) => {
      const target = e.target as HTMLElement | null;
      if (floatingRef.current?.contains(target)) {
        // If clicking inside the floating portal, record that we're interacting
        // so the selectionchange handler ignores subsequent selection loss.
        isInteractingRef.current = true;
        return;
      }

      // If clicking anywhere else, we are no longer interacting with the floating portal.
      isInteractingRef.current = false;

      // If we clicked completely outside of the canvas, clear the selection state.
      if (!document.querySelector(".app-canvas")?.contains(target)) {
        clearSelectionState();
      }
    };

    const handleWindowPointerUp = () => {
      // Re-allow selection changes on pointer up, effectively allowing natural mouse drag selections
      // to resolve normally after a user finishes highlighting or finishes clicking a button.
      setTimeout(() => {
        isInteractingRef.current = false;
      }, 0);

      // Backup: after pointer up, check if there's a finalized text selection inside
      // the canvas and force-show the floating bar in case selectionchange was missed.
      setTimeout(() => {
        if (isInteractingRef.current) return;
        const selection = window.getSelection();
        if (!selection || selection.isCollapsed || selection.rangeCount === 0) return;
        const text = selection.toString().trim();
        if (!text) return;
        const canvasEl = document.querySelector(".app-canvas");
        const inCanvas =
          (selection.anchorNode && canvasEl?.contains(selection.anchorNode)) ||
          (selection.focusNode && canvasEl?.contains(selection.focusNode));
        if (!inCanvas) return;
        setSelectedText(text);
        try {
          const range = selection.getRangeAt(0);
          const rect = range.getBoundingClientRect();
          if (rect.width > 0 && rect.height > 0) {
            setFloatingCoords({
              x: rect.left + rect.width / 2,
              y: rect.top,
            });
          }
        } catch (e) {
          console.error("Failed to get bounding rect of selection on pointerup", e);
        }
      }, 50);
    };

    document.addEventListener("pointerdown", handleWindowPointerDown);
    document.addEventListener("pointerup", handleWindowPointerUp);
    return () => {
      document.removeEventListener("pointerdown", handleWindowPointerDown);
      document.removeEventListener("pointerup", handleWindowPointerUp);
    };
  }, [clearSelectionState, isSpreadsheet, isPptx]);

  const handleSendPrompt = async (explicitPrompt?: string) => {
    const textToSend = (explicitPrompt !== undefined ? explicitPrompt : promptText).trim();
    if (!textToSend || promptSending) return;
    if (!selectedThreadId) {
      setPromptError("Please select or start a chat thread to collaborate with the agent.");
      return;
    }
    setPromptError(null);
    setPromptSending(true);

    const filename = basenamePath(documentPath);
    const canvasKind = isMarkdown ? "markdown" : isSlide ? "slide" : "text";
    const promptWithContext = buildCanvasDocumentPrompt({
      path: documentPath,
      fileName: filename,
      kind: canvasKind,
      selection: selectedText || null,
      request: textToSend,
    });

    try {
      const acknowledged = await sendMessage(promptWithContext);
      if (!acknowledged) {
        setPromptError(
          "The request was not sent. The chat may be busy, reconnecting, or missing an active session. Try again when it is ready.",
        );
        return;
      }
      if (explicitPrompt !== undefined) {
        setFloatingPromptText("");
      } else {
        setPromptText("");
      }
      clearSelection();
    } catch (err) {
      console.error("Failed to send collaborative edit instructions:", err);
      setPromptError("The request was not sent. Check the chat connection and try again.");
    } finally {
      setPromptSending(false);
    }
  };

  if (isSpreadsheet) {
    return (
      <CanvasFilePreviewLayout
        isCanvasMode={isCanvasMode}
        isAgentBusy={isAgentBusy}
        fileName={fileName}
        previewKind={previewKind}
        onClose={closeFilePreview}
      >
        <LazyUniverSpreadsheetCanvas path={path} compact />
      </CanvasFilePreviewLayout>
    );
  }

  if (isPptx) {
    return (
      <CanvasFilePreviewLayout
        isCanvasMode={isCanvasMode}
        isAgentBusy={isAgentBusy}
        fileName={fileName}
        previewKind={previewKind}
        onClose={closeFilePreview}
      >
        <PptxPreview path={path} />
      </CanvasFilePreviewLayout>
    );
  }

  return (
    <div
      className={cn(
        "app-canvas flex h-full w-full flex-col overflow-hidden bg-canvas text-canvas-foreground",
        !isCanvasMode && "border-l border-border/50",
      )}
      data-canvas-surface="document"
    >
      <style>{`
        ::highlight(canvas-temp-highlight) {
          background-color: var(--canvas-highlight);
          color: inherit;
        }
      `}</style>
      <Tabs
        value={activeTab}
        onValueChange={(v) => {
          setActiveTab(v as "preview" | "edit");
          isEditingRef.current = false;
        }}
        className="flex min-h-0 flex-1 flex-col gap-0"
      >
        {isCanvasMode ? (
          <CanvasElectronTitlebar
            isAgentBusy={isAgentBusy}
            leading={
              <>
                <FileTextIcon className="size-3.5 text-muted-foreground shrink-0" />
                <div className="flex min-w-0 items-center gap-1">
                  <span className="shrink-0 select-none text-xs font-semibold text-muted-foreground">
                    {projectTitle}
                  </span>
                  <span className="text-xs app-text-muted select-none">/</span>
                  <span className="truncate text-xs font-bold text-foreground" title={fileName}>
                    {fileName}
                  </span>
                </div>
              </>
            }
            trailing={
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <AccessibleIconButton
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="size-7 text-muted-foreground hover:text-foreground hover:bg-muted/50 rounded-lg outline-none focus:outline-none"
                    label="View options"
                  >
                    <MoreVerticalIcon className="size-4" />
                  </AccessibleIconButton>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-44 outline-none">
                  {(isMarkdown || isSlide) && (
                    <>
                      <DropdownMenuItem
                        onClick={() => setActiveTab("preview")}
                        className={cn(
                          activeTab === "preview" && "font-semibold text-primary bg-primary/5",
                        )}
                      >
                        <EyeIcon className="mr-2 size-3.5" />
                        <span>{isSlide ? "Slide View" : "Document"}</span>
                      </DropdownMenuItem>
                      <DropdownMenuItem
                        onClick={() => setActiveTab("edit")}
                        className={cn(
                          activeTab === "edit" && "font-semibold text-primary bg-primary/5",
                        )}
                      >
                        <PenIcon className="mr-2 size-3.5" />
                        <span>Raw Source</span>
                      </DropdownMenuItem>
                    </>
                  )}

                  {isMarkdown && activeTab === "edit" ? (
                    <DropdownMenuItem
                      onClick={() => setShowFormattingBar(!showFormattingBar)}
                      className="flex items-center justify-between cursor-pointer"
                    >
                      <span className="flex items-center">
                        <BoldIcon className="mr-2 size-3.5" />
                        Show Styling Bar
                      </span>
                      {showFormattingBar && <CheckIcon className="size-3.5 text-primary" />}
                    </DropdownMenuItem>
                  ) : null}
                </DropdownMenuContent>
              </DropdownMenu>
            }
          />
        ) : null}

        {showFormattingBar && isMarkdown && activeTab === "edit" && (
          <div className="flex shrink-0 items-center gap-0.5 overflow-x-auto border-b border-border/40 bg-muted/15 px-2.5 py-1 select-none scrollbar-none">
            <AccessibleIconButton
              type="button"
              variant="ghost"
              size="icon"
              onPointerDown={(e) => e.preventDefault()}
              onClick={() => applyFormat("bold")}
              className="size-7 rounded-md text-muted-foreground hover:text-foreground hover:bg-muted/60"
              label="Bold"
            >
              <BoldIcon className="size-3.5" />
            </AccessibleIconButton>
            <AccessibleIconButton
              type="button"
              variant="ghost"
              size="icon"
              onPointerDown={(e) => e.preventDefault()}
              onClick={() => applyFormat("italic")}
              className="size-7 rounded-md text-muted-foreground hover:text-foreground hover:bg-muted/60"
              label="Italic"
            >
              <ItalicIcon className="size-3.5" />
            </AccessibleIconButton>
            <div className="h-4 w-px bg-border/50 mx-1" aria-hidden />
            <Button
              type="button"
              variant="ghost"
              onPointerDown={(e) => e.preventDefault()}
              onClick={() => applyFormat("h1")}
              className="h-7 px-1.5 rounded-md font-semibold text-xs text-muted-foreground hover:text-foreground hover:bg-muted/60"
              title="Heading 1"
            >
              H1
            </Button>
            <Button
              type="button"
              variant="ghost"
              onPointerDown={(e) => e.preventDefault()}
              onClick={() => applyFormat("h2")}
              className="h-7 px-1.5 rounded-md font-semibold text-xs text-muted-foreground hover:text-foreground hover:bg-muted/60"
              title="Heading 2"
            >
              H2
            </Button>
            <Button
              type="button"
              variant="ghost"
              onPointerDown={(e) => e.preventDefault()}
              onClick={() => applyFormat("h3")}
              className="h-7 px-1.5 rounded-md font-semibold text-xs text-muted-foreground hover:text-foreground hover:bg-muted/60"
              title="Heading 3"
            >
              H3
            </Button>
            <Button
              type="button"
              variant="ghost"
              onPointerDown={(e) => e.preventDefault()}
              onClick={() => applyFormat("paragraph")}
              className="h-7 px-1.5 rounded-md text-xs text-muted-foreground hover:text-foreground hover:bg-muted/60"
              title="Normal Text"
            >
              Normal
            </Button>
            <div className="h-4 w-px bg-border/50 mx-1" aria-hidden />
            <AccessibleIconButton
              type="button"
              variant="ghost"
              size="icon"
              onPointerDown={(e) => e.preventDefault()}
              onClick={() => applyFormat("ul")}
              className="size-7 rounded-md text-muted-foreground hover:text-foreground hover:bg-muted/60"
              label="Bullet list"
            >
              <ListIcon className="size-3.5" />
            </AccessibleIconButton>
            <AccessibleIconButton
              type="button"
              variant="ghost"
              size="icon"
              onPointerDown={(e) => e.preventDefault()}
              onClick={() => applyFormat("ol")}
              className="size-7 rounded-md text-muted-foreground hover:text-foreground hover:bg-muted/60"
              label="Numbered list"
            >
              <span className="font-semibold text-xs font-mono">1.</span>
            </AccessibleIconButton>
          </div>
        )}

        <div className="min-h-0 flex-1 relative">
          {loading ? (
            <div
              role="status"
              aria-live="polite"
              className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-canvas text-sm text-muted-foreground"
            >
              <Loader2Icon className="size-6 animate-spin text-primary" />
              <span>Reading file...</span>
            </div>
          ) : error ? (
            <div
              role="alert"
              className="mx-4 my-3 flex items-start gap-3 rounded-md border border-destructive/30 bg-destructive/10 p-4 text-sm text-foreground"
            >
              <AlertTriangleIcon className="mt-0.5 size-4 shrink-0 text-destructive" />
              <div className="min-w-0 flex-1">
                <div className="font-semibold">Failed to load content</div>
                <p className="mt-1 text-xs text-muted-foreground">{error}</p>
              </div>
              <Button type="button" variant="outline" size="sm" onClick={handleRetryPersistence}>
                <RefreshCwIcon data-icon="inline-start" />
                Retry
              </Button>
            </div>
          ) : (
            <div className="flex h-full min-h-0 flex-col">
              {canvasState.problem && canvasState.problem.source !== "load" ? (
                <div
                  role="alert"
                  data-testid="canvas-persistence-problem"
                  className="mx-3 mt-3 flex shrink-0 flex-wrap items-start gap-3 rounded-md border border-warning/40 bg-warning/10 px-3 py-2.5 text-sm"
                >
                  <AlertTriangleIcon className="mt-0.5 size-4 shrink-0 text-warning" />
                  <div className="min-w-[220px] flex-1">
                    <div className="font-medium text-foreground">
                      {saveStatus === "conflict"
                        ? "Changed on disk"
                        : canvasState.problem.source === "poll"
                          ? "Couldn’t check for file changes"
                          : "Save failed"}
                    </div>
                    <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">
                      {canvasState.problem.message}
                    </p>
                  </div>
                  <div className="flex shrink-0 items-center gap-1.5">
                    {saveStatus === "conflict" ? (
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={() => void handleReloadAfterConflict()}
                      >
                        <RefreshCwIcon data-icon="inline-start" />
                        Reload from disk
                      </Button>
                    ) : (
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={handleRetryPersistence}
                      >
                        <RefreshCwIcon data-icon="inline-start" />
                        Retry
                      </Button>
                    )}
                    {canvasState.document && !contentTruncated ? (
                      <Button
                        type="button"
                        variant="secondary"
                        size="sm"
                        onClick={() => void handleSaveAs()}
                      >
                        <SaveIcon data-icon="inline-start" />
                        Save As
                      </Button>
                    ) : null}
                  </div>
                </div>
              ) : null}
              {contentTruncated ? (
                <CanvasTruncationBanner path={canvasState.document?.path ?? path} />
              ) : null}
              <div className="min-h-0 flex-1">
                {isMarkdown ? (
                  <>
                    <TabsContent
                      value="preview"
                      className="h-full m-0 p-0 outline-none data-[state=inactive]:hidden"
                    >
                      <ScrollArea className="h-full">
                        <div className="mx-auto w-full max-w-[840px] px-4 py-8">
                          <div className="mx-auto w-full max-w-none p-[clamp(1rem,6%,4rem)] text-left select-text">
                            <DesktopMarkdown className="prose prose-neutral dark:prose-invert max-w-none">
                              {content}
                            </DesktopMarkdown>
                          </div>
                        </div>
                      </ScrollArea>
                    </TabsContent>

                    <TabsContent
                      forceMount
                      value="edit"
                      className="m-0 h-full bg-canvas p-0 outline-none data-[state=inactive]:hidden"
                    >
                      <div className={cn("flex h-full flex-col pb-2.5 pt-1.5 gap-2", pxClass)}>
                        <div className="text-xs text-muted-foreground px-1 flex items-center justify-between shrink-0">
                          <span className="flex items-center gap-2">
                            <span>Markdown Source</span>
                            <CanvasSaveBadge status={saveStatus} />
                          </span>
                          <span className="tabular-nums font-mono">
                            {content.length} characters
                          </span>
                        </div>
                        <Textarea
                          ref={sourceTextareaRef}
                          value={content}
                          onChange={(e) => handleContentChange(e.target.value)}
                          onBlur={handleBlur}
                          readOnly={contentTruncated}
                          placeholder="Type your markdown here..."
                          className="min-h-0 flex-1 resize-none border border-border/60 bg-background p-4 font-mono text-sm leading-relaxed focus-visible:border-primary/80 focus-visible:ring-1 focus-visible:ring-primary"
                        />
                      </div>
                    </TabsContent>
                  </>
                ) : isSlide ? (
                  <>
                    <TabsContent
                      value="preview"
                      className="h-full m-0 p-0 outline-none data-[state=inactive]:hidden"
                    >
                      <SlidePreview path={documentPath} refreshTrigger={previewRefreshTrigger} />
                    </TabsContent>

                    <TabsContent
                      forceMount
                      value="edit"
                      className="m-0 h-full bg-canvas p-0 outline-none data-[state=inactive]:hidden"
                    >
                      <div className={cn("flex h-full flex-col pb-2.5 pt-1.5 gap-2", pxClass)}>
                        <div className="text-xs text-muted-foreground px-1 flex items-center justify-between shrink-0">
                          <span className="flex items-center gap-2">
                            <span>Slide Source Code</span>
                            <CanvasSaveBadge status={saveStatus} />
                          </span>
                          <span className="tabular-nums font-mono">
                            {content.length} characters
                          </span>
                        </div>
                        <Textarea
                          value={content}
                          onChange={(e) => handleContentChange(e.target.value)}
                          onBlur={handleBlur}
                          readOnly={contentTruncated}
                          placeholder="Type your slide code here..."
                          className="min-h-0 flex-1 resize-none border border-border/60 bg-background p-4 font-mono text-sm leading-relaxed focus-visible:border-primary/80 focus-visible:ring-1 focus-visible:ring-primary"
                        />
                      </div>
                    </TabsContent>
                  </>
                ) : (
                  <div className="flex h-full flex-col gap-2 bg-canvas pb-2.5 pt-1.5">
                    <div
                      className={cn(
                        "text-xs text-muted-foreground px-1 flex items-center justify-between shrink-0",
                        pxClass,
                      )}
                    >
                      <span className="flex items-center gap-2">
                        <span>Source Editor</span>
                        <CanvasSaveBadge status={saveStatus} />
                      </span>
                      <span className="tabular-nums font-mono">{content.length} characters</span>
                    </div>
                    <div className={cn("flex-1 min-h-0", pxClass)}>
                      <Textarea
                        value={content}
                        onChange={(e) => handleContentChange(e.target.value)}
                        onBlur={handleBlur}
                        readOnly={contentTruncated}
                        placeholder="Type your text here..."
                        className="h-full w-full resize-none border border-border/60 bg-background p-4 font-mono text-sm leading-relaxed focus-visible:border-primary/80 focus-visible:ring-1 focus-visible:ring-primary"
                      />
                    </div>
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
      </Tabs>

      <div
        className={cn(
          "shrink-0 border-t border-border/45 bg-muted/20 pb-3 pt-2 flex flex-col gap-2 select-none",
          pxClass,
        )}
      >
        <div className="relative flex items-center rounded-xl border border-border/65 bg-background shadow-sm transition hover:border-border/80 focus-within:border-primary focus-within:ring-2 focus-within:ring-ring focus-within:ring-offset-2 focus-within:ring-offset-background">
          {promptError ? (
            <div
              role="alert"
              aria-atomic="true"
              aria-live="assertive"
              data-testid="canvas-prompt-error"
              className="absolute -top-2 right-0 left-0 -translate-y-full rounded-md border border-destructive/40 bg-destructive/10 px-3 py-1.5 text-xs text-foreground"
            >
              {promptError}
            </div>
          ) : null}
          <Input
            value={promptText}
            onChange={(e) => setPromptText(e.target.value)}
            disabled={promptSending}
            onFocus={applyTempHighlight}
            onBlur={removeTempHighlight}
            onKeyDown={(e) => {
              if (isEnterWithoutIme(e) && !e.shiftKey) {
                e.preventDefault();
                void handleSendPrompt();
              }
            }}
            aria-label="Canvas prompt"
            placeholder="Ask model to edit this document..."
            className="flex-1 border-none shadow-none h-11 focus-visible:ring-0 pr-12 text-sm pl-4.5 bg-transparent"
          />
          <Button
            type="button"
            size="icon"
            variant="ghost"
            onPointerDown={(e) => e.preventDefault()}
            onClick={() => handleSendPrompt()}
            disabled={promptSending || !promptText.trim()}
            aria-label="Send Canvas prompt"
            className={cn(
              "absolute right-1.5 size-8.5 rounded-lg transition-all duration-150 shrink-0",
              promptText.trim()
                ? "bg-primary text-primary-foreground hover:bg-primary-hover active:scale-97 shadow-sm"
                : "app-text-muted",
            )}
          >
            <SparklesIcon className="size-4" />
          </Button>
        </div>
      </div>

      {floatingCoords &&
        createPortal(
          <div
            ref={floatingRef}
            role="dialog"
            aria-label="Edit selected canvas text"
            className="fixed bg-popover text-popover-foreground border border-border shadow-lg rounded-xl p-1.5 flex flex-col gap-1.5 min-w-[320px] max-w-[420px] animate-in fade-in zoom-in-95 duration-100 select-none"
            style={{
              left: `${floatingCoords.x}px`,
              top: `${floatingCoords.y}px`,
              transform: "translate(-50%, -100%) translateY(-10px)",
              zIndex: selectionEditorOwner?.zIndex ?? 100,
            }}
          >
            {showFormattingBar && isMarkdown && activeTab === "edit" && (
              <div className="flex items-center gap-1 border-b border-border/45 pb-1 px-1">
                <Button
                  type="button"
                  size="xs"
                  variant="ghost"
                  onPointerDown={(e) => e.preventDefault()}
                  className="h-6 px-1.5 text-xs font-bold"
                  onClick={() => applyFormat("bold")}
                  aria-label="Bold"
                  title="Bold"
                >
                  <BoldIcon className="size-3" />
                </Button>
                <Button
                  type="button"
                  size="xs"
                  variant="ghost"
                  onPointerDown={(e) => e.preventDefault()}
                  className="h-6 px-1.5 text-xs italic"
                  onClick={() => applyFormat("italic")}
                  aria-label="Italic"
                  title="Italic"
                >
                  <ItalicIcon className="size-3" />
                </Button>
                <div className="h-3 w-px bg-border/40 mx-0.5" />
                <Button
                  type="button"
                  size="xs"
                  variant="ghost"
                  onPointerDown={(e) => e.preventDefault()}
                  className="h-6 px-1.5 text-xs font-bold"
                  onClick={() => applyFormat("h1")}
                >
                  H1
                </Button>
                <Button
                  type="button"
                  size="xs"
                  variant="ghost"
                  onPointerDown={(e) => e.preventDefault()}
                  className="h-6 px-1.5 text-xs font-bold"
                  onClick={() => applyFormat("h2")}
                >
                  H2
                </Button>
                <Button
                  type="button"
                  size="xs"
                  variant="ghost"
                  onPointerDown={(e) => e.preventDefault()}
                  className="h-6 px-1.5 text-xs"
                  onClick={() => applyFormat("ul")}
                  aria-label="Bullet list"
                  title="Bullet list"
                >
                  <ListIcon className="size-3" />
                </Button>
                <div className="ml-auto text-xs app-text-muted px-1 font-medium">Format</div>
              </div>
            )}

            <div className="flex items-center gap-1 rounded-lg focus-within:ring-2 focus-within:ring-ring">
              <Input
                value={floatingPromptText}
                onChange={(e) => setFloatingPromptText(e.target.value)}
                disabled={promptSending}
                onFocus={applyTempHighlight}
                onBlur={removeTempHighlight}
                onPointerDown={(e) => {
                  // Clicking inside the input should NOT trigger the global window pointer down
                  // handler to close the floating bar, but we DO want the browser to natively
                  // place the cursor inside this input, so we use stopPropagation instead of preventDefault
                  e.stopPropagation();
                }}
                onKeyDown={(e) => {
                  if (isImeComposing(e.nativeEvent)) return;
                  if (isEnterWithoutIme(e) && !e.shiftKey) {
                    e.preventDefault();
                    void handleSendPrompt(floatingPromptText);
                  } else if (e.key === "Escape") {
                    selectionEditorOwner?.handleEscape(e);
                  }
                }}
                aria-label="Edit selected text prompt"
                placeholder="How should the model edit this selection?"
                className="flex-1 border-none shadow-none h-8 text-xs px-2 focus-visible:ring-0 bg-transparent"
              />
            </div>
          </div>,
          document.body,
        )}
    </div>
  );
}
