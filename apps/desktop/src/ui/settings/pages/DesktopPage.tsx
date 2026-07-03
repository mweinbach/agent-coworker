import { type KeyboardEvent as ReactKeyboardEvent, useEffect, useRef, useState } from "react";

import { useAppStore } from "../../../app/store";
import { Button } from "../../../components/ui/button";
import { Input } from "../../../components/ui/input";
import { Switch } from "../../../components/ui/switch";
import { isPackagedDesktopApp, showQuickChatWindow } from "../../../lib/desktopCommands";
import {
  captureQuickChatShortcut,
  DEFAULT_QUICK_CHAT_SHORTCUT_ACCELERATOR,
  formatQuickChatShortcutLabel,
} from "../../../lib/quickChatShortcut";
import { SettingsPage, SettingsRow, SettingsSection } from "../SettingsPrimitives";

export function DesktopPage() {
  const quickChatIconEnabled = useAppStore((s) => s.desktopSettings.quickChat.iconEnabled);
  const quickChatShortcutEnabled = useAppStore((s) => s.desktopSettings.quickChat.shortcutEnabled);
  const quickChatShortcutAccelerator = useAppStore(
    (s) => s.desktopSettings.quickChat.shortcutAccelerator,
  );
  const menuBarAvailable = useAppStore((s) => s.desktopFeatureFlags.menuBar);
  const packaged = useAppStore((s) => s.updateState.packaged);
  const setQuickChatIconEnabled = useAppStore((s) => s.setQuickChatIconEnabled);
  const setQuickChatShortcutEnabled = useAppStore((s) => s.setQuickChatShortcutEnabled);
  const setQuickChatShortcutAccelerator = useAppStore((s) => s.setQuickChatShortcutAccelerator);
  const shortcutCaptureButtonRef = useRef<HTMLButtonElement | null>(null);
  const [recordingShortcut, setRecordingShortcut] = useState(false);
  const [shortcutError, setShortcutError] = useState<string | null>(null);
  const productionBuild = packaged || isPackagedDesktopApp();

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

    if (
      !event.metaKey &&
      !event.ctrlKey &&
      !event.altKey &&
      !event.shiftKey &&
      event.key === "Escape"
    ) {
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
    <SettingsPage>
      <SettingsSection
        title="Quick chat"
        description="Open the lighter-weight floating chat surface without bringing the full app window forward."
        action={
          <Button type="button" variant="outline" size="sm" onClick={() => void showQuickChatWindow()}>
            Open quick chat
          </Button>
        }
      >
        <SettingsRow
          title="Show quick chat icon"
          description="Keep the compact popup available from the macOS menu bar or Windows system tray."
          meta={
            !menuBarAvailable ? (
              <span className="text-warning">
                {productionBuild
                  ? "Quick chat icon support is unavailable in this build."
                  : "Enable the Menu bar / tray feature flag to show the icon."}
              </span>
            ) : null
          }
          control={
            <Switch
              checked={quickChatIconEnabled}
              disabled={!menuBarAvailable}
              aria-label="Show quick chat icon"
              onCheckedChange={(checked) => setQuickChatIconEnabled(checked)}
            />
          }
        />

        {menuBarAvailable ? (
          <SettingsRow
            title="Enable global shortcut"
            description={
              <>
                Shortcut: <code>{formatQuickChatShortcutLabel(quickChatShortcutAccelerator)}</code>
              </>
            }
            control={
              <Switch
                checked={quickChatShortcutEnabled}
                aria-label="Enable quick chat shortcut"
                onCheckedChange={(checked) => setQuickChatShortcutEnabled(checked)}
              />
            }
          />
        ) : null}

        {menuBarAvailable ? (
          <SettingsRow
            title="Change shortcut"
            description={
              <>
                Press the modifier keys and final key together. Press <code>Escape</code> to cancel
                recording.
              </>
            }
          >
            <div className="max-w-md space-y-3">
              <Input
                aria-label="Quick chat shortcut"
                readOnly
                value={
                  recordingShortcut
                    ? "Press the new shortcut..."
                    : formatQuickChatShortcutLabel(quickChatShortcutAccelerator)
                }
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
                  {recordingShortcut ? "Recording shortcut..." : "Record shortcut"}
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  disabled={
                    quickChatShortcutAccelerator === DEFAULT_QUICK_CHAT_SHORTCUT_ACCELERATOR
                  }
                  onClick={() => {
                    setQuickChatShortcutAccelerator(DEFAULT_QUICK_CHAT_SHORTCUT_ACCELERATOR);
                    setShortcutError(null);
                    stopRecordingShortcut();
                  }}
                >
                  Use default
                </Button>
              </div>

              <div
                className={
                  shortcutError ? "text-xs text-destructive" : "text-xs text-muted-foreground"
                }
              >
                {shortcutError ??
                  "If macOS or Windows already uses the combination, Cowork may not receive it."}
              </div>
            </div>
          </SettingsRow>
        ) : null}
      </SettingsSection>
    </SettingsPage>
  );
}
