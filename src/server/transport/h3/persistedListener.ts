import "reflect-metadata";

import { createHash } from "node:crypto";
import fs from "node:fs/promises";

import * as x509 from "@peculiar/x509";

import {
  createEphemeralQuicCertificate,
  type EphemeralQuicCertificate,
} from "../../../shared/quicCert";
import { resolveH3PairingStoreDir } from "./pairing";

const TLS_CERT_FILE_NAME = "tls-cert.pem";
const TLS_KEY_FILE_NAME = "tls-key.pem";
const LISTENER_CONFIG_FILE_NAME = "listener.json";
const CERT_RENEWAL_BUFFER_MS = 5 * 60 * 1000;

type H3ListenerConfig = {
  version: 1;
  port: number;
};

function resolveTlsCertPath(storeRootPath: string | undefined): string {
  return resolveH3PairingStoreDir(storeRootPath) + "/" + TLS_CERT_FILE_NAME;
}

function resolveTlsKeyPath(storeRootPath: string | undefined): string {
  return resolveH3PairingStoreDir(storeRootPath) + "/" + TLS_KEY_FILE_NAME;
}

function resolveListenerConfigPath(storeRootPath: string | undefined): string {
  return resolveH3PairingStoreDir(storeRootPath) + "/" + LISTENER_CONFIG_FILE_NAME;
}

function certificateFromPem(certPem: string, keyPem: string): EphemeralQuicCertificate {
  const cert = new x509.X509Certificate(certPem);
  const spkiDer = cert.publicKey.rawData;
  return {
    certPem,
    keyPem,
    certDerBase64: cert.toString("base64"),
    certSha256: createHash("sha256").update(Buffer.from(cert.rawData)).digest("hex"),
    spkiSha256: createHash("sha256").update(Buffer.from(spkiDer)).digest("base64url"),
    identityPub: Buffer.from(spkiDer).toString("base64url"),
    notBefore: cert.notBefore.toISOString(),
    notAfter: cert.notAfter.toISOString(),
  };
}

function isCertificateUsable(certificate: EphemeralQuicCertificate, now = Date.now()): boolean {
  const notAfterMs = Date.parse(certificate.notAfter);
  return Number.isFinite(notAfterMs) && notAfterMs - now > CERT_RENEWAL_BUFFER_MS;
}

async function readPersistedCertificate(
  storeRootPath: string | undefined,
): Promise<EphemeralQuicCertificate | null> {
  try {
    const [certPem, keyPem] = await Promise.all([
      fs.readFile(resolveTlsCertPath(storeRootPath), "utf8"),
      fs.readFile(resolveTlsKeyPath(storeRootPath), "utf8"),
    ]);
    const certificate = certificateFromPem(certPem, keyPem);
    return isCertificateUsable(certificate) ? certificate : null;
  } catch {
    return null;
  }
}

async function writePersistedCertificate(
  storeRootPath: string | undefined,
  certificate: EphemeralQuicCertificate,
): Promise<void> {
  const dir = resolveH3PairingStoreDir(storeRootPath);
  await fs.mkdir(dir, { recursive: true });
  await Promise.all([
    fs.writeFile(resolveTlsCertPath(storeRootPath), certificate.certPem, "utf8"),
    fs.writeFile(resolveTlsKeyPath(storeRootPath), certificate.keyPem, {
      encoding: "utf8",
      mode: 0o600,
    }),
  ]);
}

export async function clearPersistedH3ListenerIdentity(
  storeRootPath: string | undefined,
): Promise<void> {
  await Promise.allSettled([
    fs.unlink(resolveTlsCertPath(storeRootPath)),
    fs.unlink(resolveTlsKeyPath(storeRootPath)),
  ]);
}

export async function loadOrCreatePersistedQuicCertificate(
  storeRootPath: string | undefined,
  options?: { forceRotate?: boolean },
): Promise<EphemeralQuicCertificate> {
  if (options?.forceRotate) {
    await clearPersistedH3ListenerIdentity(storeRootPath);
  } else {
    const existing = await readPersistedCertificate(storeRootPath);
    if (existing) {
      return existing;
    }
  }

  const certificate = await createEphemeralQuicCertificate();
  await writePersistedCertificate(storeRootPath, certificate);
  return certificate;
}

async function readListenerConfig(
  storeRootPath: string | undefined,
): Promise<H3ListenerConfig | null> {
  try {
    const raw = await fs.readFile(resolveListenerConfigPath(storeRootPath), "utf8");
    const parsed = JSON.parse(raw) as Partial<H3ListenerConfig>;
    if (parsed.version !== 1 || typeof parsed.port !== "number") {
      return null;
    }
    if (!Number.isFinite(parsed.port) || parsed.port < 0 || parsed.port > 65535) {
      return null;
    }
    return { version: 1, port: parsed.port };
  } catch {
    return null;
  }
}

export async function resolvePersistedH3Port(
  storeRootPath: string | undefined,
  requestedPort?: number,
): Promise<number> {
  if (requestedPort !== undefined && requestedPort > 0) {
    return requestedPort;
  }
  const config = await readListenerConfig(storeRootPath);
  return config?.port ?? 0;
}

export async function persistH3ListenerPort(
  storeRootPath: string | undefined,
  port: number,
): Promise<void> {
  if (!Number.isFinite(port) || port <= 0 || port > 65535) {
    return;
  }
  const dir = resolveH3PairingStoreDir(storeRootPath);
  await fs.mkdir(dir, { recursive: true });
  const payload: H3ListenerConfig = { version: 1, port };
  await fs.writeFile(
    resolveListenerConfigPath(storeRootPath),
    JSON.stringify(payload, null, 2),
    "utf8",
  );
}

export const __internal = {
  certificateFromPem,
  isCertificateUsable,
  resolveListenerConfigPath,
  resolveTlsCertPath,
};
