export type PairingQrPayload = {
  v: number;
  relay: string;
  sessionId: string;
  macDeviceId: string;
  macIdentityPublicKey: string;
  pairingSecret: string;
  expiresAt: number;
};

export type TrustedDesktopSummary = {
  macDeviceId: string;
  macIdentityPublicKey: string;
  relay: string;
  displayName: string | null;
  fingerprint: string;
  lastConnectedAt: string | null;
};
