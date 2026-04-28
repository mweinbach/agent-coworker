import { timingSafeEqual } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { createPairingNonce } from "../../../shared/coworkTicket";

const COWORK_HOME_DIRNAME = ".cowork";
const MOBILE_PAIRING_DIRNAME = "mobile-pairing";
const DEVICES_FILE_NAME = "devices.json";
const pairingStoreLocks = new Map<string, Promise<void>>();

export type H3TrustedDeviceRecord = {
  deviceId: string;
  identityPub: string;
  displayName: string | null;
  fingerprint: string;
  sessionTokenHash: string;
  lastPairedAt: string;
  lastConnectedAt: string | null;
};

export type H3PairingStoreState = {
  version: 1;
  trustedDevices: H3TrustedDeviceRecord[];
};

export type H3PairingSession = {
  nonce: string;
  expiresAt: number;
};

function resolveDefaultStoreRoot(): string {
  return path.join(os.homedir(), COWORK_HOME_DIRNAME);
}

function resolvePairingStoreLockKey(storeRootPath: string | undefined): string {
  return path.resolve(storeRootPath ?? resolveDefaultStoreRoot());
}

async function withPairingStoreLock<T>(
  storeRootPath: string | undefined,
  task: () => Promise<T>,
): Promise<T> {
  const lockKey = resolvePairingStoreLockKey(storeRootPath);
  const previous = pairingStoreLocks.get(lockKey) ?? Promise.resolve();
  let releaseCurrentLock!: () => void;
  const current = new Promise<void>((resolve) => {
    releaseCurrentLock = resolve;
  });
  const next = previous.catch(() => undefined).then(() => current);
  pairingStoreLocks.set(lockKey, next);

  await previous.catch(() => undefined);
  try {
    return await task();
  } finally {
    releaseCurrentLock();
    if (pairingStoreLocks.get(lockKey) === next) {
      pairingStoreLocks.delete(lockKey);
    }
  }
}

export function resolveH3PairingStoreDir(storeRootPath = resolveDefaultStoreRoot()): string {
  return path.join(storeRootPath, MOBILE_PAIRING_DIRNAME);
}

export function resolveH3PairingDevicesFile(storeRootPath = resolveDefaultStoreRoot()): string {
  return path.join(resolveH3PairingStoreDir(storeRootPath), DEVICES_FILE_NAME);
}

async function sha256Base64Url(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Buffer.from(digest).toString("base64url");
}

function normalizeString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeDeviceRecord(raw: unknown): H3TrustedDeviceRecord | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return null;
  }
  const record = raw as Record<string, unknown>;
  const deviceId = normalizeString(record.deviceId);
  const identityPub = normalizeString(record.identityPub);
  const fingerprint = normalizeString(record.fingerprint);
  const sessionTokenHash = normalizeString(record.sessionTokenHash);
  if (!deviceId || !identityPub || !fingerprint || !sessionTokenHash) {
    return null;
  }
  return {
    deviceId,
    identityPub,
    fingerprint,
    sessionTokenHash,
    displayName: normalizeString(record.displayName) || null,
    lastPairedAt: normalizeString(record.lastPairedAt) || new Date().toISOString(),
    lastConnectedAt: normalizeString(record.lastConnectedAt) || null,
  };
}

function normalizeStoreState(raw: unknown): H3PairingStoreState {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { version: 1, trustedDevices: [] };
  }
  const record = raw as Record<string, unknown>;
  return {
    version: 1,
    trustedDevices: Array.isArray(record.trustedDevices)
      ? record.trustedDevices
          .map((entry) => normalizeDeviceRecord(entry))
          .filter((entry): entry is H3TrustedDeviceRecord => entry !== null)
      : [],
  };
}

export async function loadH3PairingStoreState(
  storeRootPath = resolveDefaultStoreRoot(),
): Promise<H3PairingStoreState> {
  try {
    const raw = await fs.readFile(resolveH3PairingDevicesFile(storeRootPath), "utf8");
    return normalizeStoreState(JSON.parse(raw));
  } catch {
    return { version: 1, trustedDevices: [] };
  }
}

