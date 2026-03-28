export type MobileRelayStatus =
  | "idle"
  | "starting"
  | "pairing"
  | "connected"
  | "reconnecting"
  | "error";

export type MobileRelaySource =
  | "remodex"
  | "managed"
  | "override"
  | "unavailable";

export type MobileRelayServiceStatus =
  | "unknown"
  | "running"
  | "not-running"
  | "disconnected"
  | "unavailable";

export type MobileRelayPairingPayload = {
  v: number;
  relay: string;
  sessionId: string;
  macDeviceId: string;
  macIdentityPublicKey: string;
  pairingSecret: string;
  expiresAt: number;
};

export type MobileRelayTrustedPhoneRecord = {
  phoneDeviceId: string;
  phoneIdentityPublicKey: string;
  fingerprint: string;
  displayName: string | null;
  lastPairedAt: string;
  lastConnectedAt: string | null;
};

export type MobileRelayStoreState = {
  version: 1;
  macDeviceId: string;
  macIdentityPublicKey: string;
  macIdentityPrivateKey: string;
  trustedPhone: MobileRelayTrustedPhoneRecord | null;
};

export type MobileRelayIdentityState = Pick<
  MobileRelayStoreState,
  "macDeviceId" | "macIdentityPublicKey" | "macIdentityPrivateKey" | "trustedPhone"
>;

export type MobileRelayWorkspaceRecord = {
  id: string;
  name: string;
  path: string;
  createdAt?: string;
  lastOpenedAt?: string;
  defaultProvider?: string;
  defaultModel?: string;
  defaultEnableMcp?: boolean;
  yolo: boolean;
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
  lastError: string | null;
};

export type MobileRelaySnapshot = MobileRelayBridgeState;

export type MobileRelayWireControlMessage = {
  kind: string;
  [key: string]: unknown;
};

export type MobileRelayWireMessage = MobileRelayWireControlMessage & {
  v?: number;
  sessionId?: string;
  keyEpoch?: number;
  sender?: string;
  counter?: number;
  nonce?: string;
  ciphertext?: string;
};

export type MobileRelaySecureTransportApi = {
  createPairingPayload(): MobileRelayPairingPayload;
  bindLiveSendWireMessage(sendWireMessage: ((wireText: string) => boolean) | null): void;
  handleIncomingWireMessage(
    rawMessage: string,
    handlers: {
      sendControlMessage(controlMessage: MobileRelayWireControlMessage): void;
      onApplicationMessage(plaintextMessage: string): void;
    },
  ): boolean;
  queueOutboundApplicationMessage(
    payloadText: string,
    sendWireMessage: (wireText: string) => boolean,
  ): void;
  isSecureChannelReady(): boolean;
  getTrustedPhoneRecord(): MobileRelayTrustedPhoneRecord | null;
};
