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
import { operationKey } from "../../../app/store.helpers/operations";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "../../../components/ui/alert-dialog";
import { Badge } from "../../../components/ui/badge";
import { Button } from "../../../components/ui/button";
import { Separator } from "../../../components/ui/separator";
import { Switch } from "../../../components/ui/switch";
import type {
  MobileRelayTrustedDevicePermissionKey,
  MobileRelayTrustedPhoneDevice,
} from "../../../lib/desktopApi";
import {
  copyText,
  getMobileRelayState,
  onMobileRelayStateChanged,
  refreshMobileRelayTrustedPhones,
  rotateMobileRelaySession,
  startMobileRelay,
  stopMobileRelay,
} from "../../../lib/desktopCommands";
import { OperationFeedback } from "../../OperationFeedback";
import { useOptionalSettingsChrome } from "../SettingsChromeContext";
import { SettingsEmptyState, SettingsSection } from "../SettingsPrimitives";

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
  const operationsByKey = useAppStore((state) => state.operationsByKey);
  const forgetRemoteAccessTrustedPhones = useAppStore(
    (state) => state.forgetRemoteAccessTrustedPhones,
  );
  const updateRemoteAccessTrustedPhonePermissions = useAppStore(
    (state) => state.updateRemoteAccessTrustedPhonePermissions,
  );
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
  const relayMatchesSelectedWorkspace =
    selectedWorkspace !== null && state?.workspaceId === selectedWorkspace.id;
  const trustedDevices = relayMatchesSelectedWorkspace ? (state?.trustedPhoneDevices ?? []) : [];
  const forgetDeviceOperation = selectedWorkspace
    ? operationsByKey[operationKey("remote-access", "forget", selectedWorkspace.id, "device")]
    : undefined;
  const forgetAllOperation = selectedWorkspace
    ? operationsByKey[operationKey("remote-access", "forget", selectedWorkspace.id, "all")]
    : undefined;
  const permissionsOperation = selectedWorkspace
    ? operationsByKey[operationKey("remote-access", "permissions", selectedWorkspace.id)]
    : undefined;
  const trustedDeviceMutationPending =
    forgetDeviceOperation?.status === "pending" ||
    forgetAllOperation?.status === "pending" ||
    permissionsOperation?.status === "pending";

  async function forgetTrustedDevice(device: MobileRelayTrustedPhoneDevice) {
    if (!selectedWorkspace || !relayMatchesSelectedWorkspace) {
      return;
    }
    const result = await forgetRemoteAccessTrustedPhones({
      workspaceId: selectedWorkspace.id,
      scope: "device",
      deviceId: device.deviceId,
    });
    if (result.ok) {
      setState(result.value);
    }
  }

  async function forgetAllTrustedDevices() {
    if (!selectedWorkspace || !relayMatchesSelectedWorkspace || trustedDevices.length === 0) {
      return;
    }
    const result = await forgetRemoteAccessTrustedPhones({
      workspaceId: selectedWorkspace.id,
      scope: "all",
      expectedDeviceIds: trustedDevices.map((device) => device.deviceId),
    });
    if (result.ok) {
      setState(result.value);
    }
  }

  async function updateTrustedDevicePermission(
    deviceId: string,
    permission: MobileRelayTrustedDevicePermissionKey,
    enabled: boolean,
  ) {
    if (!selectedWorkspace || !relayMatchesSelectedWorkspace) {
      return;
    }
    const result = await updateRemoteAccessTrustedPhonePermissions({
      workspaceId: selectedWorkspace.id,
      deviceId,
      permissions: { [permission]: enabled },
    });
    if (result.ok) {
      setState(result.value);
    }
  }

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

  return (
    <div className="space-y-5" data-remote-access-page="true">
      <SettingsSection
        title="Workspace bridge"
        description="Expose a single workspace while the desktop app remains running."
      >
        <div className="space-y-1 px-4 py-3.5">
          <div className="text-sm font-medium text-foreground">
            {selectedWorkspace?.name ?? "No workspace selected"}
          </div>
          <div className="text-xs text-muted-foreground">
            {selectedWorkspace?.path ?? "Select a workspace before enabling remote access."}
          </div>
        </div>

        <div className="px-4 py-3.5 text-sm">
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
      </SettingsSection>

      <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_20rem]">
        <SettingsSection
          title="Pairing QR"
          description="Scan this QR from Cowork Mobile to connect directly over HTTP/3, or copy the pairing key below to paste on your phone. No relay is used."
        >
          <div className="space-y-4 px-4 py-4">
            {qrValue ? (
              <div className="flex flex-col items-center gap-4 p-6">
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
              <div className="flex min-h-64 flex-col items-center justify-center gap-3 text-center text-sm text-muted-foreground">
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
          description="Trust is scoped to the workspace named in each confirmation. Revoked phones lose remote access immediately and must scan a new QR code to reconnect."
        >
          {state?.workspaceId && !relayMatchesSelectedWorkspace ? (
            <div role="status" className="px-4 py-3.5 text-sm text-muted-foreground">
              The running bridge belongs to another workspace. Select that workspace or restart the
              bridge here before changing trusted devices.
            </div>
          ) : trustedDevices.length > 0 ? (
            <>
              {trustedDevices.map((device, index) => (
                <div key={device.deviceId} className="space-y-3 px-4 py-3.5">
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
                    <AlertDialog>
                      <AlertDialogTrigger asChild>
                        <Button
                          type="button"
                          size="icon"
                          variant="ghost"
                          aria-label={`Forget ${describeTrustedDevice(device)}`}
                          disabled={busyAction !== null || trustedDeviceMutationPending}
                        >
                          <Trash2Icon data-icon />
                        </Button>
                      </AlertDialogTrigger>
                      <AlertDialogContent size="sm">
                        <AlertDialogHeader>
                          <AlertDialogTitle>
                            Forget {describeTrustedDevice(device)}?
                          </AlertDialogTitle>
                          <AlertDialogDescription>
                            This revokes this phone&apos;s access to{" "}
                            <strong>{selectedWorkspace?.name}</strong>. It will need to scan a new
                            QR code before it can reconnect. Other trusted devices are unchanged.
                          </AlertDialogDescription>
                        </AlertDialogHeader>
                        <AlertDialogFooter>
                          <AlertDialogCancel>Keep device</AlertDialogCancel>
                          <AlertDialogAction
                            variant="destructive"
                            onClick={() => {
                              void forgetTrustedDevice(device);
                            }}
                          >
                            Forget device
                          </AlertDialogAction>
                        </AlertDialogFooter>
                      </AlertDialogContent>
                    </AlertDialog>
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
                              disabled={busyAction !== null || trustedDeviceMutationPending}
                              aria-labelledby={permissionLabelId}
                              onCheckedChange={(checked) => {
                                void updateTrustedDevicePermission(
                                  device.deviceId,
                                  permission.key,
                                  checked === true,
                                );
                              }}
                            />
                          </div>
                        );
                      })}
                    </div>
                  </div>
                </div>
              ))}
              <div className="space-y-2 px-4 py-3.5">
                <AlertDialog>
                  <AlertDialogTrigger asChild>
                    <Button
                      type="button"
                      variant="outline"
                      disabled={busyAction !== null || trustedDeviceMutationPending}
                    >
                      <Trash2Icon data-icon="inline-start" />
                      Forget all devices
                    </Button>
                  </AlertDialogTrigger>
                  <AlertDialogContent size="sm">
                    <AlertDialogHeader>
                      <AlertDialogTitle>
                        Forget all {trustedDevices.length} trusted{" "}
                        {trustedDevices.length === 1 ? "device" : "devices"}?
                      </AlertDialogTitle>
                      <AlertDialogDescription>
                        This revokes remote access to <strong>{selectedWorkspace?.name}</strong> for{" "}
                        {trustedDevices.length} {trustedDevices.length === 1 ? "phone" : "phones"}.
                        Every phone must scan a new QR code to reconnect.
                      </AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                      <AlertDialogCancel>Keep devices</AlertDialogCancel>
                      <AlertDialogAction
                        variant="destructive"
                        onClick={() => {
                          void forgetAllTrustedDevices();
                        }}
                      >
                        Forget all {trustedDevices.length}
                      </AlertDialogAction>
                    </AlertDialogFooter>
                  </AlertDialogContent>
                </AlertDialog>
                <OperationFeedback operation={forgetDeviceOperation} />
                <OperationFeedback operation={forgetAllOperation} />
                <OperationFeedback operation={permissionsOperation} />
              </div>
            </>
          ) : (
            <SettingsEmptyState
              title="No trusted device yet"
              description="Scan the QR to pair the first device."
            />
          )}
        </SettingsSection>
      </div>
    </div>
  );
}
