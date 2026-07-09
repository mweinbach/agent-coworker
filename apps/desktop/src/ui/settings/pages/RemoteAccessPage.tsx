import {
  CheckIcon,
  CopyIcon,
  KeyRoundIcon,
  QrCodeIcon,
  RefreshCwIcon,
  SmartphoneIcon,
  Trash2Icon,
  WifiIcon,
} from "lucide-react";
import { QRCodeSVG } from "qrcode.react";
import { useCallback, useEffect, useMemo, useState } from "react";

import { useAppStore } from "../../../app/store";
import { Badge } from "../../../components/ui/badge";
import { Button } from "../../../components/ui/button";
import { Separator } from "../../../components/ui/separator";
import { Switch } from "../../../components/ui/switch";
import type {
  MobileRelayTrustedDevicePermissionKey,
  MobileRelayTrustedPhoneDevice,
} from "../../../lib/desktopApi";
import {
  confirmAction,
  copyText,
  forgetMobileRelayTrustedPhone,
  getMobileRelayState,
  onMobileRelayStateChanged,
  refreshMobileRelayTrustedPhones,
  rotateMobileRelaySession,
  startMobileRelay,
  stopMobileRelay,
  updateMobileRelayTrustedPhonePermissions,
} from "../../../lib/desktopCommands";
import { useOptionalSettingsChrome } from "../SettingsChromeContext";
import { SettingsSection } from "../SettingsPrimitives";

const TRUSTED_DEVICE_PERMISSION_CONTROLS: Array<{
  key: MobileRelayTrustedDevicePermissionKey;
  label: string;
}> = [
  { key: "conversations", label: "Conversations" },
  { key: "turns", label: "Turns" },
  { key: "serverRequests", label: "Approvals" },
  { key: "providerAuth", label: "Provider auth" },
  { key: "mcpAuth", label: "MCP auth" },
  { key: "workspaceSettings", label: "Workspace settings" },
  { key: "backups", label: "Backups" },
];

function describeRelayServiceStatus(
  status: Awaited<ReturnType<typeof getMobileRelayState>>["relayServiceStatus"],
): string {
  switch (status) {
    case "running":
      return "running";
    case "not-running":
      return "not running";
    case "unavailable":
      return "unavailable";
    default:
      return "unknown";
  }
}

export function describeRelaySource(
  source: Awaited<ReturnType<typeof getMobileRelayState>>["relaySource"],
): string {
  switch (source) {
    case "remodex":
      return "Remodex";
    case "managed":
      return "Cowork-managed";
    case "direct":
      return "Direct";
    case "override":
      return "Custom override";
    default:
      return "Unavailable";
  }
}

function describeTrustedDevice(device: MobileRelayTrustedPhoneDevice): string {
  return device.displayName?.trim() || device.deviceId;
}

function formatDeviceTimestamp(value: string | null): string {
  if (!value) return "—";
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return value;
  return new Date(timestamp).toLocaleString();
}

