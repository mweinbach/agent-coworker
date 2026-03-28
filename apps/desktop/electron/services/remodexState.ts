import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  buildRelayKeyFingerprint,
  deriveRelayPublicKey,
  isValidRelayKeyPair,
  isValidRelayPrivateKey,
  isValidRelayPublicKey,
} from "../../../../src/shared/mobileRelaySecurity";
import type {
  MobileRelayIdentityState,
  MobileRelayPairingPayload,
  MobileRelayServiceStatus,
  MobileRelayTrustedPhoneRecord,
} from "./mobileRelayTypes";

const REMODEX_STATE_DIR_ENV = "REMODEX_DEVICE_STATE_DIR";
const REMODEX_STATE_DIRNAME = ".remodex";
const REMODEX_DAEMON_CONFIG_FILE = "daemon-config.json";
const REMODEX_DEVICE_STATE_FILE = "device-state.json";
const REMODEX_BRIDGE_STATUS_FILE = "bridge-status.json";
const REMODEX_PAIRING_SESSION_FILE = "pairing-session.json";

type JsonRecord = Record<string, unknown>;

type ReadJsonFileResult = {
  exists: boolean;
  parsed: JsonRecord | null;
};

export type RemodexStateReadResult =
  | {
      status: "resolved";
      state: ResolvedRemodexState;
    }
  | {
      status: "missing" | "invalid";
      stateDir: string;
      errorMessage: string;
    };

export type RemodexPairingSessionSnapshot = {
  createdAt: string | null;
  pairingPayload: MobileRelayPairingPayload | null;
};

export type ResolvedRemodexState = {
  stateDir: string;
  relayUrl: string;
  identityState: MobileRelayIdentityState;
  serviceStatus: MobileRelayServiceStatus;
  serviceMessage: string | null;
  serviceUpdatedAt: string | null;
  pairingSession: RemodexPairingSessionSnapshot | null;
};

type ResolveRemodexStateOptions = {
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
  stateDir?: string;
};

type PersistRemodexStateOptions = ResolveRemodexStateOptions & {
  now?: () => Date;
};

export function resolveRemodexStateDir(options: ResolveRemodexStateOptions = {}): string {
  const env = options.env ?? process.env;
  const fromEnv = normalizeNonEmptyString(env[REMODEX_STATE_DIR_ENV]);
  if (fromEnv) {
    return fromEnv;
  }
  return options.stateDir ?? path.join(options.homeDir ?? os.homedir(), REMODEX_STATE_DIRNAME);
}

export function readRemodexStateResult(options: ResolveRemodexStateOptions = {}): RemodexStateReadResult {
  const stateDir = resolveRemodexStateDir(options);
  const daemonConfigPath = path.join(stateDir, REMODEX_DAEMON_CONFIG_FILE);
  const deviceStatePath = path.join(stateDir, REMODEX_DEVICE_STATE_FILE);
  const bridgeStatusPath = path.join(stateDir, REMODEX_BRIDGE_STATUS_FILE);
  const pairingSessionPath = path.join(stateDir, REMODEX_PAIRING_SESSION_FILE);
  const daemonConfigErrorMessage = `Remodex daemon config is missing or unreadable at ${daemonConfigPath}.`;
  const deviceStateErrorMessage = `Remodex device state is missing or unreadable at ${deviceStatePath}.`;

  const daemonConfigResult = readJsonFile(daemonConfigPath);
  const deviceStateResult = readJsonFile(deviceStatePath);
  const bridgeStatusResult = readJsonFile(bridgeStatusPath);
  const pairingSessionResult = readJsonFile(pairingSessionPath);
  const hasAnyStateFile = daemonConfigResult.exists
    || deviceStateResult.exists
    || bridgeStatusResult.exists
    || pairingSessionResult.exists;

  if (!daemonConfigResult.parsed) {
    return {
      status: hasAnyStateFile ? "invalid" : "missing",
      stateDir,
      errorMessage: daemonConfigErrorMessage,
    };
  }

  const daemonConfig = daemonConfigResult.parsed;
  const relayUrl = normalizeNonEmptyString(daemonConfig.relayUrl);
  if (!relayUrl) {
    return {
      status: "invalid",
      stateDir,
      errorMessage: `Remodex relay URL is missing in ${daemonConfigPath}.`,
    };
  }

  const pairingSession = parsePairingSession(pairingSessionResult.parsed);
  const serviceStatus = deriveServiceStatus(bridgeStatusResult.parsed);
  const serviceMessage = deriveServiceMessage(bridgeStatusResult);
  const serviceUpdatedAt = normalizeNonEmptyString(bridgeStatusResult.parsed?.updatedAt) || null;
  if (!deviceStateResult.parsed) {
    return {
      status: "invalid",
      stateDir,
      errorMessage: deviceStateErrorMessage,
    };
  }

  try {
    const normalizedDeviceState = normalizeRemodexDeviceState(deviceStateResult.parsed);
    if (normalizedDeviceState !== deviceStateResult.parsed) {
      writeJsonFileSync(deviceStatePath, normalizedDeviceState);
    }
    return {
      status: "resolved",
      state: {
        stateDir,
        relayUrl,
        identityState: parseIdentityState(normalizedDeviceState, pairingSession?.createdAt ?? serviceUpdatedAt),
        serviceStatus,
        serviceMessage,
        serviceUpdatedAt,
        pairingSession,
      },
    };
  } catch (error) {
    return {
      status: "invalid",
      stateDir,
      errorMessage: error instanceof Error ? error.message : String(error),
    };
  }
}

