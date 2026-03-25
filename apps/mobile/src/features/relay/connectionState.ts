import type { RelayConnectionStatus, RelayTransportMode, SecureTransportSnapshot } from "./relayTypes";

export function isWorkspaceConnectionReady(
  state: Pick<SecureTransportSnapshot, "status" | "transportMode">,
): boolean {
  return state.status === "connected" && state.transportMode === "native";
}

export function describeTransportMode(mode: RelayTransportMode): string {
  switch (mode) {
    case "fallback":
      return "Fallback demo";
    case "unsupported":
      return "Unsupported";
    case "native":
    default:
      return "Secure relay";
  }
}

export function describeTransportStatus(
  state: Pick<SecureTransportSnapshot, "status" | "transportMode">,
): string {
  if (state.transportMode === "fallback" && state.status === "connected") {
    return "Fallback demo";
  }
  if (state.transportMode === "unsupported") {
    return state.status === "error" ? "Unsupported" : "Unavailable";
  }

  switch (state.status) {
    case "pairing":
      return "Pairing";
    case "connecting":
      return "Connecting";
    case "reconnecting":
      return "Reconnecting";
    case "connected":
      return "Connected";
    case "error":
      return "Needs attention";
    case "idle":
    default:
      return "Ready";
  }
}

export function toneForTransportState(
  state: Pick<SecureTransportSnapshot, "status" | "transportMode">,
): "neutral" | "success" | "warning" | "danger" {
  if (isWorkspaceConnectionReady(state)) {
    return "success";
  }
  if (state.transportMode === "unsupported" || state.status === "error") {
    return "danger";
  }
  if (state.transportMode === "fallback" || state.status === "connecting" || state.status === "reconnecting" || state.status === "pairing") {
    return "warning";
  }
  return "neutral";
}

export function isLiveTransportStatus(status: RelayConnectionStatus, transportMode: RelayTransportMode): boolean {
  return status === "connected" && transportMode === "native";
}