export function RemoteAccessPage() {
  const selectedWorkspace = useAppStore(
    (state) =>
      state.workspaces.find((workspace) => workspace.id === state.selectedWorkspaceId) ?? null,
  );
  const desktopFeatureFlags = useAppStore((state) => state.desktopFeatureFlags);
  const [state, setState] = useState<Awaited<ReturnType<typeof getMobileRelayState>> | null>(null);
  const [loading, setLoading] = useState(true);
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [copiedPairingKey, setCopiedPairingKey] = useState(false);

  const settingsChrome = useOptionalSettingsChrome();

  const runAction = useCallback(async (action: string, runner: () => Promise<unknown>) => {
    setBusyAction(action);
    try {
      await runner();
    } finally {
      setBusyAction(null);
    }
  }, []);

  useEffect(() => {
    let mounted = true;
    void getMobileRelayState()
      .then((snapshot) => {
        if (mounted) {
          setState(snapshot);
          setLoading(false);
        }
      })
      .catch(() => {
        if (mounted) {
          setLoading(false);
        }
      });

    const unsubscribe = onMobileRelayStateChanged((snapshot) => {
      if (!mounted) return;
      setState(snapshot);
      setLoading(false);
    });

    return () => {
      mounted = false;
      unsubscribe();
    };
  }, []);

  useEffect(() => {
    if (state?.relayServiceStatus !== "running" || !state.workspaceId) {
      return;
    }

    let cancelled = false;
    const refresh = async () => {
      try {
        const snapshot = await refreshMobileRelayTrustedPhones();
        if (!cancelled) {
          setState(snapshot);
        }
      } catch {
        // The state-change subscription and user actions remain authoritative if a poll races reload.
      }
    };

    void refresh();
    const intervalId = window.setInterval(() => {
      void refresh();
    }, 2_500);

    return () => {
      cancelled = true;
      window.clearInterval(intervalId);
    };
  }, [state?.relayServiceStatus, state?.workspaceId]);

  useEffect(() => {
    if (!settingsChrome) return;
    settingsChrome.setChrome({
      headerActions: (
        <div className="flex flex-wrap items-center justify-end gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() =>
              selectedWorkspace &&
              runAction("start", async () => {
                await startMobileRelay({
                  workspaceId: selectedWorkspace.id,
                  workspacePath: selectedWorkspace.path,
                  yolo: selectedWorkspace.yolo,
                  featureFlags: desktopFeatureFlags,
                });
              })
            }
            disabled={!selectedWorkspace || busyAction !== null}
          >
            <WifiIcon data-icon />
            {state?.status === "idle" ? "Enable remote access" : "Restart bridge"}
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() =>
              runAction("stop", async () => {
                await stopMobileRelay();
              })
            }
            disabled={!state || state.status === "idle" || busyAction !== null}
          >
            Stop
          </Button>
        </div>
      ),
    });
    return () => {
      settingsChrome.setChrome(null);
    };
  }, [settingsChrome, selectedWorkspace, state, busyAction, desktopFeatureFlags, runAction]);

  const qrValue = useMemo(() => state?.ticketUrl ?? null, [state?.ticketUrl]);
  const trustedDevices = state?.trustedPhoneDevices ?? [];

  async function copyPairingKey() {
    if (!qrValue) {
      return;
    }
    await copyText(qrValue);
    setCopiedPairingKey(true);
    window.setTimeout(() => {
      setCopiedPairingKey(false);
    }, 2000);
  }

  async function forgetTrustedDevice(device: MobileRelayTrustedPhoneDevice): Promise<void> {
    const deviceName = describeTrustedDevice(device);
    const confirmed = await confirmAction({
      title: `Forget ${deviceName}?`,
      message: "This device will lose access to Cowork until it is paired again.",
      detail: `Remove trust for ${device.fingerprint}.`,
      confirmLabel: "Forget device",
      cancelLabel: "Keep device",
      kind: "warning",
      defaultAction: "cancel",
    });
    if (!confirmed) {
      return;
    }
    await forgetMobileRelayTrustedPhone({ deviceId: device.deviceId });
  }

  async function forgetAllTrustedDevices(): Promise<void> {
    const confirmed = await confirmAction({
      title: "Forget all trusted devices?",
      message: "Every paired device will lose access to Cowork until it is paired again.",
      detail: "This does not stop the workspace bridge.",
      confirmLabel: "Forget all devices",
      cancelLabel: "Keep devices",
      kind: "warning",
      defaultAction: "cancel",
    });
    if (!confirmed) {
      return;
    }
    await forgetMobileRelayTrustedPhone();
  }

  return (
    <div className="space-y-5" data-remote-access-page="true">
      <SettingsSection
        title="Workspace bridge"
        description="Expose a single workspace while the desktop app remains running."
      >
        <div className="space-y-4 px-4 py-4">
          <div className="space-y-1">
            <div className="text-sm font-medium text-foreground">
              {selectedWorkspace?.name ?? "No workspace selected"}
            </div>
            <div className="text-xs text-muted-foreground">
              {selectedWorkspace?.path ?? "Select a workspace before enabling remote access."}
            </div>
          </div>

          <div className="rounded-lg border border-border/60 bg-background/40 px-3 py-2 text-sm">
            <div className="font-medium text-foreground">Status</div>
            <div className="mt-1 text-muted-foreground">
              {loading ? "Loading…" : (state?.status ?? "idle")}
            </div>
            <div className="mt-2 text-xs text-muted-foreground">
              Transport: {describeRelaySource(state?.relaySource ?? "direct")} HTTP/3
            </div>
            <div className="mt-1 text-xs text-muted-foreground">
              Relay service: {describeRelayServiceStatus(state?.relayServiceStatus ?? "unknown")}
            </div>
            {state?.directUrl ? (
              <div className="mt-1 text-xs text-muted-foreground">Endpoint: {state.directUrl}</div>
            ) : null}
            {state?.hostHints?.length ? (
              <div className="mt-1 text-xs text-muted-foreground">
                Reachable hosts: {state.hostHints.join(", ")}
              </div>
            ) : null}
            {state?.relayServiceUpdatedAt ? (
              <div className="mt-1 text-xs text-muted-foreground">
                Service heartbeat: {state.relayServiceUpdatedAt}
              </div>
            ) : null}
            {state?.relaySourceMessage ? (
              <div className="mt-2 text-xs text-muted-foreground">{state.relaySourceMessage}</div>
            ) : null}
            {state?.relayServiceMessage ? (
              <div className="mt-1 text-xs text-muted-foreground">{state.relayServiceMessage}</div>
            ) : null}
            {state?.lastError ? (
              <div className="mt-2 text-xs text-destructive">{state.lastError}</div>
            ) : null}
          </div>
        </div>
      </SettingsSection>

      <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_20rem]">
        <SettingsSection
          title="Pairing QR"
          description="Scan this QR from Cowork Mobile to connect directly over HTTP/3, or copy the pairing key below to paste on your phone. No relay is used."
        >
          <div className="space-y-4 px-4 py-4">
            {qrValue ? (
              <div className="flex flex-col items-center gap-4 rounded-lg border border-dashed border-border/60 bg-background/50 p-6">
                <QRCodeSVG value={qrValue} size={220} includeMargin />
                <div className="space-y-1 text-center text-xs text-muted-foreground">
                  <div>Certificate: {state?.certSha256?.slice(0, 16) ?? "—"}…</div>
                  <div>
                    Expires:{" "}
                    {state?.pairingPayload?.expiresAt
                      ? new Date(state.pairingPayload.expiresAt).toISOString()
                      : "—"}
                  </div>
                </div>
              </div>
            ) : (
              <div className="flex min-h-64 flex-col items-center justify-center gap-3 rounded-lg border border-dashed border-border/60 bg-background/35 text-center text-sm text-muted-foreground">
                <QrCodeIcon className="size-8" />
                <div>Enable remote access to generate a pairing QR.</div>
              </div>
            )}

            <div className="space-y-2">
              <div className="flex flex-wrap gap-2">
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => {
                    void copyPairingKey();
                  }}
                  disabled={!qrValue || busyAction !== null}
                >
                  <CopyIcon data-icon />
                  Copy pairing key
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  onClick={() =>
                    runAction("rotate", async () => {
                      await rotateMobileRelaySession();
                    })
                  }
                  disabled={!state?.pairingPayload || busyAction !== null}
                >
                  <RefreshCwIcon data-icon />
                  Rotate QR / certificate
                </Button>
              </div>
              {copiedPairingKey ? (
                <p className="flex items-center gap-1.5 text-xs text-primary">
                  <CheckIcon className="size-3.5 shrink-0" aria-hidden="true" />
                  Pairing key copied to clipboard.
                </p>
              ) : null}
            </div>
          </div>
        </SettingsSection>

        <SettingsSection
          title="Trusted devices"
          description="Cowork Desktop keeps direct pairing trust state in `~/.cowork/mobile-pairing`, outside the renderer."
        >
          <div className="space-y-4 px-4 py-4">
            {trustedDevices.length > 0 ? (
              <div className="space-y-3">
                {trustedDevices.map((device, index) => (
                  <div
                    key={device.deviceId}
                    className="space-y-3 rounded-lg border border-border/60 bg-background/40 p-3"
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0 space-y-1">
                        <div className="flex flex-wrap items-center gap-2 text-sm font-medium text-foreground">
                          <SmartphoneIcon className="size-4 shrink-0" />
                          <span className="truncate">{describeTrustedDevice(device)}</span>
                          {index === 0 ? (
                            <Badge variant="outline" className="rounded-sm">
                              Current
                            </Badge>
                          ) : null}
                        </div>
                        <div className="space-y-0.5 text-xs text-muted-foreground">
                          <div className="break-all">Device ID: {device.deviceId}</div>
                          <div className="break-all">Fingerprint: {device.fingerprint}</div>
                          <div>Last paired: {formatDeviceTimestamp(device.lastPairedAt)}</div>
                          <div>Last seen: {formatDeviceTimestamp(device.lastConnectedAt)}</div>
                        </div>
                      </div>
                      <Button
                        type="button"
                        size="icon"
                        variant="ghost"
                        aria-label={`Forget ${describeTrustedDevice(device)}`}
                        onClick={() =>
                          runAction(`forget:${device.deviceId}`, async () => {
                            await forgetTrustedDevice(device);
                          })
                        }
                        disabled={busyAction !== null}
                      >
                        <Trash2Icon data-icon />
                      </Button>
                    </div>

                    <Separator />

                    <div className="space-y-2">
                      <div className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
                        <KeyRoundIcon className="size-3.5" />
                        Permissions
                      </div>
                      <div className="grid gap-2">
                        {TRUSTED_DEVICE_PERMISSION_CONTROLS.map((permission) => {
                          const permissionLabelId = `mobile-permission-${device.deviceId}-${permission.key}`;
                          return (
                            <div
                              key={permission.key}
                              className="flex items-center justify-between gap-3 text-xs"
                            >
                              <span id={permissionLabelId} className="text-muted-foreground">
                                {permission.label}
                              </span>
                              <Switch
                                size="sm"
                                checked={device.permissions[permission.key]}
                                disabled={busyAction !== null}
                                aria-labelledby={permissionLabelId}
                                onCheckedChange={(checked) =>
                                  runAction(
                                    `permission:${device.deviceId}:${permission.key}`,
                                    async () => {
                                      await updateMobileRelayTrustedPhonePermissions({
                                        deviceId: device.deviceId,
                                        permissions: { [permission.key]: checked === true },
                                      });
                                    },
                                  )
                                }
                              />
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  </div>
                ))}
                <Button
                  type="button"
                  variant="outline"
                  onClick={() =>
                    runAction("forget-all", async () => {
                      await forgetAllTrustedDevices();
                    })
                  }
                  disabled={busyAction !== null}
                >
                  <Trash2Icon data-icon />
                  Forget all devices
                </Button>
              </div>
            ) : (
              <div className="rounded-lg border border-dashed border-border/60 bg-background/35 p-4 text-sm text-muted-foreground">
                No trusted device yet. Scan the QR to pair the first device.
              </div>
            )}
          </div>
        </SettingsSection>
      </div>
    </div>
  );
}
