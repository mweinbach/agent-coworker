import { DownloadIcon, LoaderCircleIcon, RefreshCwIcon, RotateCcwIcon } from "lucide-react";
import { useMemo } from "react";
import { useAppStore } from "../../../app/store";
import { Button } from "../../../components/ui/button";
import type { UpdaterState } from "../../../lib/desktopApi";
import { DesktopMarkdown } from "../../markdown";
import {
  SettingsPage,
  SettingsRow,
  SettingsSection,
  SettingsStatusPill,
} from "../SettingsPrimitives";

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

function statusTone(phase: string): "neutral" | "success" | "warning" | "danger" {
  if (phase === "error") {
    return "danger";
  }
  if (phase === "downloaded") {
    return "warning";
  }
  if (phase === "up-to-date") {
    return "success";
  }
  return "neutral";
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
    <SettingsPage data-update-phase={updateState.phase}>
      <SettingsSection
        title="Current build"
        description={
          updateState.packaged
            ? "Updater checks only work when packaged update metadata exists for this platform."
            : "This is a development build, so in-app update checks are disabled."
        }
        action={
          <>
            <SettingsStatusPill tone={statusTone(updateState.phase)}>
              {statusLabel(updateState.phase)}
            </SettingsStatusPill>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => void checkForUpdates()}
              disabled={!canCheck}
            >
              {busy ? (
                <LoaderCircleIcon data-icon="inline-start" className="animate-spin" />
              ) : (
                <RefreshCwIcon data-icon="inline-start" />
              )}
              Check now
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => void quitAndInstallUpdate()}
              disabled={!canInstall}
            >
              <RotateCcwIcon data-icon="inline-start" />
              Restart to update
            </Button>
          </>
        }
      >
        {!updateState.packaged ? (
          <SettingsRow
            title="Packaged builds only"
            description={
              <>
                Updates only work in packaged builds. Check the{" "}
                <a
                  href="https://github.com/agent-coworker/agent-coworker/releases"
                  target="_blank"
                  rel="noreferrer"
                  className="underline transition-colors hover:text-foreground"
                >
                  releases page
                </a>{" "}
                for new versions.
              </>
            }
          />
        ) : (
          <>
            <SettingsRow
              title="Installed version"
              control={
                <span className="text-sm font-medium text-foreground">
                  {updateState.currentVersion}
                </span>
              }
            />
            <SettingsRow
              title="Latest seen version"
              control={
                <span className="text-sm font-medium text-foreground">
                  {updateState.release?.version ?? "None yet"}
                </span>
              }
            />
            <SettingsRow
              title="Last checked"
              description={`Started ${formatTimestamp(updateState.lastCheckStartedAt)} · finished ${formatTimestamp(updateState.lastCheckedAt)}`}
            />
          </>
        )}

        <SettingsRow title="Status" description={primaryMessage}>
          {updateState.phase === "downloading" && updateState.progress ? (
            <div className="max-w-md space-y-2">
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
        </SettingsRow>
      </SettingsSection>

      {updateState.release ? (
        <SettingsSection
          title="Release details"
          description="Metadata reported by the packaged update feed."
          action={
            updateState.release.releasePageUrl ? (
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => {
                  if (!updateState.release?.releasePageUrl) return;
                  window.open(updateState.release.releasePageUrl, "_blank", "noopener,noreferrer");
                }}
              >
                <DownloadIcon data-icon="inline-start" />
                Open release notes
              </Button>
            ) : null
          }
        >
          <SettingsRow
            title="Version"
            description={
              updateState.release.releaseName ? updateState.release.releaseName : undefined
            }
            control={
              <span className="text-sm font-medium text-foreground">
                {updateState.release.version}
              </span>
            }
          />
          <SettingsRow
            title="Release date"
            control={
              <span className="text-sm text-foreground">
                {formatTimestamp(updateState.release.releaseDate ?? null)}
              </span>
            }
          />
          {updateState.release.releaseNotes ? (
            <SettingsRow title="Release notes">
              <DesktopMarkdown className="max-w-none text-sm leading-6 text-muted-foreground [&_h1]:text-lg [&_h1]:font-semibold [&_h2]:text-base [&_h2]:font-semibold [&_p]:text-muted-foreground [&_ul]:text-muted-foreground">
                {updateState.release.releaseNotes}
              </DesktopMarkdown>
            </SettingsRow>
          ) : null}
        </SettingsSection>
      ) : null}
    </SettingsPage>
  );
}
