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
  SparklesIcon,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useAppStore } from "../app/store";
import { Button } from "../components/ui/button";
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
import { applyMarkdownFormat, type MarkdownFormatKind } from "../lib/canvasMarkdownFormat";
import { buildCanvasDocumentPrompt } from "../lib/canvasRequest";
import { openPath, readFileForPreview, revealPath, writeFile } from "../lib/desktopCommands";
import { getDesktopPlatformInfo } from "../lib/desktopPlatform";
import { getFilePreviewKind, isSlideModule } from "../lib/filePreviewKind";
import { cn } from "../lib/utils";
import { getDesktopWindowMode } from "../lib/windowMode";
import { CanvasElectronTitlebar } from "./canvas/CanvasElectronTitlebar";
import { CanvasFilePreviewLayout } from "./canvas/CanvasFilePreviewLayout";
import { LazyUniverSpreadsheetCanvas } from "./LazyUniverSpreadsheetCanvas";
import { DesktopMarkdown } from "./markdown";
import { PptxPreview } from "./PptxPreview";
import { SlidePreview } from "./SlidePreview";

function decodeUtf8(bytes: Uint8Array): string {
  return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
}

function basenamePath(p: string): string {
  const parts = p.replace(/\\/g, "/").split("/").filter(Boolean);
  return parts[parts.length - 1] ?? p;
}