export function readResolvedRemodexState(options: ResolveRemodexStateOptions = {}): ResolvedRemodexState {
  const result = readRemodexStateResult(options);
  if (result.status !== "resolved") {
    throw new Error(result.errorMessage);
  }
  return result.state;
}

export async function rememberRemodexTrustedPhoneRecord(
  record: {
    phoneDeviceId: string;
    phoneIdentityPublicKey: string;
  },
  options: PersistRemodexStateOptions = {},
): Promise<MobileRelayIdentityState> {
  const now = options.now?.() ?? new Date();
  const stateDir = resolveRemodexStateDir(options);
  const deviceStatePath = path.join(stateDir, REMODEX_DEVICE_STATE_FILE);
  const deviceState = readRequiredJsonFile(
    deviceStatePath,
    `Remodex device state is missing or unreadable at ${deviceStatePath}.`,
  );

  const trustedPhones = parseTrustedPhones(deviceState.trustedPhones);
  const nextTrustedPhones: Record<string, string> = {
    [record.phoneDeviceId]: record.phoneIdentityPublicKey,
  };
  for (const [phoneDeviceId, phoneIdentityPublicKey] of Object.entries(trustedPhones)) {
    if (phoneDeviceId === record.phoneDeviceId) {
      continue;
    }
    nextTrustedPhones[phoneDeviceId] = phoneIdentityPublicKey;
  }

  const nextState = {
    ...deviceState,
    trustedPhones: nextTrustedPhones,
  };
  await writeJsonFile(deviceStatePath, nextState);
  return parseIdentityState(nextState, now.toISOString(), record.phoneDeviceId, now.toISOString());
}

export async function forgetRemodexTrustedPhoneRecord(
  phoneDeviceId: string,
  options: PersistRemodexStateOptions = {},
): Promise<MobileRelayIdentityState> {
  const stateDir = resolveRemodexStateDir(options);
  const deviceStatePath = path.join(stateDir, REMODEX_DEVICE_STATE_FILE);
  const deviceState = readRequiredJsonFile(
    deviceStatePath,
    `Remodex device state is missing or unreadable at ${deviceStatePath}.`,
  );

  const trustedPhones = parseTrustedPhones(deviceState.trustedPhones);
  if (!(phoneDeviceId in trustedPhones)) {
    return parseIdentityState(deviceState);
  }

  const nextState = {
    ...deviceState,
    trustedPhones: {},
  };
  await writeJsonFile(deviceStatePath, nextState);
  return parseIdentityState(nextState);
}

