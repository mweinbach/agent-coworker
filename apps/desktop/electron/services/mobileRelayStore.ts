import fs from "node:fs";
import path from "node:path";
import { createHash, generateKeyPairSync, randomUUID } from "node:crypto";

import { app } from "electron";

import type {
  MobileRelayStoreState,
  MobileRelayTrustedPhoneRecord,
} from "./mobileRelayTypes";

function normalizeNonEmptyString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function fromBase64Url(value: string): string {
  const padded = `${value}${"=".repeat((4 - (value.length % 4 || 4)) % 4)}`;
  return padded.replace(/-/g, "+").replace(/_/g, "/");
}

export function buildTrustedPhoneFingerprint(publicKeyBase64: string): string {
  return createHash("sha256").update(Buffer.from(publicKeyBase64, "base64")).digest("hex").slice(0, 16);
}

function normalizeTrustedPhoneRecord(raw: unknown): MobileRelayTrustedPhoneRecord | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return null;
  }
  const record = raw as Record<string, unknown>;
  const phoneDeviceId = normalizeNonEmptyString(record.phoneDeviceId);
  const phoneIdentityPublicKey = normalizeNonEmptyString(record.phoneIdentityPublicKey);
  if (!phoneDeviceId || !phoneIdentityPublicKey) {
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
  const macIdentityPublicKey = normalizeNonEmptyString(record.macIdentityPublicKey);
  const macIdentityPrivateKey = normalizeNonEmptyString(record.macIdentityPrivateKey);
  if (!macDeviceId || !macIdentityPublicKey || !macIdentityPrivateKey) {
    throw new Error("device state is incomplete");
  }
  return {
    version: 1,
    macDeviceId,
    macIdentityPublicKey,
    macIdentityPrivateKey,
    trustedPhone: normalizeTrustedPhoneRecord(record.trustedPhone),
  };
}

function createStoreState(): MobileRelayStoreState {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const publicJwk = publicKey.export({ format: "jwk" }) as { x: string };
  const privateJwk = privateKey.export({ format: "jwk" }) as { d: string };
  return {
    version: 1,
    macDeviceId: randomUUID(),
    macIdentityPublicKey: fromBase64Url(publicJwk.x),
    macIdentityPrivateKey: fromBase64Url(privateJwk.d),
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
    const raw = fs.readFileSync(storeFile, "utf8");
    return normalizeStoreState(JSON.parse(raw));
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