const CANVAS_PREVIEW_MAX_BYTES = 256 * 1024;

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
  const [content, setContent] = useState<string>("");
  const [contentTruncated, setContentTruncated] = useState<boolean>(false);
  const [previewRefreshTrigger, setPreviewRefreshTrigger] = useState<number>(0);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);
  const [saveStatus, setSaveStatus] = useState<"saved" | "dirty" | "saving" | "error">("saved");
  const [promptText, setPromptText] = useState<string>("");
  const [selectedText, setSelectedText] = useState<string>("");
  const [floatingCoords, setFloatingCoords] = useState<{ x: number; y: number } | null>(null);
  const [floatingPromptText, setFloatingPromptText] = useState<string>("");
  const [promptError, setPromptError] = useState<string | null>(null);

  const contentRef = useRef<string>("");
  const isEditingRef = useRef<boolean>(false);
  const lastSavedContentRef = useRef<string>("");
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

  const loadContent = useCallback(async () => {
    if (isSpreadsheet || isPptx) return;
    try {
      setLoading(true);
      const result = await readFileForPreview({ path, maxBytes: CANVAS_PREVIEW_MAX_BYTES });
      const fileContent = decodeUtf8(result.bytes);
      setContent(fileContent);
      setContentTruncated(result.truncated);
      contentRef.current = fileContent;
      lastSavedContentRef.current = fileContent;
      setSaveStatus("saved");
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [path, isSpreadsheet, isPptx]);

  useEffect(() => {
    if (isSpreadsheet || isPptx) return;
    void loadContent();
  }, [loadContent, isSpreadsheet, isPptx]);

  useEffect(() => {
    if (isSpreadsheet || isPptx) return;
    let active = true;
    const interval = setInterval(async () => {
      if (isEditingRef.current) return;

      try {
        const result = await readFileForPreview({ path, maxBytes: CANVAS_PREVIEW_MAX_BYTES });
        const diskContent = decodeUtf8(result.bytes);
        if (!active) return;
        setContentTruncated(result.truncated);
        if (diskContent !== contentRef.current) {
          setContent(diskContent);
          contentRef.current = diskContent;
          lastSavedContentRef.current = diskContent;
          setPreviewRefreshTrigger((t) => t + 1);
        }
      } catch {}
    }, 1500);

    return () => {
      active = false;
      clearInterval(interval);
    };
  }, [path, isSpreadsheet, isPptx]);

  useEffect(() => {
    if (isSpreadsheet || isPptx) return;
    if (contentTruncated) return;
    if (content === lastSavedContentRef.current) {
      setSaveStatus((current) => (current === "saving" ? current : "saved"));
      return;
    }
    setSaveStatus("dirty");
    const timer = setTimeout(async () => {
      setSaveStatus("saving");
      try {
        await writeFile({ path, content });
        lastSavedContentRef.current = content;
        contentRef.current = content;
        setSaveStatus("saved");
        setPreviewRefreshTrigger((t) => t + 1);
      } catch (err) {
        console.error("Failed to auto-save file:", err);
        setSaveStatus("error");
      }
    }, 500);

    return () => clearTimeout(timer);
  }, [content, contentTruncated, path, isSpreadsheet, isPptx]);

  useEffect(() => {
    if (activeTab === "preview") {
      setPreviewRefreshTrigger((t) => t + 1);
    }
  }, [activeTab]);

  const fileName = basenamePath(path);
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
    setContent(val);
    contentRef.current = val;
    isEditingRef.current = true;
  };

  const handleBlur = () => {
    isEditingRef.current = false;
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
    if (!textToSend) return;
    if (!selectedThreadId) {
      setPromptError("Please select or start a chat thread to collaborate with the agent.");
      return;
    }
    setPromptError(null);

    const filename = basenamePath(path);
    const canvasKind = isMarkdown ? "markdown" : isSlide ? "slide" : "text";
    const promptWithContext = buildCanvasDocumentPrompt({
      path,
      fileName: filename,
      kind: canvasKind,
      selection: selectedText || null,
      request: textToSend,
    });

    const originalPrompt = promptText;
    if (explicitPrompt !== undefined) {
      setFloatingPromptText("");
    } else {
      setPromptText("");
    }
    clearSelection();

    try {
      await sendMessage(promptWithContext);
    } catch (err) {
      console.error("Failed to send collaborative edit instructions:", err);
      if (explicitPrompt !== undefined) {
        setFloatingPromptText(explicitPrompt);
      } else {
        setPromptText(originalPrompt);
      }
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
        "app-canvas flex h-full w-full flex-col text-foreground overflow-hidden",
        isCanvasMode ? "bg-transparent" : "bg-background",
        !isCanvasMode && "border-l border-border/50",
      )}
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
                  <span className="text-xs font-semibold text-muted-foreground/80 shrink-0 select-none">
                    {projectTitle}
                  </span>
                  <span className="text-[10px] text-muted-foreground/40 select-none">/</span>
                  <span className="truncate text-xs font-bold text-foreground" title={fileName}>
                    {fileName}
                  </span>
                </div>
              </>
            }
            trailing={
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="size-7 text-muted-foreground hover:text-foreground hover:bg-muted/50 rounded-lg outline-none focus:outline-none"
                    title="View options"
                  >
                    <MoreVerticalIcon className="size-4" />
                  </Button>
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
          <div className="flex items-center gap-0.5 px-2.5 py-1 border-b border-border/40 bg-muted/15 shrink-0 select-none">
            <Button
              type="button"
              variant="ghost"
              size="icon"
              onPointerDown={(e) => e.preventDefault()}
              onClick={() => applyFormat("bold")}
              className="size-7 rounded-md text-muted-foreground hover:text-foreground hover:bg-muted/60"
              title="Bold"
            >
              <BoldIcon className="size-3.5" />
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              onPointerDown={(e) => e.preventDefault()}
              onClick={() => applyFormat("italic")}
              className="size-7 rounded-md text-muted-foreground hover:text-foreground hover:bg-muted/60"
              title="Italic"
            >
              <ItalicIcon className="size-3.5" />
            </Button>
            <div className="h-4 w-px bg-border/50 mx-1" aria-hidden />
            <Button
              type="button"
              variant="ghost"
              onPointerDown={(e) => e.preventDefault()}
              onClick={() => applyFormat("h1")}
              className="h-7 px-1.5 rounded-md font-semibold text-[11px] text-muted-foreground hover:text-foreground hover:bg-muted/60"
              title="Heading 1"
            >
              H1
            </Button>
            <Button
              type="button"
              variant="ghost"
              onPointerDown={(e) => e.preventDefault()}
              onClick={() => applyFormat("h2")}
              className="h-7 px-1.5 rounded-md font-semibold text-[11px] text-muted-foreground hover:text-foreground hover:bg-muted/60"
              title="Heading 2"
            >
              H2
            </Button>
            <Button
              type="button"
              variant="ghost"
              onPointerDown={(e) => e.preventDefault()}
              onClick={() => applyFormat("h3")}
              className="h-7 px-1.5 rounded-md font-semibold text-[11px] text-muted-foreground hover:text-foreground hover:bg-muted/60"
              title="Heading 3"
            >
              H3
            </Button>
            <Button
              type="button"
              variant="ghost"
              onPointerDown={(e) => e.preventDefault()}
              onClick={() => applyFormat("paragraph")}
              className="h-7 px-1.5 rounded-md text-[11px] text-muted-foreground hover:text-foreground hover:bg-muted/60"
              title="Normal Text"
            >
              Normal
            </Button>
            <div className="h-4 w-px bg-border/50 mx-1" aria-hidden />
            <Button
              type="button"
              variant="ghost"
              size="icon"
              onPointerDown={(e) => e.preventDefault()}
              onClick={() => applyFormat("ul")}
              className="size-7 rounded-md text-muted-foreground hover:text-foreground hover:bg-muted/60"
              title="Bullet List"
            >
              <ListIcon className="size-3.5" />
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              onPointerDown={(e) => e.preventDefault()}
              onClick={() => applyFormat("ol")}
              className="size-7 rounded-md text-muted-foreground hover:text-foreground hover:bg-muted/60"
              title="Numbered List"
            >
              <span className="font-semibold text-[10px] font-mono">1.</span>
            </Button>
          </div>
        )}

        <div className="min-h-0 flex-1 relative">
          {loading ? (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 text-sm text-muted-foreground bg-background">
              <Loader2Icon className="size-6 animate-spin text-primary" />
              <span>Reading file...</span>
            </div>
          ) : error ? (
            <div className="p-4 mx-4 my-3 text-sm text-destructive bg-destructive/10 rounded-md border border-destructive/20 bg-background">
              <div className="font-semibold mb-1">Failed to load content</div>
              <p>{error}</p>
            </div>
          ) : (
            <div className="flex h-full min-h-0 flex-col">
              {contentTruncated ? <CanvasTruncationBanner path={path} /> : null}
              <div className="min-h-0 flex-1">
                {isMarkdown ? (
                  <>
                    <TabsContent
                      value="preview"
                      className="h-full m-0 p-0 outline-none data-[state=inactive]:hidden"
                    >
                      <ScrollArea className="h-full">
                        <div className="mx-auto w-full max-w-[840px] px-4 py-8">
                          <div className="mx-auto w-full max-w-none p-12 md:p-16 text-left select-text">
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
                      className="h-full m-0 p-0 outline-none bg-background data-[state=inactive]:hidden"
                    >
                      <div className={cn("flex h-full flex-col pb-2.5 pt-1.5 gap-2", pxClass)}>
                        <div className="text-[10px] text-muted-foreground px-1 flex items-center justify-between shrink-0">
                          <span className="flex items-center gap-2">
                            <span>Markdown Source</span>
                            <span
                              data-slot="canvas-save-status"
                              className={cn(
                                "rounded-full border px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide",
                                saveStatus === "saved" && "border-success/30 text-success",
                                saveStatus === "dirty" && "border-border text-muted-foreground",
                                saveStatus === "saving" && "border-primary/30 text-primary",
                                saveStatus === "error" && "border-destructive/40 text-destructive",
                              )}
                            >
                              {saveStatus === "saved"
                                ? "Saved"
                                : saveStatus === "dirty"
                                  ? "Unsaved"
                                  : saveStatus === "saving"
                                    ? "Saving"
                                    : "Save failed"}
                            </span>
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
                          className="flex-1 min-h-0 resize-none font-mono text-sm leading-relaxed p-4 bg-background/50 border border-border/60 focus-visible:ring-1 focus-visible:ring-primary focus-visible:border-primary/80"
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
                      <SlidePreview path={path} refreshTrigger={previewRefreshTrigger} />
                    </TabsContent>

                    <TabsContent
                      forceMount
                      value="edit"
                      className="h-full m-0 p-0 outline-none bg-background data-[state=inactive]:hidden"
                    >
                      <div className={cn("flex h-full flex-col pb-2.5 pt-1.5 gap-2", pxClass)}>
                        <div className="text-[10px] text-muted-foreground px-1 flex items-center justify-between shrink-0">
                          <span>Slide Source Code</span>
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
                          className="flex-1 min-h-0 resize-none font-mono text-sm leading-relaxed p-4 bg-background/50 border border-border/60 focus-visible:ring-1 focus-visible:ring-primary focus-visible:border-primary/80"
                        />
                      </div>
                    </TabsContent>
                  </>
                ) : (
                  <div className="h-full flex flex-col pb-2.5 pt-1.5 gap-2 bg-background">
                    <div
                      className={cn(
                        "text-[10px] text-muted-foreground px-1 flex items-center justify-between shrink-0",
                        pxClass,
                      )}
                    >
                      <span className="flex items-center gap-2">
                        <span>Source Editor</span>
                        <span
                          data-slot="canvas-save-status"
                          className={cn(
                            "rounded-full border px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide",
                            saveStatus === "saved" && "border-success/30 text-success",
                            saveStatus === "dirty" && "border-border text-muted-foreground",
                            saveStatus === "saving" && "border-primary/30 text-primary",
                            saveStatus === "error" && "border-destructive/40 text-destructive",
                          )}
                        >
                          {saveStatus === "saved"
                            ? "Saved"
                            : saveStatus === "dirty"
                              ? "Unsaved"
                              : saveStatus === "saving"
                                ? "Saving"
                                : "Save failed"}
                        </span>
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
                        className="w-full h-full resize-none font-mono text-sm leading-relaxed p-4 bg-background/50 border border-border/60 focus-visible:ring-1 focus-visible:ring-primary focus-visible:border-primary/80"
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
        <div className="relative flex items-center bg-background border border-border/65 rounded-xl shadow-sm hover:border-border/80 transition focus-within:border-primary focus-within:ring-1 focus-within:ring-primary/30">
          {promptError ? (
            <div
              role="alert"
              data-testid="canvas-prompt-error"
              className="absolute -top-2 left-0 right-0 -translate-y-full rounded-md border border-destructive/40 bg-destructive/10 px-3 py-1.5 text-xs text-destructive"
            >
              {promptError}
            </div>
          ) : null}
          <Input
            value={promptText}
            onChange={(e) => setPromptText(e.target.value)}
            onFocus={applyTempHighlight}
            onBlur={removeTempHighlight}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                void handleSendPrompt();
              }
            }}
            placeholder="Ask model to edit this document..."
            className="flex-1 border-none shadow-none h-11 focus-visible:ring-0 pr-12 text-sm pl-4.5 bg-transparent"
          />
          <Button
            type="button"
            size="icon"
            variant="ghost"
            onPointerDown={(e) => e.preventDefault()}
            onClick={() => handleSendPrompt()}
            disabled={!promptText.trim()}
            className={cn(
              "absolute right-1.5 size-8.5 rounded-lg transition-all duration-150 shrink-0",
              promptText.trim()
                ? "bg-primary text-primary-foreground hover:bg-primary/90 active:scale-97 shadow-sm"
                : "text-muted-foreground/45",
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
            className="fixed bg-popover text-popover-foreground border border-border shadow-lg rounded-xl p-1.5 flex flex-col gap-1.5 min-w-[320px] max-w-[420px] animate-in fade-in zoom-in-95 duration-100 select-none"
            style={{
              left: `${floatingCoords.x}px`,
              top: `${floatingCoords.y}px`,
              transform: "translate(-50%, -100%) translateY(-10px)",
              zIndex: 100,
            }}
          >
            {showFormattingBar && isMarkdown && activeTab === "edit" && (
              <div className="flex items-center gap-1 border-b border-border/45 pb-1 px-1">
                <Button
                  type="button"
                  size="xs"
                  variant="ghost"
                  onPointerDown={(e) => e.preventDefault()}
                  className="h-6 px-1.5 text-[10px] font-bold"
                  onClick={() => applyFormat("bold")}
                >
                  <BoldIcon className="size-3" />
                </Button>
                <Button
                  type="button"
                  size="xs"
                  variant="ghost"
                  onPointerDown={(e) => e.preventDefault()}
                  className="h-6 px-1.5 text-[10px] italic"
                  onClick={() => applyFormat("italic")}
                >
                  <ItalicIcon className="size-3" />
                </Button>
                <div className="h-3 w-px bg-border/40 mx-0.5" />
                <Button
                  type="button"
                  size="xs"
                  variant="ghost"
                  onPointerDown={(e) => e.preventDefault()}
                  className="h-6 px-1.5 text-[10px] font-bold"
                  onClick={() => applyFormat("h1")}
                >
                  H1
                </Button>
                <Button
                  type="button"
                  size="xs"
                  variant="ghost"
                  onPointerDown={(e) => e.preventDefault()}
                  className="h-6 px-1.5 text-[10px] font-bold"
                  onClick={() => applyFormat("h2")}
                >
                  H2
                </Button>
                <Button
                  type="button"
                  size="xs"
                  variant="ghost"
                  onPointerDown={(e) => e.preventDefault()}
                  className="h-6 px-1.5 text-[10px]"
                  onClick={() => applyFormat("ul")}
                >
                  <ListIcon className="size-3" />
                </Button>
                <div className="ml-auto text-[9px] text-muted-foreground/60 px-1 font-medium">
                  Format
                </div>
              </div>
            )}

            <div className="flex items-center gap-1">
              <Input
                value={floatingPromptText}
                onChange={(e) => setFloatingPromptText(e.target.value)}
                onFocus={applyTempHighlight}
                onBlur={removeTempHighlight}
                onPointerDown={(e) => {
                  // Clicking inside the input should NOT trigger the global window pointer down
                  // handler to close the floating bar, but we DO want the browser to natively
                  // place the cursor inside this input, so we use stopPropagation instead of preventDefault
                  e.stopPropagation();
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    void handleSendPrompt(floatingPromptText);
                  } else if (e.key === "Escape") {
                    clearSelection();
                  }
                }}
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
