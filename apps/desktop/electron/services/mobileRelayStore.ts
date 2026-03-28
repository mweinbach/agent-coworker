import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

import { app } from "electron";

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

function getStoreDir(userDataPath = app.getPath("userData")): string {
  return path.join(userDataPath, "mobile-relay");
}

function getStoreFile(userDataPath = app.getPath("userData")): string {
  return path.join(getStoreDir(userDataPath), "device-state.json");
}

export function loadOrCreateMobileRelayStoreState(userDataPath = app.getPath("userData")): MobileRelayStoreState {
  const storeFile = getStoreFile(userDataPath);
  if (fs.existsSync(storeFile)) {
    try {
      const raw = fs.readFileSync(storeFile, "utf8");
      const normalized = normalizeStoreState(JSON.parse(raw));
      fs.writeFileSync(storeFile, JSON.stringify(normalized, null, 2), { encoding: "utf8", mode: 0o600 });
      return normalized;
    } catch {
      const created = createStoreState();
      fs.mkdirSync(getStoreDir(userDataPath), { recursive: true });
      fs.writeFileSync(storeFile, JSON.stringify(created, null, 2), { encoding: "utf8", mode: 0o600 });
      return created;
    }
  }
  const created = createStoreState();
  fs.mkdirSync(getStoreDir(userDataPath), { recursive: true });
  fs.writeFileSync(storeFile, JSON.stringify(created, null, 2), { encoding: "utf8", mode: 0o600 });
  return created;
}

export async function persistMobileRelayStoreState(
  state: MobileRelayStoreState,
  userDataPath = app.getPath("userData"),
): Promise<MobileRelayStoreState> {
  const normalized = normalizeStoreState(state);
  await fs.promises.mkdir(getStoreDir(userDataPath), { recursive: true });
  await fs.promises.writeFile(getStoreFile(userDataPath), JSON.stringify(normalized, null, 2), { encoding: "utf8", mode: 0o600 });
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
