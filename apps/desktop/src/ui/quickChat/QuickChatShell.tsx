import { useEffect, useMemo, type CSSProperties } from "react";

import { ArrowUpRightIcon, SquarePenIcon, XIcon } from "lucide-react";

import { useAppStore } from "../../app/store";
import { Button } from "../../components/ui/button";
import { showMainWindow, windowClose } from "../../lib/desktopCommands";
import { getDesktopWindowThreadId } from "../../lib/windowMode";
import { ChatView } from "../ChatView";

type QuickChatShellProps = {
  init: () => Promise<void>;
  ready: boolean;
  startupError: string | null;
};

export function QuickChatShell({ init, ready, startupError }: QuickChatShellProps) {
  const workspaces = useAppStore((s) => s.workspaces);
  const threads = useAppStore((s) => s.threads);
  const selectedThreadId = useAppStore((s) => s.selectedThreadId);
  const newThread = useAppStore((s) => s.newThread);
  const selectThread = useAppStore((s) => s.selectThread);
  const requestedThreadId = getDesktopWindowThreadId();

  const activeThread = useMemo(
    () => threads.find((thread) => thread.id === selectedThreadId) ?? null,
    [selectedThreadId, threads],
  );
  const activeWorkspace = useMemo(
    () => workspaces.find((workspace) => workspace.id === activeThread?.workspaceId) ?? workspaces[0] ?? null,
    [activeThread?.workspaceId, workspaces],
  );

  useEffect(() => {
    if (!ready || startupError || !requestedThreadId) {
      return;
    }
    if (!threads.some((thread) => thread.id === requestedThreadId)) {
      return;
    }
    if (selectedThreadId === requestedThreadId) {
      return;
    }
    void selectThread(requestedThreadId);
  }, [ready, requestedThreadId, selectThread, selectedThreadId, startupError, threads]);

  useEffect(() => {
    if (!ready || startupError || selectedThreadId || workspaces.length === 0) {
      return;
    }
    if (requestedThreadId && threads.some((thread) => thread.id === requestedThreadId)) {
      return;
    }
    void newThread();
  }, [newThread, ready, requestedThreadId, selectedThreadId, startupError, threads, workspaces.length]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") {
        return;
      }
      event.preventDefault();
      void windowClose();
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);

  return (
    <div className="flex h-screen min-h-0 min-w-0 overflow-hidden rounded-[30px] bg-[radial-gradient(circle_at_top,var(--surface-overlay),transparent_52%),linear-gradient(180deg,var(--surface-shell),var(--surface-window))] p-2 text-foreground">
      <div className="app-surface-overlay flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden rounded-[28px] border border-border/55 backdrop-blur-xl">
        <div
          className="flex items-center justify-between gap-3 px-4 py-3"
          style={{ WebkitAppRegion: "drag" } as CSSProperties}
        >
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            className="h-9 w-9 rounded-full border border-border/50 bg-background/80 text-muted-foreground hover:bg-background hover:text-foreground"
            aria-label="Close quick chat"
            onClick={() => void windowClose()}
            style={{ WebkitAppRegion: "no-drag" } as CSSProperties}
          >
            <XIcon className="h-4 w-4" />
          </Button>
          <div className="min-w-0 flex-1 px-2">
            <div className="truncate text-[0.95rem] font-semibold tracking-tight text-foreground">
              Quick Chat
            </div>
            <div className="truncate text-xs text-muted-foreground">
              {activeWorkspace?.name ?? "Cowork"}
            </div>
          </div>
          <div className="flex items-center gap-1">
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              className="h-9 w-9 rounded-full border border-border/50 bg-background/80 text-muted-foreground hover:bg-background hover:text-foreground"
              aria-label="Start a new chat"
              onClick={() => void newThread()}
              style={{ WebkitAppRegion: "no-drag" } as CSSProperties}
            >
              <SquarePenIcon className="h-4 w-4" />
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              className="h-9 w-9 rounded-full border border-border/50 bg-background/80 text-muted-foreground hover:bg-background hover:text-foreground"
              aria-label="Open full app"
              onClick={() => {
                void showMainWindow().then(() => windowClose());
              }}
              style={{ WebkitAppRegion: "no-drag" } as CSSProperties}
            >
              <ArrowUpRightIcon className="h-4 w-4" />
            </Button>
          </div>
        </div>
        <div className="min-h-0 flex-1 overflow-hidden px-2 pb-2">
          <div className="flex h-full min-h-0 min-w-0 flex-col overflow-hidden rounded-[24px] border border-border/45 bg-panel/75">
            {!ready ? (
              <div className="flex h-full items-center justify-center">
                <div className="text-sm font-medium text-muted-foreground">Starting quick chat…</div>
              </div>
            ) : startupError ? (
              <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
                <div className="max-w-md text-sm text-muted-foreground">{startupError}</div>
                <Button type="button" variant="outline" onClick={() => void init()}>
                  Retry
                </Button>
              </div>
            ) : (
              <ChatView />
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
