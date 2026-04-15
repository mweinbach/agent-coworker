import { useMemo } from "react";

import { DownloadIcon, LoaderCircleIcon, RefreshCwIcon, RotateCcwIcon } from "lucide-react";

import type { UpdaterState } from "../../../lib/desktopApi";
import { useAppStore } from "../../../app/store";
import { MessageResponse } from "../../../components/ai-elements/message";
import { Badge } from "../../../components/ui/badge";
import { Button } from "../../../components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../../../components/ui/card";

function formatTimestamp(value: string | null): string {
  if (!value) {
    return "Never";
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return value;
  }
  return parsed.toLocaleString();
}

function statusLabel(phase: string): string {
  switch (phase) {
    case "disabled":
      return "Not available in dev mode";
    case "idle":
      return "Ready";
    case "checking":
      return "Checking";
    case "available":
      return "Found";
    case "downloading":
      return "Downloading";
    case "downloaded":
      return "Ready to restart";
    case "up-to-date":
      return "Up to date";
    case "error":
      return "Error";
    default:
      return phase;
  }
}

function statusVariant(phase: string): "secondary" | "outline" | "destructive" {
  if (phase === "error") {
    return "destructive";
  }
  if (phase === "downloaded") {
    return "secondary";
  }
  return "outline";
}

type UpdatesPageProps = {
  state?: UpdaterState;
  onCheckForUpdates?: () => void | Promise<void>;
  onQuitAndInstallUpdate?: () => void | Promise<void>;
};

export function UpdatesPage(props: UpdatesPageProps = {}) {
  const storedUpdateState = useAppStore((s) => s.updateState);
  const storedCheckForUpdates = useAppStore((s) => s.checkForUpdates);
  const storedQuitAndInstallUpdate = useAppStore((s) => s.quitAndInstallUpdate);
  const updateState = props.state ?? storedUpdateState;
  const checkForUpdates = props.onCheckForUpdates ?? storedCheckForUpdates;
  const quitAndInstallUpdate = props.onQuitAndInstallUpdate ?? storedQuitAndInstallUpdate;

  const busy = updateState.phase === "checking" || updateState.phase === "downloading";
  const canCheck = updateState.packaged && !busy;
  const canInstall = updateState.packaged && updateState.phase === "downloaded";
  const progressPercent = Math.round(updateState.progress?.percent ?? 0);

  const primaryMessage = useMemo(() => {
    if (updateState.error) {
      return updateState.error;
    }
    return updateState.message ?? "No update activity yet.";
  }, [updateState.error, updateState.message]);

  return (
    <div className="space-y-5" data-update-phase={updateState.phase}>
      <Card className="border-border/80 bg-card/85">
        <CardHeader className="flex-row items-center justify-between space-y-0">
          <div>
            <CardTitle>Current build</CardTitle>
            <CardDescription>
              {updateState.packaged
                ? "Updater checks only work when packaged update metadata exists for this platform."
                : "This is a development build, so in-app update checks are disabled."}
            </CardDescription>
          </div>
          <Badge variant={statusVariant(updateState.phase)}>{statusLabel(updateState.phase)}</Badge>
        </CardHeader>
        <CardContent className="space-y-4">
          {!updateState.packaged ? (
            <div className="rounded-xl border border-dashed border-border/70 bg-muted/20 p-4 text-sm text-muted-foreground">
              Updates only work in packaged builds. Check the <a href="https://github.com/agent-coworker/agent-coworker/releases" target="_blank" rel="noreferrer" className="underline hover:text-foreground transition-colors">releases page</a> for new versions.
            </div>
          ) : (
            <div className="grid gap-3 md:grid-cols-2">
              <div>
                <div className="text-xs uppercase tracking-wide text-muted-foreground">Installed version</div>
                <div className="text-sm font-medium text-foreground">{updateState.currentVersion}</div>
              </div>
              <div>
                <div className="text-xs uppercase tracking-wide text-muted-foreground">Latest seen version</div>
                <div className="text-sm font-medium text-foreground">{updateState.release?.version ?? "None yet"}</div>
              </div>
              <div>
                <div className="text-xs uppercase tracking-wide text-muted-foreground">Last check started</div>
                <div className="text-sm text-foreground">{formatTimestamp(updateState.lastCheckStartedAt)}</div>
              </div>
              <div>
                <div className="text-xs uppercase tracking-wide text-muted-foreground">Last check finished</div>
                <div className="text-sm text-foreground">{formatTimestamp(updateState.lastCheckedAt)}</div>
              </div>
            </div>
          )}

          <div className="rounded-lg border border-border/70 bg-background/70 p-4">
            <div className="text-sm font-medium text-foreground">Status</div>
            <div className="mt-1 text-sm text-muted-foreground">{primaryMessage}</div>
          </div>

          {updateState.phase === "downloading" && updateState.progress ? (
            <div className="space-y-2">
              <div className="flex items-center justify-between text-sm">
                <span className="font-medium text-foreground">Download progress</span>
                <span className="text-muted-foreground">{progressPercent}%</span>
              </div>
              <div className="h-2 overflow-hidden rounded-full bg-border/70">
                <div
                  className="h-full rounded-full bg-foreground/80 transition-[width] duration-300"
                  style={{ width: `${progressPercent}%` }}
                />
              </div>
            </div>
          ) : null}

          <div className="flex flex-wrap gap-2">
            <Button type="button" onClick={() => void checkForUpdates()} disabled={!canCheck}>
              {busy ? <LoaderCircleIcon className="h-4 w-4 animate-spin" /> : <RefreshCwIcon className="h-4 w-4" />}
              Check now
            </Button>
            <Button type="button" variant="secondary" onClick={() => void quitAndInstallUpdate()} disabled={!canInstall}>
              <RotateCcwIcon className="h-4 w-4" />
              Restart to update
            </Button>
          </div>
        </CardContent>
      </Card>

      {updateState.release ? (
        <Card className="border-border/80 bg-card/85">
          <CardHeader>
            <CardTitle>Release details</CardTitle>
            <CardDescription>Metadata reported by the packaged update feed.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid gap-3 md:grid-cols-2">
              <div>
                <div className="text-xs uppercase tracking-wide text-muted-foreground">Version</div>
                <div className="text-sm font-medium text-foreground">{updateState.release.version}</div>
              </div>
              <div>
                <div className="text-xs uppercase tracking-wide text-muted-foreground">Release date</div>
                <div className="text-sm text-foreground">{formatTimestamp(updateState.release.releaseDate ?? null)}</div>
              </div>
            </div>

            {updateState.release.releaseName ? (
              <div>
                <div className="text-xs uppercase tracking-wide text-muted-foreground">Release name</div>
                <div className="text-sm text-foreground">{updateState.release.releaseName}</div>
              </div>
            ) : null}

            {updateState.release.releaseNotes ? (
              <div>
                <div className="text-xs uppercase tracking-wide text-muted-foreground">Release notes</div>
                <MessageResponse className="mt-2 max-w-none text-sm leading-6 text-muted-foreground [&_h1]:text-lg [&_h1]:font-semibold [&_h2]:text-base [&_h2]:font-semibold [&_p]:text-muted-foreground [&_ul]:text-muted-foreground">
                  {updateState.release.releaseNotes}
                </MessageResponse>
              </div>
            ) : null}

            {updateState.release.releasePageUrl ? (
              <div className="flex flex-wrap gap-2">
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => {
                    window.open(updateState.release!.releasePageUrl, "_blank", "noopener,noreferrer");
                  }}
                >
                  <DownloadIcon className="h-4 w-4" />
                  Open release notes
                </Button>
              </div>
            ) : null}
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}
