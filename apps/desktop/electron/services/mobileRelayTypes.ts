export type MobileRelayStatus =
  | "idle"
  | "starting"
  | "pairing"
  | "connected"
  | "reconnecting"
  | "error";

export type MobileRelaySource = "direct" | "remodex" | "managed" | "override" | "unavailable";

export type MobileRelayServiceStatus = "unknown" | "running" | "not-running" | "unavailable";

export type MobileRelayPairingPayload = {
  v: 1;
  scheme: "h3";
  hosts: string[];
  port: number;
  certSha256: string;
  spkiSha256: string;
  identityPub: string;
  nonce: string;
  expiresAt: number;
};

export type MobileRelayBridgeState = {
  status: MobileRelayStatus;
  workspaceId: string | null;
  workspacePath: string | null;
  relaySource: MobileRelaySource;
  relaySourceMessage: string | null;
  relayServiceStatus: MobileRelayServiceStatus;
  relayServiceMessage: string | null;
  relayServiceUpdatedAt: string | null;
  relayUrl: string | null;
  sessionId: string | null;
  pairingPayload: MobileRelayPairingPayload | null;
  trustedPhoneDeviceId: string | null;
  trustedPhoneFingerprint: string | null;
  directUrl: string | null;
  ticketUrl: string | null;
  certSha256: string | null;
  spkiSha256: string | null;
  hostHints: string[];
  lastError: string | null;
};

export type MobileRelaySnapshot = MobileRelayBridgeState;
