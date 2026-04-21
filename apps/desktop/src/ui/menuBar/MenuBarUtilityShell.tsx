import { useMemo, type CSSProperties } from "react";

import { ArrowUpRightIcon, MessageSquarePlusIcon, XIcon } from "lucide-react";

import { useAppStore } from "../../app/store";
import { Button } from "../../components/ui/button";
import { showMainWindow, showQuickChatWindow, windowClose } from "../../lib/desktopCommands";

type MenuBarUtilityShellProps = {
  init: () => Promise<void>;
  ready: boolean;
  startupError: string | null;
};

export function MenuBarUtilityShell({ init, ready, startupError }: MenuBarUtilityShellProps) {
  const workspaces = useAppStore((s) => s.workspaces);
  const threads = useAppStore((s) => s.threads);

  const recentThreads = useMemo(
    () => [...threads]
      .sort((left, right) => right.lastMessageAt.localeCompare(left.lastMessageAt))
      .slice(0, 8),
    [threads],
  );

  return (
    <div className="flex h-screen min-h-0 min-w-0 overflow-hidden rounded-[28px] bg-[radial-gradient(circle_at_top,var(--surface-overlay),transparent_56%),linear-gradient(180deg,var(--surface-shell),var(--surface-window))] p-2 text-foreground">
      <div className="app-surface-overlay flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden rounded-[26px] border border-border/55 backdrop-blur-xl">
        <div
          className="flex items-center justify-between gap-3 px-4 py-3"
          style={{ WebkitAppRegion: "drag" } as CSSProperties}
        >
          <div className="min-w-0">
            <div className="truncate text-[0.95rem] font-semibold tracking-tight text-foreground">
              Cowork
            </div>
            <div className="truncate text-xs text-muted-foreground">
              Menu bar quick actions
            </div>
          </div>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            className="h-9 w-9 rounded-full border border-border/50 bg-background/80 text-muted-foreground hover:bg-background hover:text-foreground"
            aria-label="Close menu window"
            onClick={() => void windowClose()}
            style={{ WebkitAppRegion: "no-drag" } as CSSProperties}
          >
            <XIcon className="h-4 w-4" />
          </Button>
        </div>

        <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-hidden px-2 pb-2">
          {!ready ? (
            <div className="flex min-h-0 flex-1 items-center justify-center rounded-[22px] border border-border/45 bg-panel/75 px-6 text-sm font-medium text-muted-foreground">
              Starting menu bar tools…
            </div>
          ) : startupError ? (
            <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 rounded-[22px] border border-border/45 bg-panel/75 px-6 text-center">
              <div className="max-w-sm text-sm text-muted-foreground">{startupError}</div>
              <Button type="button" variant="outline" onClick={() => void init()}>
                Retry
              </Button>
            </div>
          ) : (
            <>
              <div className="grid grid-cols-2 gap-2">
                <Button
                  type="button"
                  variant="outline"
                  className="justify-start rounded-2xl"
                  onClick={() => void showQuickChatWindow()}
                >
                  <MessageSquarePlusIcon className="mr-2 h-4 w-4" />
                  Open Quick Chat
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  className="justify-start rounded-2xl"
                  onClick={() => void showMainWindow().then(() => windowClose())}
                >
                  <ArrowUpRightIcon className="mr-2 h-4 w-4" />
                  Open Cowork
                </Button>
              </div>

              <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-[22px] border border-border/45 bg-panel/75">
                <div className="border-b border-border/40 px-4 py-3 text-[11px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">
                  Recent Chats
                </div>
                <div className="min-h-0 flex-1 overflow-y-auto px-2 py-2">
                  {recentThreads.length === 0 ? (
                    <div className="px-3 py-6 text-sm text-muted-foreground">
                      No chats yet. Start a quick chat to create one.
                    </div>
                  ) : (
                    <div className="space-y-1.5">
                      {recentThreads.map((thread) => {
                        const workspaceName =
                          workspaces.find((workspace) => workspace.id === thread.workspaceId)?.name ?? "Cowork";
                        return (
                          <div
                            key={thread.id}
                            className="group/menu-row flex items-center gap-2 rounded-2xl border border-transparent px-2 py-1.5 hover:border-border/35 hover:bg-background/45"
                          >
                            <button
                              type="button"
                              className="min-w-0 flex-1 text-left"
                              onClick={() => void showQuickChatWindow({ threadId: thread.id }).then(() => windowClose())}
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
                              className="h-8 w-8 rounded-full text-muted-foreground opacity-75 transition group-hover/menu-row:opacity-100 hover:bg-background hover:text-foreground"
                              aria-label={`Open ${thread.title} in quick chat`}
                              onClick={() => void showQuickChatWindow({ threadId: thread.id }).then(() => windowClose())}
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
            </>
          )}
        </div>
      </div>
    </div>
  );
}
