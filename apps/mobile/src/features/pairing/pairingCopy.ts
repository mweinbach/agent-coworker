import type { RelayConnectionStatus, RelayTransportMode } from "@/features/relay/relayTypes";

export function describeHero(
  status: RelayConnectionStatus,
  transportMode: RelayTransportMode,
  connectedDesktop: string | null,
  hasTrustedDesktop: boolean,
): { title: string; body: string } {
  if (transportMode === "fallback" && status === "connected") {
    return {
      title: "Demo mode active",
      body: "This build uses JavaScript fallback transport for testing. It's not a live desktop connection.",
    };
  }
  if (transportMode === "unsupported") {
    return {
      title: "Native transport unavailable",
      body: hasTrustedDesktop
        ? "This mobile build cannot open a direct desktop session yet. Re-scan a QR once the direct transport is available."
        : "This mobile build cannot open a direct desktop session yet. Scan a QR again once the direct transport is available.",
    };
  }
  switch (status) {
    case "connected":
      return {
        title: "Connected",
        body: `${connectedDesktop ?? "Your Mac"} is ready. Open threads or answer prompts from this phone.`,
      };
    case "pairing":
      return {
        title: "Pairing",
        body: "Keep Cowork Desktop open while your devices finish setting up the secure session.",
      };
    case "connecting":
      return {
        title: "Connecting",
        body: "Setting up a secure connection to your Mac.",
      };
    case "reconnecting":
      return {
        title: "Reconnecting",
        body: "Restoring your saved Mac session.",
      };
    case "error":
      return {
        title: "Connection issue",
        body: hasTrustedDesktop
          ? "Try reconnecting a saved Mac or scan a new QR code from Cowork Desktop."
          : "Scan the QR code from Cowork Desktop to start again.",
      };
    default:
      return {
        title: "Connect Your Mac",
        body: "Open Cowork on your Mac, show the pairing code under Remote Access, then scan it here.",
      };
  }
}

export function describeRelay(connectionState: {
  status: RelayConnectionStatus;
  transportMode: RelayTransportMode;
  relayUrl: string | null;
}): string {
  if (connectionState.transportMode === "fallback" && connectionState.status === "connected") {
    return connectionState.relayUrl
      ? `${connectionState.relayUrl} (fallback demo)`
      : "Fallback demo transport is active.";
  }
  if (connectionState.transportMode === "unsupported") {
    return "Direct desktop transport is not available in this build.";
  }
  if (connectionState.relayUrl) {
    return connectionState.relayUrl;
  }

  switch (connectionState.status) {
    case "pairing":
      return "Waiting for the QR payload to finish pairing.";
    case "connecting":
    case "reconnecting":
      return "Contacting the desktop endpoint.";
    case "connected":
      return "Desktop endpoint connected.";
    case "error":
      return "Direct connection setup failed.";
    default:
      return "No desktop selected yet.";
  }
}
