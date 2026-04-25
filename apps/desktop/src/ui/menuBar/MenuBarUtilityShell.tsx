import { ArrowUpRightIcon, MessageSquarePlusIcon, XIcon } from "lucide-react";
import { type CSSProperties, useMemo } from "react";

import { useAppStore } from "../../app/store";
import { Button } from "../../components/ui/button";
import { showMainWindow, showQuickChatWindow, windowClose } from "../../lib/desktopCommands";
import { cn } from "../../lib/utils";

type MenuBarUtilityShellProps = {
  init: () => Promise<void>;
  ready: boolean;
  startupError: string | null;
};

export function MenuBarUtilityShell({ init, ready, startupError }: MenuBarUtilityShellProps) {
  const workspaces = useAppStore((s) => s.workspaces);
  const threads = useAppStore((s) => s.threads);

  const recentThreads = useMemo(
    () =>
      [...threads]
        .sort((left, right) => right.lastMessageAt.localeCompare(left.lastMessageAt))
        .slice(0, 8),
    [threads],
  );

  return (
    <div className="flex h-full min-h-0 w-full min-w-0 overflow-hidden bg-transparent p-0 text-foreground">
      <div className="app-surface-overlay flex h-full min-h-0 w-full min-w-0 flex-1 flex-col overflow-hidden bg-[radial-gradient(circle_at_top,var(--surface-overlay),transparent_56%),linear-gradient(180deg,var(--surface-shell),var(--surface-window))] backdrop-blur-xl ring-inset ring-1 ring-black/5 [contain:paint]">
        <div
          className="flex items-center justify-between gap-2 px-2.5 py-1"
          style={{ WebkitAppRegion: "drag" } as CSSProperties}
        >
          <div className="min-w-0 flex-1 truncate text-[0.8125rem] font-semibold leading-none tracking-tight text-foreground">
            Cowork
          </div>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            className="h-6 w-6 min-h-6 min-w-6 shrink-0 rounded-full border border-border/50 bg-background/80 p-0 text-muted-foreground hover:bg-background hover:text-foreground"
            aria-label="Close menu window"
            onClick={() => void windowClose()}
            style={{ WebkitAppRegion: "no-drag" } as CSSProperties}
          >
            <XIcon className="h-3 w-3" />
          </Button>
        </div>

        <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
          {!ready ? (
            <div className="flex min-h-0 flex-1 items-center justify-center px-5 text-sm font-medium text-muted-foreground">
              Starting menu bar tools…
            </div>
          ) : startupError ? (
            <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 px-5 text-center">
              <div className="max-w-sm text-sm text-muted-foreground">{startupError}</div>
              <Button type="button" variant="outline" onClick={() => void init()}>
                Retry
              </Button>
            </div>
          ) : (
            <div className="flex min-h-0 min-w-0 flex-1 flex-col">
              <div className="grid auto-rows-[1fr] grid-cols-2 items-stretch gap-0.5 px-2 pb-0.5 pt-0">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className={cn(
                    "h-full min-h-[2.5rem] w-full min-w-0 flex-col justify-center gap-0.5 rounded-md px-1 py-0 text-[10px] font-medium leading-tight text-foreground shadow-none",
                    "border border-border/50 bg-primary/10 hover:bg-primary/[0.14] hover:text-foreground",
                  )}
                  onClick={() => void showQuickChatWindow({ newThread: true }).then(() => windowClose())}
                >
                  <MessageSquarePlusIcon className="h-3.5 w-3.5 shrink-0 opacity-90" />
                  <span className="line-clamp-2 w-full text-balance text-center">New chat</span>
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className={cn(
                    "h-full min-h-[2.5rem] w-full min-w-0 flex-col justify-center gap-0.5 rounded-md border border-border/50 bg-muted/30 px-1 py-0 text-[10px] font-medium leading-tight text-foreground shadow-none",
                    "hover:bg-muted/50 hover:text-foreground",
                  )}
                  onClick={() => void showMainWindow().then(() => windowClose())}
                >
                  <ArrowUpRightIcon className="h-3.5 w-3.5 shrink-0 opacity-90" />
                  <span className="line-clamp-2 w-full text-balance text-center">Open Cowork</span>
                </Button>
              </div>

              <div className="flex min-h-0 flex-1 flex-col border-t border-border/35">
                <div className="shrink-0 px-2 pb-0.5 pt-1 text-[10px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">
                  Recent Chats
                </div>
                <div className="min-h-0 flex-1 overflow-y-auto px-1 pb-1.5">
                  {recentThreads.length === 0 ? (
                    <div className="px-1.5 py-1.5 text-[12px] leading-snug text-muted-foreground">
                      No chats yet. Start a quick chat to create one.
                    </div>
                  ) : (
                    <div className="space-y-0.5">
                      {recentThreads.map((thread) => {
                        const workspaceName =
                          workspaces.find((workspace) => workspace.id === thread.workspaceId)
                            ?.name ?? "Cowork";
                        return (
                          <div
                            key={thread.id}
                            className="group/menu-row flex items-center gap-1 rounded-lg border border-transparent px-1 py-1 hover:border-border/30 hover:bg-background/50"
                          >
                            <button
                              type="button"
                              className="min-w-0 flex-1 text-left"
                              onClick={() =>
                                void showQuickChatWindow({ threadId: thread.id }).then(() =>
                                  windowClose(),
                                )
                              }
                            >
                              <div className="truncate text-[13px] font-medium tracking-[-0.016em] text-foreground">
                                {thread.title}
                              </div>
                              <div className="truncate text-[11px] text-muted-foreground">
                                {workspaceName}
                              </div>
                            </button>
                            <Button
                              type="button"
                              variant="ghost"
                              size="icon-sm"
                              className="h-7 w-7 min-h-7 min-w-7 shrink-0 rounded-full p-0 text-muted-foreground opacity-75 transition group-hover/menu-row:opacity-100 hover:bg-background hover:text-foreground"
                              aria-label={`Open ${thread.title} in quick chat`}
                              onClick={() =>
                                void showQuickChatWindow({ threadId: thread.id }).then(() =>
                                  windowClose(),
                                )
                              }
                            >
                              <ArrowUpRightIcon className="h-4 w-4" />
                            </Button>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
