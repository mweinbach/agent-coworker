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
