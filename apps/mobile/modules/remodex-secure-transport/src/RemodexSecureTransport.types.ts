export type RemodexTrustedMacRecord = {
  macDeviceId: string;
  relayUrl: string;
  workspaceName?: string | null;
  fingerprint?: string | null;
  lastConnectedAt?: string | null;
};

export type RemodexPairingPayload = {
  v: number;
  relay: string;
  sessionId: string;
  macDeviceId: string;
  macIdentityPublicKey: string;
  pairingSecret: string;
  expiresAt: number;
};

export type RemodexConnectionState =
  | "idle"
  | "connecting"
  | "pairing"
  | "secure"
  | "reconnecting"
  | "error";

export type RemodexTransportSnapshot = {
  state: RemodexConnectionState;
  transportMode: "native" | "fallback" | "unsupported";
  macDeviceId: string | null;
  relayUrl: string | null;
  sessionId: string | null;
  lastError: string | null;
};

export type RemodexSecureTransportEvents = {
  stateChanged: (state: RemodexTransportSnapshot) => void;
  plaintextMessage: (payload: { text: string }) => void;
  secureError: (payload: { message: string }) => void;
  socketClosed: (payload: { reason?: string | null }) => void;
};
