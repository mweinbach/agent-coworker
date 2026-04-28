import { QrCodeIcon, RefreshCwIcon, SmartphoneIcon, Trash2Icon, WifiIcon } from "lucide-react";
import { QRCodeSVG } from "qrcode.react";
import { useEffect, useMemo, useState } from "react";

import { useAppStore } from "../../../app/store";
import { Button } from "../../../components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "../../../components/ui/card";
import {
  forgetMobileRelayTrustedPhone,
  getMobileRelayState,
  onMobileRelayStateChanged,
  rotateMobileRelaySession,
  startMobileRelay,
  stopMobileRelay,
} from "../../../lib/desktopCommands";

export function describeRelayServiceStatus(
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

export function RemoteAccessPage() {
  const selectedWorkspace = useAppStore(
    (state) =>
      state.workspaces.find((workspace) => workspace.id === state.selectedWorkspaceId) ?? null,
  );
  const desktopFeatureFlags = useAppStore((state) => state.desktopFeatureFlags);
  const [state, setState] = useState<Awaited<ReturnType<typeof getMobileRelayState>> | null>(null);
  const [loading, setLoading] = useState(true);
  const [busyAction, setBusyAction] = useState<string | null>(null);

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

  const qrValue = useMemo(() => state?.ticketUrl ?? null, [state?.ticketUrl]);

  async function runAction(action: string, runner: () => Promise<unknown>) {
    setBusyAction(action);
    try {
      await runner();
    } finally {
      setBusyAction(null);
    }
  }

  return (
    <div className="space-y-5" data-remote-access-page="true">
      <Card className="border-border/80 bg-card/85">
        <CardHeader>
          <CardTitle>Workspace bridge</CardTitle>
          <CardDescription>
            Expose a single workspace while the desktop app remains running.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-start justify-between gap-4 max-[960px]:flex-col">
            <div className="space-y-1">
              <div className="text-sm font-medium text-foreground">
                {selectedWorkspace?.name ?? "No workspace selected"}
              </div>
              <div className="text-xs text-muted-foreground">
                {selectedWorkspace?.path ?? "Select a workspace before enabling remote access."}
              </div>
            </div>
            <div className="flex flex-wrap gap-2">
              <Button
                type="button"
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
        </CardContent>
      </Card>

      <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_20rem]">
        <Card className="border-border/80 bg-card/85">
          <CardHeader>
            <CardTitle>Pairing QR</CardTitle>
            <CardDescription>
              Scan this QR from Cowork Mobile to connect directly over HTTP/3. No relay is used.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {qrValue ? (
              <div className="flex flex-col items-center gap-4 rounded-lg border border-dashed border-border/60 bg-white p-6">
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

            <div className="flex flex-wrap gap-2">
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
          </CardContent>
        </Card>

        <Card className="border-border/80 bg-card/85">
          <CardHeader>
            <CardTitle>Trusted phone</CardTitle>
            <CardDescription>
              Cowork Desktop keeps direct pairing trust state in `~/.cowork/mobile-pairing`, outside
              the renderer.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {state?.trustedPhoneDeviceId ? (
              <div className="space-y-3 rounded-lg border border-border/60 bg-background/40 p-4">
                <div className="flex items-center gap-2 text-sm font-medium text-foreground">
                  <SmartphoneIcon className="size-4" />
                  Paired device
                </div>
                <div className="space-y-1 text-xs text-muted-foreground">
                  <div>Device ID: {state.trustedPhoneDeviceId}</div>
                  <div>Fingerprint: {state.trustedPhoneFingerprint ?? "—"}</div>
                </div>
                <Button
                  type="button"
                  variant="destructive"
                  onClick={() =>
                    runAction("forget", async () => {
                      await forgetMobileRelayTrustedPhone();
                    })
                  }
                  disabled={busyAction !== null}
                >
                  <Trash2Icon data-icon />
                  Forget paired device
                </Button>
              </div>
            ) : (
              <div className="rounded-lg border border-dashed border-border/60 bg-background/35 p-4 text-sm text-muted-foreground">
                No trusted device yet. Scan the QR to pair the first device.
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