export async function persistH3PairingStoreState(
  state: H3PairingStoreState,
  storeRootPath = resolveDefaultStoreRoot(),
): Promise<H3PairingStoreState> {
  const normalized = normalizeStoreState(state);
  await fs.mkdir(resolveH3PairingStoreDir(storeRootPath), { recursive: true });
  await fs.writeFile(
    resolveH3PairingDevicesFile(storeRootPath),
    JSON.stringify(normalized, null, 2),
    {
      encoding: "utf8",
      mode: 0o600,
    },
  );
  return normalized;
}

export function createH3PairingSession(lifetimeMs = 10 * 60 * 1000): H3PairingSession {
  return {
    nonce: createPairingNonce(),
    expiresAt: Date.now() + lifetimeMs,
  };
}

export function verifyH3PairingNonce(session: H3PairingSession, nonce: string): boolean {
  if (Date.now() > session.expiresAt) {
    return false;
  }
  const expected = Buffer.from(session.nonce);
  const actual = Buffer.from(nonce);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

export async function rememberH3TrustedDevice(
  storeRootPath: string | undefined,
  device: {
    deviceId: string;
    identityPub: string;
    displayName?: string | null;
    sessionToken: string;
  },
): Promise<H3TrustedDeviceRecord> {
  return await withPairingStoreLock(storeRootPath, async () => {
    const now = new Date().toISOString();
    const fingerprint = (await sha256Base64Url(device.identityPub)).slice(0, 16);
    const record: H3TrustedDeviceRecord = {
      deviceId: device.deviceId,
      identityPub: device.identityPub,
      displayName: device.displayName ?? null,
      fingerprint,
      sessionTokenHash: await sha256Base64Url(device.sessionToken),
      lastPairedAt: now,
      lastConnectedAt: now,
    };
    const state = await loadH3PairingStoreState(storeRootPath);
    const trustedDevices = state.trustedDevices.filter(
      (entry) => entry.deviceId !== device.deviceId,
    );
    trustedDevices.unshift(record);
    await persistH3PairingStoreState({ version: 1, trustedDevices }, storeRootPath);
    return record;
  });
}

export async function verifyH3SessionToken(
  storeRootPath: string | undefined,
  sessionToken: string | null,
): Promise<H3TrustedDeviceRecord | null> {
  if (!sessionToken) {
    return null;
  }
  return await withPairingStoreLock(storeRootPath, async () => {
    const state = await loadH3PairingStoreState(storeRootPath);
    const tokenHash = await sha256Base64Url(sessionToken);
    const match = state.trustedDevices.find((device) => device.sessionTokenHash === tokenHash);
    if (!match) {
      return null;
    }
    match.lastConnectedAt = new Date().toISOString();
    await persistH3PairingStoreState(state, storeRootPath);
    return match;
  });
}

export async function forgetH3TrustedDevice(
  storeRootPath: string | undefined,
  deviceId: string,
): Promise<boolean> {
  const normalizedDeviceId = deviceId.trim();
  if (!normalizedDeviceId) {
    return false;
  }
  return await withPairingStoreLock(storeRootPath, async () => {
    const state = await loadH3PairingStoreState(storeRootPath);
    const trustedDevices = state.trustedDevices.filter(
      (device) => device.deviceId !== normalizedDeviceId,
    );
    if (trustedDevices.length === state.trustedDevices.length) {
      return false;
    }
    await persistH3PairingStoreState({ version: 1, trustedDevices }, storeRootPath);
    return true;
  });
}

export async function forgetH3TrustedDevices(
  storeRootPath = resolveDefaultStoreRoot(),
): Promise<void> {
  await withPairingStoreLock(storeRootPath, async () => {
    await persistH3PairingStoreState({ version: 1, trustedDevices: [] }, storeRootPath);
  });
}
