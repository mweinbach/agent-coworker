import {
  BoldIcon,
  CheckIcon,
  EyeIcon,
  FileTextIcon,
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
import { cleanMarkdown, markdownToHtml, nodeToMarkdown } from "../lib/canvasMarkdown";
import { readFile, writeFile } from "../lib/desktopCommands";
import { getFilePreviewKind, isSlideModule } from "../lib/filePreviewKind";
import { cn } from "../lib/utils";
import { getDesktopWindowMode } from "../lib/windowMode";
import { CanvasElectronTitlebar } from "./canvas/CanvasElectronTitlebar";
import { CanvasFilePreviewLayout } from "./canvas/CanvasFilePreviewLayout";
import { PptxPreview } from "./PptxPreview";
import { SlidePreview } from "./SlidePreview";
import { SpreadsheetPreview } from "./SpreadsheetPreview";

function basenamePath(p: string): string {
  const parts = p.replace(/\\/g, "/").split("/").filter(Boolean);
  return parts[parts.length - 1] ?? p;
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
  const [previewRefreshTrigger, setPreviewRefreshTrigger] = useState<number>(0);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);
  const [promptText, setPromptText] = useState<string>("");
  const [selectedText, setSelectedText] = useState<string>("");
  const [floatingCoords, setFloatingCoords] = useState<{ x: number; y: number } | null>(null);
  const [floatingPromptText, setFloatingPromptText] = useState<string>("");

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
      const fileContent = await readFile({ path });
      setContent(fileContent);
      contentRef.current = fileContent;
      lastSavedContentRef.current = fileContent;
      setError(null);
      if (editorRef.current && isMarkdown) {
        editorRef.current.innerHTML = markdownToHtml(fileContent);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [path, isMarkdown, isSpreadsheet, isPptx]);

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
        const diskContent = await readFile({ path });
        if (!active) return;
        if (diskContent !== contentRef.current) {
          setContent(diskContent);
          contentRef.current = diskContent;
          lastSavedContentRef.current = diskContent;
          if (editorRef.current && isMarkdown) {
            editorRef.current.innerHTML = markdownToHtml(diskContent);
          }
          setPreviewRefreshTrigger((t) => t + 1);
        }
      } catch {}
    }, 1500);

    return () => {
      active = false;
      clearInterval(interval);
    };
  }, [path, isMarkdown, isSpreadsheet, isPptx]);

  useEffect(() => {
    if (isSpreadsheet || isPptx) return;
    const timer = setTimeout(async () => {
      if (content === lastSavedContentRef.current) return;
      try {
        await writeFile({ path, content });
        lastSavedContentRef.current = content;
        contentRef.current = content;
        setPreviewRefreshTrigger((t) => t + 1);
      } catch (err) {
        console.error("Failed to auto-save file:", err);
      }
    }, 500);

    return () => clearTimeout(timer);
  }, [content, path, isSpreadsheet, isPptx]);

  useEffect(() => {
    if (activeTab === "preview") {
      setPreviewRefreshTrigger((t) => t + 1);
    }
  }, [activeTab]);

  const fileName = basenamePath(path);
  const isAgentBusy = threadRuntime?.busy === true;

  if (isSpreadsheet) {
    return (
      <CanvasFilePreviewLayout
        isCanvasMode={isCanvasMode}
        isAgentBusy={isAgentBusy}
        fileName={fileName}
        previewKind={previewKind}
        onClose={closeFilePreview}
      >
        <SpreadsheetPreview path={path} compact />
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

  useEffect(() => {
    if (!floatingCoords) {
      if ("Highlight" in window) {
        try {
          (CSS as any).highlights.delete("canvas-temp-highlight");
        } catch (_e) {}
      }
      savedSelectionRangeRef.current = null;
    }
  }, [floatingCoords]);

  const handleInput = () => {
    if (!editorRef.current) return;
    const _html = editorRef.current.innerHTML;
    const md = cleanMarkdown(nodeToMarkdown(editorRef.current));
    setContent(md);
    contentRef.current = md;
    isEditingRef.current = true;
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if ((e.metaKey || e.ctrlKey) && (e.key === "b" || e.key === "i")) {
      setTimeout(handleInput, 0);
    }
  };

  const executeCommand = (command: string, value: string = "") => {
    document.execCommand(command, false, value);
    handleInput();
    if (editorRef.current) {
      editorRef.current.focus();
    }
  };

  const handleContentChange = (val: string) => {
    setContent(val);
    contentRef.current = val;
    isEditingRef.current = true;
    if (editorRef.current && isMarkdown) {
      editorRef.current.innerHTML = markdownToHtml(val);
    }
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
  }, [activeTab]);

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
  }, [clearSelectionState]);

  const handleSendPrompt = async (explicitPrompt?: string) => {
    const textToSend = (explicitPrompt !== undefined ? explicitPrompt : promptText).trim();
    if (!textToSend) return;
    if (!selectedThreadId) {
      alert("Please select or start a chat thread to collaborate with the agent.");
      return;
    }

    const filename = basenamePath(path);
    let promptWithContext = `[Canvas Collaborative Edit]
Please edit the file \`${filename}\` (located at \`${path}\`) based on my instructions below.

**Instructions:**
${textToSend}`;

    if (selectedText) {
      promptWithContext += `\n\n**Target Section / Selection:**
> ${selectedText}`;
    }

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
                </DropdownMenuContent>
              </DropdownMenu>
            }
          />
        ) : null}

        {showFormattingBar && isMarkdown && activeTab === "preview" && (
          <div className="flex items-center gap-0.5 px-2.5 py-1 border-b border-border/40 bg-muted/15 shrink-0 select-none">
            <Button
              type="button"
              variant="ghost"
              size="icon"
              onPointerDown={(e) => e.preventDefault()}
              onClick={() => executeCommand("bold")}
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
              onClick={() => executeCommand("italic")}
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
              onClick={() => executeCommand("formatBlock", "H1")}
              className="h-7 px-1.5 rounded-md font-semibold text-[11px] text-muted-foreground hover:text-foreground hover:bg-muted/60"
              title="Heading 1"
            >
              H1
            </Button>
            <Button
              type="button"
              variant="ghost"
              onPointerDown={(e) => e.preventDefault()}
              onClick={() => executeCommand("formatBlock", "H2")}
              className="h-7 px-1.5 rounded-md font-semibold text-[11px] text-muted-foreground hover:text-foreground hover:bg-muted/60"
              title="Heading 2"
            >
              H2
            </Button>
            <Button
              type="button"
              variant="ghost"
              onPointerDown={(e) => e.preventDefault()}
              onClick={() => executeCommand("formatBlock", "H3")}
              className="h-7 px-1.5 rounded-md font-semibold text-[11px] text-muted-foreground hover:text-foreground hover:bg-muted/60"
              title="Heading 3"
            >
              H3
            </Button>
            <Button
              type="button"
              variant="ghost"
              onPointerDown={(e) => e.preventDefault()}
              onClick={() => executeCommand("formatBlock", "P")}
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
              onClick={() => executeCommand("insertUnorderedList")}
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
              onClick={() => executeCommand("insertOrderedList")}
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
          ) : isMarkdown ? (
            <>
              <TabsContent value="preview" className="h-full m-0 p-0 outline-none">
                <ScrollArea className="h-full">
                  <div className="mx-auto w-full max-w-[840px] px-4 py-8">
                    <div
                      ref={(el) => {
                        editorRef.current = el;
                        if (el && !el.innerHTML) {
                          el.innerHTML = markdownToHtml(content);
                        }
                      }}
                      role="textbox"
                      contentEditable
                      suppressContentEditableWarning
                      onInput={handleInput}
                      onKeyDown={handleKeyDown}
                      onBlur={handleBlur}
                      className="mx-auto w-full min-h-[1056px] p-12 md:p-16 focus:outline-none focus:ring-0 max-w-none text-left select-text leading-relaxed [&_p]:mb-4 [&_h1]:text-4xl [&_h1]:font-bold [&_h1]:mb-6 [&_h1]:mt-8 [&_h2]:text-3xl [&_h2]:font-bold [&_h2]:mb-4 [&_h2]:mt-8 [&_h3]:text-2xl [&_h3]:font-semibold [&_h3]:mb-4 [&_h3]:mt-6 [&_h4]:text-xl [&_h4]:font-semibold [&_h4]:mb-3 [&_h4]:mt-6 [&_h5]:text-lg [&_h5]:font-semibold [&_h5]:mb-2 [&_h5]:mt-4 [&_ul]:list-disc [&_ul]:pl-6 [&_ul]:mb-4 [&_ol]:list-decimal [&_ol]:pl-6 [&_ol]:mb-4 [&_li]:mb-1 [&_blockquote]:border-l-4 [&_blockquote]:border-border/80 [&_blockquote]:pl-4 [&_blockquote]:italic [&_blockquote]:mb-4 [&_hr]:my-8 [&_hr]:border-border/60 [&_pre]:bg-muted/40 [&_pre]:p-4 [&_pre]:rounded-md [&_pre]:mb-4 [&_code]:bg-muted/70 [&_code]:px-1.5 [&_code]:py-0.5 [&_code]:rounded-sm"
                    />
                  </div>
                </ScrollArea>
              </TabsContent>

              <TabsContent value="edit" className="h-full m-0 p-0 outline-none bg-background">
                <div className={cn("flex h-full flex-col pb-2.5 pt-1.5 gap-2", pxClass)}>
                  <div className="text-[10px] text-muted-foreground px-1 flex items-center justify-between shrink-0">
                    <span>Markdown Source</span>
                    <span className="tabular-nums font-mono">{content.length} characters</span>
                  </div>
                  <Textarea
                    value={content}
                    onChange={(e) => handleContentChange(e.target.value)}
                    onBlur={handleBlur}
                    placeholder="Type your markdown here..."
                    className="flex-1 min-h-0 resize-none font-mono text-sm leading-relaxed p-4 bg-background/50 border border-border/60 focus-visible:ring-1 focus-visible:ring-primary focus-visible:border-primary/80"
                  />
                </div>
              </TabsContent>
            </>
          ) : isSlide ? (
            <>
              <TabsContent value="preview" className="h-full m-0 p-0 outline-none">
                <SlidePreview path={path} refreshTrigger={previewRefreshTrigger} />
              </TabsContent>

              <TabsContent value="edit" className="h-full m-0 p-0 outline-none bg-background">
                <div className={cn("flex h-full flex-col pb-2.5 pt-1.5 gap-2", pxClass)}>
                  <div className="text-[10px] text-muted-foreground px-1 flex items-center justify-between shrink-0">
                    <span>Slide Source Code</span>
                    <span className="tabular-nums font-mono">{content.length} characters</span>
                  </div>
                  <Textarea
                    value={content}
                    onChange={(e) => handleContentChange(e.target.value)}
                    onBlur={handleBlur}
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
                <span>Source Editor (Auto-saving)</span>
                <span className="tabular-nums font-mono">{content.length} characters</span>
              </div>
              <div className={cn("flex-1 min-h-0", pxClass)}>
                <Textarea
                  value={content}
                  onChange={(e) => handleContentChange(e.target.value)}
                  onBlur={handleBlur}
                  placeholder="Type your text here..."
                  className="w-full h-full resize-none font-mono text-sm leading-relaxed p-4 bg-background/50 border border-border/60 focus-visible:ring-1 focus-visible:ring-primary focus-visible:border-primary/80"
                />
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
            {showFormattingBar && isMarkdown && (
              <div className="flex items-center gap-1 border-b border-border/45 pb-1 px-1">
                <Button
                  type="button"
                  size="xs"
                  variant="ghost"
                  onPointerDown={(e) => e.preventDefault()}
                  className="h-6 px-1.5 text-[10px] font-bold"
                  onClick={() => executeCommand("bold")}
                >
                  <BoldIcon className="size-3" />
                </Button>
                <Button
                  type="button"
                  size="xs"
                  variant="ghost"
                  onPointerDown={(e) => e.preventDefault()}
                  className="h-6 px-1.5 text-[10px] italic"
                  onClick={() => executeCommand("italic")}
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
                  onClick={() => executeCommand("formatBlock", "H1")}
                >
                  H1
                </Button>
                <Button
                  type="button"
                  size="xs"
                  variant="ghost"
                  onPointerDown={(e) => e.preventDefault()}
                  className="h-6 px-1.5 text-[10px] font-bold"
                  onClick={() => executeCommand("formatBlock", "H2")}
                >
                  H2
                </Button>
                <Button
                  type="button"
                  size="xs"
                  variant="ghost"
                  onPointerDown={(e) => e.preventDefault()}
                  className="h-6 px-1.5 text-[10px]"
                  onClick={() => executeCommand("insertUnorderedList")}
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
