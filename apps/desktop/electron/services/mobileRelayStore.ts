import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";

import {
  buildRelayKeyFingerprint,
  generateRelayKeyPair,
  isValidRelayKeyPair,
  isValidRelayPublicKey,
} from "../../../../src/shared/mobileRelaySecurity";
import type {
  MobileRelayStoreState,
  MobileRelayTrustedPhoneRecord,
} from "./mobileRelayTypes";

const COWORK_HOME_DIRNAME = ".cowork";
const MOBILE_RELAY_DIRNAME = "mobile-relay";

function normalizeNonEmptyString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

export function buildTrustedPhoneFingerprint(publicKeyBase64: string): string {
  return buildRelayKeyFingerprint(publicKeyBase64);
}

function normalizeTrustedPhoneRecord(raw: unknown): MobileRelayTrustedPhoneRecord | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return null;
  }
  const record = raw as Record<string, unknown>;
  const phoneDeviceId = normalizeNonEmptyString(record.phoneDeviceId);
  const phoneIdentityPublicKey = normalizeNonEmptyString(record.phoneIdentityPublicKey);
  if (!phoneDeviceId || !phoneIdentityPublicKey || !isValidRelayPublicKey(phoneIdentityPublicKey)) {
    return null;
  }
  return {
    phoneDeviceId,
    phoneIdentityPublicKey,
    fingerprint: normalizeNonEmptyString(record.fingerprint) || buildTrustedPhoneFingerprint(phoneIdentityPublicKey),
    displayName: normalizeNonEmptyString(record.displayName) || null,
    lastPairedAt: normalizeNonEmptyString(record.lastPairedAt) || new Date().toISOString(),
    lastConnectedAt: normalizeNonEmptyString(record.lastConnectedAt) || null,
  };
}

function normalizeStoreState(raw: unknown): MobileRelayStoreState {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("device state is invalid");
  }
  const record = raw as Record<string, unknown>;
  const macDeviceId = normalizeNonEmptyString(record.macDeviceId);
  if (!macDeviceId) {
    throw new Error("device state is incomplete");
  }
  const macIdentityPublicKey = normalizeNonEmptyString(record.macIdentityPublicKey);
  const macIdentityPrivateKey = normalizeNonEmptyString(record.macIdentityPrivateKey);
  const trustedPhone = normalizeTrustedPhoneRecord(record.trustedPhone);
  if (!isValidRelayKeyPair({
    publicKeyBase64: macIdentityPublicKey,
    privateKeyBase64: macIdentityPrivateKey,
  })) {
    const keyPair = generateRelayKeyPair();
    return {
      version: 1,
      macDeviceId,
      macIdentityPublicKey: keyPair.publicKeyBase64,
      macIdentityPrivateKey: keyPair.privateKeyBase64,
      trustedPhone: null,
    };
  }
  return {
    version: 1,
    macDeviceId,
    macIdentityPublicKey,
    macIdentityPrivateKey,
    trustedPhone,
  };
}

function createStoreState(): MobileRelayStoreState {
  const keyPair = generateRelayKeyPair();
  return {
    version: 1,
    macDeviceId: randomUUID(),
    macIdentityPublicKey: keyPair.publicKeyBase64,
    macIdentityPrivateKey: keyPair.privateKeyBase64,
    trustedPhone: null,
  };
}

function resolveDefaultStoreRoot(): string {
  return path.join(os.homedir(), COWORK_HOME_DIRNAME);
}

export function resolveMobileRelayStoreDir(storeRootPath = resolveDefaultStoreRoot()): string {
  return path.join(storeRootPath, MOBILE_RELAY_DIRNAME);
}

export function resolveMobileRelayStoreFile(storeRootPath = resolveDefaultStoreRoot()): string {
  return path.join(resolveMobileRelayStoreDir(storeRootPath), "device-state.json");
}

export function loadOrCreateMobileRelayStoreState(storeRootPath = resolveDefaultStoreRoot()): MobileRelayStoreState {
  const storeFile = resolveMobileRelayStoreFile(storeRootPath);
  if (fs.existsSync(storeFile)) {
    try {
      const raw = fs.readFileSync(storeFile, "utf8");
      const normalized = normalizeStoreState(JSON.parse(raw));
      fs.writeFileSync(storeFile, JSON.stringify(normalized, null, 2), { encoding: "utf8", mode: 0o600 });
      return normalized;
    } catch {
      const created = createStoreState();
      fs.mkdirSync(resolveMobileRelayStoreDir(storeRootPath), { recursive: true });
      fs.writeFileSync(storeFile, JSON.stringify(created, null, 2), { encoding: "utf8", mode: 0o600 });
      return created;
    }
  }
  const created = createStoreState();
  fs.mkdirSync(resolveMobileRelayStoreDir(storeRootPath), { recursive: true });
  fs.writeFileSync(storeFile, JSON.stringify(created, null, 2), { encoding: "utf8", mode: 0o600 });
  return created;
}

export async function persistMobileRelayStoreState(
  state: MobileRelayStoreState,
  storeRootPath = resolveDefaultStoreRoot(),
): Promise<MobileRelayStoreState> {
  const normalized = normalizeStoreState(state);
  await fs.promises.mkdir(resolveMobileRelayStoreDir(storeRootPath), { recursive: true });
  await fs.promises.writeFile(
    resolveMobileRelayStoreFile(storeRootPath),
    JSON.stringify(normalized, null, 2),
    { encoding: "utf8", mode: 0o600 },
  );
  return normalized;
}

export function rememberTrustedPhoneRecord(
  state: MobileRelayStoreState,
  record: {
    phoneDeviceId: string;
    phoneIdentityPublicKey: string;
    displayName?: string | null;
    lastConnectedAt?: string | null;
  },
): MobileRelayStoreState {
  return {
    ...state,
    trustedPhone: {
      phoneDeviceId: record.phoneDeviceId,
      phoneIdentityPublicKey: record.phoneIdentityPublicKey,
      fingerprint: buildTrustedPhoneFingerprint(record.phoneIdentityPublicKey),
      displayName: record.displayName ?? null,
      lastPairedAt: new Date().toISOString(),
      lastConnectedAt: record.lastConnectedAt ?? new Date().toISOString(),
    },
  };
}

export function forgetTrustedPhoneRecord(state: MobileRelayStoreState): MobileRelayStoreState {
  return {
    ...state,
    trustedPhone: null,
  };
}
