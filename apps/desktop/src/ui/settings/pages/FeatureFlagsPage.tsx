import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";

import { useAppStore } from "../../../app/store";
import { Button } from "../../../components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../../../components/ui/card";
import { Input } from "../../../components/ui/input";
import { Switch } from "../../../components/ui/switch";
import {
  FEATURE_FLAG_DEFINITIONS,
  FEATURE_FLAG_IDS,
  type FeatureFlagId,
} from "../../../../../../src/shared/featureFlags";
import {
  captureQuickChatShortcut,
  DEFAULT_QUICK_CHAT_SHORTCUT_ACCELERATOR,
  formatQuickChatShortcutLabel,
} from "../../../lib/quickChatShortcut";

export function FeatureFlagsPage() {
  const updateState = useAppStore((s) => s.updateState);
  const desktopFeatureFlags = useAppStore((s) => s.desktopFeatureFlags);
  const setDesktopFeatureFlagOverride = useAppStore((s) => s.setDesktopFeatureFlagOverride);
  const quickChatShortcutEnabled = useAppStore((s) => s.desktopSettings.quickChat.shortcutEnabled);
  const quickChatShortcutAccelerator = useAppStore((s) => s.desktopSettings.quickChat.shortcutAccelerator);
  const setQuickChatShortcutEnabled = useAppStore((s) => s.setQuickChatShortcutEnabled);
  const setQuickChatShortcutAccelerator = useAppStore((s) => s.setQuickChatShortcutAccelerator);
  const shortcutCaptureButtonRef = useRef<HTMLButtonElement | null>(null);
  const [recordingShortcut, setRecordingShortcut] = useState(false);
  const [shortcutError, setShortcutError] = useState<string | null>(null);

  const toggleDesktopFlag = (flagId: FeatureFlagId, enabled: boolean) => {
    void setDesktopFeatureFlagOverride(flagId, enabled);
  };

  useEffect(() => {
    if (!recordingShortcut) {
      return;
    }
    shortcutCaptureButtonRef.current?.focus();
  }, [recordingShortcut]);

  function stopRecordingShortcut() {
    setRecordingShortcut(false);
  }

  function handleShortcutCaptureKeyDown(event: ReactKeyboardEvent<HTMLButtonElement>) {
    if (!recordingShortcut) {
      return;
    }

    if (!event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey && event.key === "Escape") {
      event.preventDefault();
      setShortcutError(null);
      stopRecordingShortcut();
      return;
    }

    event.preventDefault();
    const result = captureQuickChatShortcut({
      key: event.key,
      code: event.code,
      metaKey: event.metaKey,
      ctrlKey: event.ctrlKey,
      altKey: event.altKey,
      shiftKey: event.shiftKey,
    });

    if (result.status === "pending") {
      setShortcutError(null);
      return;
    }

    if (result.status === "invalid") {
      setShortcutError(result.message);
      return;
    }

    setQuickChatShortcutAccelerator(result.accelerator);
    setShortcutError(null);
    stopRecordingShortcut();
  }

  return (
    <div className="space-y-5">
      <Card className="border-border/80 bg-card/85">
        <CardHeader>
          <CardTitle>Feature flags</CardTitle>
          <CardDescription>
            These flags are global across all workspaces. Some toggles require a restart to fully apply.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {FEATURE_FLAG_IDS.map((flagId) => {
            const definition = FEATURE_FLAG_DEFINITIONS[flagId];
            const forcedOffInPackaged = definition.packagedAvailability === "forced-off" && updateState.packaged;
            const enabled = desktopFeatureFlags[flagId] === true;
            return (
              <div key={flagId} className="flex items-start justify-between gap-4 max-[960px]:flex-col">
                <div>
                  <div className="text-sm font-medium">{definition.label}</div>
                  <div className="text-xs text-muted-foreground">{definition.description}</div>
                  {forcedOffInPackaged ? (
                    <div className="mt-1 text-xs text-warning">
                      Unavailable in packaged builds.
                    </div>
                  ) : null}
                  {definition.restartRequired ? (
                    <div className="mt-1 text-xs text-muted-foreground">Restart the app after changing this flag.</div>
                  ) : null}
                </div>
                <Switch
                  checked={enabled}
                  disabled={forcedOffInPackaged}
                  aria-label={definition.label}
                  onCheckedChange={(checked) => toggleDesktopFlag(flagId, checked)}
                />
              </div>
            );
          })}
        </CardContent>
      </Card>

      <Card className="border-border/80 bg-card/85">
        <CardHeader>
          <CardTitle>Quick chat shortcut</CardTitle>
          <CardDescription>
            Register a global shortcut so the popup can be summoned without using the menu bar or tray.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-start justify-between gap-4 max-[960px]:flex-col">
            <div>
              <div className="text-sm font-medium">Enable global shortcut</div>
              <div className="text-xs text-muted-foreground">
                Shortcut: <code>{formatQuickChatShortcutLabel(quickChatShortcutAccelerator)}</code>
              </div>
            </div>
            <Switch
              checked={quickChatShortcutEnabled}
              aria-label="Enable quick chat shortcut"
              onCheckedChange={(checked) => setQuickChatShortcutEnabled(checked)}
            />
          </div>

          <div className="space-y-3 rounded-xl border border-border/70 bg-muted/10 p-4">
            <div className="space-y-1">
              <div className="text-sm font-medium text-foreground">Change shortcut</div>
              <div className="text-xs text-muted-foreground">
                Press the modifier keys and final key together. Press <code>Escape</code> to cancel recording.
              </div>
            </div>

            <Input
              aria-label="Quick chat shortcut"
              readOnly
              value={recordingShortcut ? "Press the new shortcut…" : formatQuickChatShortcutLabel(quickChatShortcutAccelerator)}
              className="font-mono"
            />

            <div className="flex flex-wrap gap-2">
              <Button
                ref={shortcutCaptureButtonRef}
                type="button"
                variant={recordingShortcut ? "default" : "outline"}
                onClick={() => {
                  setShortcutError(null);
                  setRecordingShortcut((recording) => !recording);
                }}
                onKeyDown={handleShortcutCaptureKeyDown}
                onBlur={() => {
                  if (recordingShortcut) {
                    stopRecordingShortcut();
                  }
                }}
              >
                {recordingShortcut ? "Recording shortcut…" : "Record shortcut"}
              </Button>
              <Button
                type="button"
                variant="outline"
                disabled={quickChatShortcutAccelerator === DEFAULT_QUICK_CHAT_SHORTCUT_ACCELERATOR}
                onClick={() => {
                  setQuickChatShortcutAccelerator(DEFAULT_QUICK_CHAT_SHORTCUT_ACCELERATOR);
                  setShortcutError(null);
                  stopRecordingShortcut();
                }}
              >
                Use default
              </Button>
            </div>

            <div className={shortcutError ? "text-xs text-destructive" : "text-xs text-muted-foreground"}>
              {shortcutError ?? "If macOS or Windows already uses the combination, Cowork may not receive it."}
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