function deriveServiceStatus(bridgeStatus: JsonRecord | null): MobileRelayServiceStatus {
  if (!bridgeStatus) {
    return "unavailable";
  }
  const state = normalizeNonEmptyString(bridgeStatus.state);
  if (state !== "running") {
    return "not-running";
  }
  const connectionStatus = normalizeNonEmptyString(bridgeStatus.connectionStatus);
  if (connectionStatus && connectionStatus !== "connected") {
    return "disconnected";
  }
  return "running";
}

function deriveServiceMessage(result: ReadJsonFileResult): string | null {
  if (!result.exists) {
    return "Remodex daemon status is unavailable.";
  }
  const bridgeStatus = result.parsed;
  if (!bridgeStatus) {
    return "Remodex daemon status is unreadable.";
  }
  const lastError = normalizeNonEmptyString(bridgeStatus.lastError);
  const state = normalizeNonEmptyString(bridgeStatus.state);
  if (state !== "running") {
    return lastError || "Remodex daemon is not running.";
  }
  const connectionStatus = normalizeNonEmptyString(bridgeStatus.connectionStatus);
  if (connectionStatus && connectionStatus !== "connected") {
    return lastError || "Remodex daemon is disconnected from the relay.";
  }
  return lastError || null;
}

function parseIdentityState(
  value: JsonRecord,
  lastPairedAt: string | null = null,
  preferredPhoneDeviceId: string | null = null,
  lastConnectedAt: string | null = null,
): MobileRelayIdentityState {
  const macDeviceId = normalizeNonEmptyString(value.macDeviceId);
  const macIdentityPublicKey = normalizeNonEmptyString(value.macIdentityPublicKey);
  const macIdentityPrivateKey = normalizeNonEmptyString(value.macIdentityPrivateKey);
  if (!macDeviceId || !macIdentityPublicKey || !macIdentityPrivateKey) {
    throw new Error("Remodex device state is incomplete.");
  }
  if (!isValidRelayKeyPair({
    publicKeyBase64: macIdentityPublicKey,
    privateKeyBase64: macIdentityPrivateKey,
  })) {
    throw new Error("Remodex device state contains invalid secure transport keys.");
  }

  return {
    macDeviceId,
    macIdentityPublicKey,
    macIdentityPrivateKey,
    trustedPhone: selectTrustedPhoneRecord(value.trustedPhones, preferredPhoneDeviceId, lastPairedAt, lastConnectedAt),
  };
}

function normalizeRemodexDeviceState(value: JsonRecord): JsonRecord {
  const macDeviceId = normalizeNonEmptyString(value.macDeviceId);
  const macIdentityPublicKey = normalizeNonEmptyString(value.macIdentityPublicKey);
  const macIdentityPrivateKey = normalizeNonEmptyString(value.macIdentityPrivateKey);
  if (!macDeviceId || !macIdentityPublicKey || !macIdentityPrivateKey) {
    throw new Error("Remodex device state is incomplete.");
  }
  if (isValidRelayKeyPair({
    publicKeyBase64: macIdentityPublicKey,
    privateKeyBase64: macIdentityPrivateKey,
  })) {
    return value;
  }
  if (!isValidRelayPrivateKey(macIdentityPrivateKey)) {
    throw new Error("Remodex device state contains invalid secure transport keys.");
  }

  return {
    ...value,
    macIdentityPublicKey: deriveRelayPublicKey(macIdentityPrivateKey),
  };
}

function selectTrustedPhoneRecord(
  trustedPhonesValue: unknown,
  preferredPhoneDeviceId: string | null,
  lastPairedAt: string | null,
  lastConnectedAt: string | null,
): MobileRelayTrustedPhoneRecord | null {
  const trustedPhones = parseTrustedPhones(trustedPhonesValue);
  const entries = Object.entries(trustedPhones);
  if (entries.length === 0) {
    return null;
  }
  const selected = preferredPhoneDeviceId
    ? entries.find(([phoneDeviceId]) => phoneDeviceId === preferredPhoneDeviceId) ?? entries[0]!
    : entries[0]!;

  return buildTrustedPhoneRecord(selected[0], selected[1], {
    lastPairedAt: lastPairedAt ?? new Date(0).toISOString(),
    lastConnectedAt,
  });
}

