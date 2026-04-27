import "reflect-metadata";

import { createHash } from "node:crypto";

import * as x509 from "@peculiar/x509";

const CERT_COMMON_NAME = "Cowork Mobile Pairing";

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  return Buffer.from(buffer).toString("base64");
}
function pemEncode(label: string, der: ArrayBuffer): string {
  const base64 = arrayBufferToBase64(der);
  const lines = base64.match(/.{1,64}/g) ?? [];
  return [`-----BEGIN ${label}-----`, ...lines, `-----END ${label}-----`, ""].join("\n");
}

function sha256Hex(bytes: ArrayBuffer): string {
  return createHash("sha256").update(Buffer.from(bytes)).digest("hex");
}

function sha256Base64Url(bytes: ArrayBuffer): string {
  return createHash("sha256").update(Buffer.from(bytes)).digest("base64url");
}

export type EphemeralQuicCertificate = {
  certPem: string;
  keyPem: string;
  certDerBase64: string;
  certSha256: string;
  spkiSha256: string;
  identityPub: string;
  notBefore: string;
  notAfter: string;
};

export function fingerprintCertificateDerBase64(certDerBase64: string): {
  certSha256: string;
  spkiSha256: string;
} {
  const cert = new x509.X509Certificate(certDerBase64);
  return {
    certSha256: sha256Hex(cert.rawData),
    spkiSha256: sha256Base64Url(cert.publicKey.rawData),
  };
}

export async function createEphemeralQuicCertificate(
  now = new Date(),
  lifetimeMs = 60 * 60 * 1000,
): Promise<EphemeralQuicCertificate> {
  const algorithm = {
    name: "ECDSA",
    namedCurve: "P-256",
    hash: "SHA-256",
  } as const;
  const keys = await crypto.subtle.generateKey(algorithm, true, ["sign", "verify"]);
  const notAfter = new Date(now.getTime() + lifetimeMs);
  const cert = await x509.X509CertificateGenerator.createSelfSigned({
    serialNumber: Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString("hex"),
    name: `CN=${CERT_COMMON_NAME}`,
    notBefore: now,
    notAfter,
    signingAlgorithm: algorithm,
    keys,
    extensions: [
      new x509.BasicConstraintsExtension(false, undefined, true),
      new x509.KeyUsagesExtension(x509.KeyUsageFlags.digitalSignature, true),
      await x509.SubjectKeyIdentifierExtension.create(keys.publicKey),
    ],
  });

  const privateKeyDer = await crypto.subtle.exportKey("pkcs8", keys.privateKey);
  const spkiDer = await crypto.subtle.exportKey("spki", keys.publicKey);

  return {
    certPem: cert.toString("pem"),
    keyPem: pemEncode("PRIVATE KEY", privateKeyDer),
    certDerBase64: cert.toString("base64"),
    certSha256: sha256Hex(cert.rawData),
    spkiSha256: sha256Base64Url(spkiDer),
    identityPub: Buffer.from(spkiDer).toString("base64url"),
    notBefore: now.toISOString(),
    notAfter: notAfter.toISOString(),
  };
}
