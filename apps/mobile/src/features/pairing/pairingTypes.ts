export type PairingQrPayload = {
  v: 1;
  scheme: "h3";
  hosts: string[];
  port: number;
  certSha256: string;
  spkiSha256: string;
  identityPub: string;
  nonce: string;
  expiresAt: number;
  rawTicket: string;
};

export type TrustedDesktopSummary = {
  macDeviceId: string;
  macIdentityPublicKey: string;
  relay: string;
  displayName: string | null;
  fingerprint: string;
  lastConnectedAt: string | null;
};