function buildTrustedPhoneRecord(
  phoneDeviceId: string,
  phoneIdentityPublicKey: string,
  options: {
    lastPairedAt: string;
    lastConnectedAt: string | null;
  },
): MobileRelayTrustedPhoneRecord {
  return {
    phoneDeviceId,
    phoneIdentityPublicKey,
    fingerprint: buildTrustedPhoneFingerprint(phoneIdentityPublicKey),
    displayName: null,
    lastPairedAt: options.lastPairedAt,
    lastConnectedAt: options.lastConnectedAt,
  };
}

function parseTrustedPhones(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  const trustedPhones: Record<string, string> = {};
  for (const [phoneDeviceId, phoneIdentityPublicKey] of Object.entries(value as JsonRecord)) {
    const normalizedDeviceId = normalizeNonEmptyString(phoneDeviceId);
    const normalizedPublicKey = normalizeNonEmptyString(phoneIdentityPublicKey);
    if (!normalizedDeviceId || !normalizedPublicKey || !isValidRelayPublicKey(normalizedPublicKey)) {
      continue;
    }
    trustedPhones[normalizedDeviceId] = normalizedPublicKey;
  }
  return trustedPhones;
}

function parsePairingSession(value: JsonRecord | null): RemodexPairingSessionSnapshot | null {
  if (!value) {
    return null;
  }
  const pairingPayloadValue = value.pairingPayload;
  if (!pairingPayloadValue || typeof pairingPayloadValue !== "object" || Array.isArray(pairingPayloadValue)) {
    return {
      createdAt: normalizeNonEmptyString(value.createdAt) || null,
      pairingPayload: null,
    };
  }

  const pairingPayloadRecord = pairingPayloadValue as JsonRecord;
  const relay = normalizeNonEmptyString(pairingPayloadRecord.relay);
  const sessionId = normalizeNonEmptyString(pairingPayloadRecord.sessionId);
  const macDeviceId = normalizeNonEmptyString(pairingPayloadRecord.macDeviceId);
  const macIdentityPublicKey = normalizeNonEmptyString(pairingPayloadRecord.macIdentityPublicKey);
  const pairingSecret = normalizeNonEmptyString(pairingPayloadRecord.pairingSecret);
  const expiresAt = Number.isFinite(pairingPayloadRecord.expiresAt)
    ? Number(pairingPayloadRecord.expiresAt)
    : null;

  if (!relay || !sessionId || !macDeviceId || !macIdentityPublicKey || !pairingSecret || expiresAt == null) {
    return {
      createdAt: normalizeNonEmptyString(value.createdAt) || null,
      pairingPayload: null,
    };
  }

  return {
    createdAt: normalizeNonEmptyString(value.createdAt) || null,
    pairingPayload: {
      v: Number.isInteger(pairingPayloadRecord.v) ? Number(pairingPayloadRecord.v) : 2,
      relay,
      sessionId,
      macDeviceId,
      macIdentityPublicKey,
      pairingSecret,
      expiresAt,
    },
  };
}

function readRequiredJsonFile(filePath: string, errorMessage: string): JsonRecord {
  const result = readJsonFile(filePath);
  if (!result.parsed) {
    throw new Error(errorMessage);
  }
  return result.parsed;
}

function readJsonFile(filePath: string): ReadJsonFileResult {
  if (!fs.existsSync(filePath)) {
    return { exists: false, parsed: null };
  }
  try {
    const raw = fs.readFileSync(filePath, "utf8");
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { exists: true, parsed: null };
    }
    return { exists: true, parsed: parsed as JsonRecord };
  } catch {
    return { exists: true, parsed: null };
  }
}

async function writeJsonFile(filePath: string, value: unknown): Promise<void> {
  await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
  await fs.promises.writeFile(filePath, JSON.stringify(value, null, 2), { encoding: "utf8", mode: 0o600 });
}

function writeJsonFileSync(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2), { encoding: "utf8", mode: 0o600 });
}

function normalizeNonEmptyString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function buildTrustedPhoneFingerprint(publicKeyBase64: string): string {
  return buildRelayKeyFingerprint(publicKeyBase64);
}
