import "reflect-metadata";

import fs from "node:fs/promises";
import path from "node:path";

import * as x509 from "@peculiar/x509";

import {
  createEphemeralQuicCertificate,
  type EphemeralQuicCertificate,
  fingerprintX509Certificate,
} from "../../../shared/quicCert";
import { resolveH3PairingStoreDir } from "./pairing";

const TLS_CERT_FILE_NAME = "tls-cert.pem";
const TLS_KEY_FILE_NAME = "tls-key.pem";
const LISTENER_CONFIG_FILE_NAME = "listener.json";
const CERT_RENEWAL_BUFFER_MS = 5 * 60 * 1000;
const PERSISTED_CERT_LIFETIME_MS = 365 * 24 * 60 * 60 * 1000;

type H3ListenerConfig = {
  version: 1;
  port: number;
};

type H3ListenerPaths = {
  dir: string;
  certPath: string;
  keyPath: string;
  listenerConfigPath: string;
};

function resolveH3ListenerPaths(storeRootPath: string | undefined): H3ListenerPaths {
  const dir = resolveH3PairingStoreDir(storeRootPath);
  return {
    dir,
    certPath: path.join(dir, TLS_CERT_FILE_NAME),
    keyPath: path.join(dir, TLS_KEY_FILE_NAME),
    listenerConfigPath: path.join(dir, LISTENER_CONFIG_FILE_NAME),
  };
}

function resolveListenerConfigPath(storeRootPath: string | undefined): string {
  return resolveH3ListenerPaths(storeRootPath).listenerConfigPath;
}

function certificateFromPem(certPem: string, keyPem: string): EphemeralQuicCertificate {
  const cert = new x509.X509Certificate(certPem);
  return {
    certPem,
    keyPem,
    ...fingerprintX509Certificate(cert),
    notBefore: cert.notBefore.toISOString(),
    notAfter: cert.notAfter.toISOString(),
  };
}

function isCertificateUsable(certificate: EphemeralQuicCertificate, now = Date.now()): boolean {
  const notAfterMs = Date.parse(certificate.notAfter);
  if (Number.isFinite(notAfterMs) === false) {
    return false;
  }
  return notAfterMs - now > CERT_RENEWAL_BUFFER_MS;
}

async function readPersistedCertificate(
  storeRootPath: string | undefined,
): Promise<EphemeralQuicCertificate | null> {
  const paths = resolveH3ListenerPaths(storeRootPath);
  try {
    const [certPem, keyPem] = await Promise.all([
      fs.readFile(paths.certPath, "utf8"),
      fs.readFile(paths.keyPath, "utf8"),
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
  const paths = resolveH3ListenerPaths(storeRootPath);
  await fs.mkdir(paths.dir, { recursive: true });
  await Promise.all([
    fs.writeFile(paths.certPath, certificate.certPem, "utf8"),
    fs.writeFile(paths.keyPath, certificate.keyPem, {
      encoding: "utf8",
      mode: 0o600,
    }),
  ]);
}

export async function clearPersistedH3ListenerIdentity(
  storeRootPath: string | undefined,
): Promise<void> {
  const paths = resolveH3ListenerPaths(storeRootPath);
  await Promise.allSettled([fs.unlink(paths.certPath), fs.unlink(paths.keyPath)]);
}

export async function loadOrCreatePersistedQuicCertificate(
  storeRootPath: string | undefined,
  options?: { forceRotate?: boolean },
): Promise<EphemeralQuicCertificate> {
  if (options?.forceRotate) {
    await clearPersistedH3ListenerIdentity(storeRootPath);
  } else {
    const existing = await readPersistedCertificate(storeRootPath);
    if (existing !== null) {
      return existing;
    }
  }

  const certificate = await createEphemeralQuicCertificate(new Date(), PERSISTED_CERT_LIFETIME_MS);
  await writePersistedCertificate(storeRootPath, certificate);
  return certificate;
}

async function readListenerConfig(
  storeRootPath: string | undefined,
): Promise<H3ListenerConfig | null> {
  try {
    const raw = await fs.readFile(resolveListenerConfigPath(storeRootPath), "utf8");
    const parsed = JSON.parse(raw) as Partial<H3ListenerConfig>;
    const port = parsed.port;
    if (
      parsed.version === 1 &&
      typeof port === "number" &&
      Number.isFinite(port) &&
      port >= 0 &&
      port <= 65535
    ) {
      return { version: 1, port };
    }
    return null;
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
  if (Number.isFinite(port) === false || port <= 0 || port > 65535) {
    return;
  }
  const paths = resolveH3ListenerPaths(storeRootPath);
  await fs.mkdir(paths.dir, { recursive: true });
  const payload: H3ListenerConfig = { version: 1, port };
  await fs.writeFile(paths.listenerConfigPath, JSON.stringify(payload, null, 2), "utf8");
}

export const __internal = {
  resolveListenerConfigPath,
  isCertificateUsable,
  CERT_RENEWAL_BUFFER_MS,
};
