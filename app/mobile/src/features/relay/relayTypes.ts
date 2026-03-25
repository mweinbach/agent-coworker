export type RelayConnectionStatus =
  | "idle"
  | "pairing"
  | "connecting"
  | "connected"
  | "reconnecting"
  | "error";

export type RelayTrustedDesktop = {
  macDeviceId: string;
  relayUrl: string;
  displayName: string;
  publicKey: string;
  fingerprint: string;
  lastConnectedAt: string | null;
};

export type SecureTransportSnapshot = {
  status: RelayConnectionStatus;
  connectedMacDeviceId: string | null;
  relayUrl: string | null;
  sessionId: string | null;
  trustedDesktops: RelayTrustedDesktop[];
  lastError: string | null;
};

export type SecureTransportClientEvents = {
  onStateChanged?: (state: SecureTransportSnapshot) => void;
  onPlaintextMessage?: (text: string) => void;
  onSecureError?: (message: string) => void;
  onSocketClosed?: (reason: string | null) => void;
};
