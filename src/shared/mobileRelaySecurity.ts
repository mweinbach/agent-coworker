import nacl from "tweetnacl";
import { z } from "zod";

export const RELAY_PAIRING_QR_VERSION = 4 as const;
export const RELAY_SECURE_ENVELOPE_VERSION = 1 as const;
export const RELAY_HANDSHAKE_PROOF_METHOD = "relay/handshakeProof" as const;
const RELAY_SESSION_KEY_CONTEXT = "relay-session-key-v1";

export type RelayParticipantRole = "mac" | "phone";

export type RelayMacRegistration = {
  kind: "relayMacRegistration";
  registration: {
    sessionId: string | null;
    macDeviceId: string;
    macIdentityPublicKey: string;
    displayName: string | null;
    trustedPhoneDeviceId: string | null;
    trustedPhonePublicKey: string | null;
  };
};

export type RelayClientHello = {
  kind: "clientHello";
  phoneDeviceId: string;
  phoneIdentityPublicKey: string;
  pairingProof: string | null;
};

export type RelaySecureReady = {
  kind: "secureReady";
};

export type RelaySecureError = {
  kind: "secureError";
  message: string;
};

export type RelayPassthroughControlMessage = {
  kind: "serverHello" | "clientAuth" | "resumeState";
};

export type RelayControlMessage =
  | RelayMacRegistration
  | RelayClientHello
  | RelaySecureReady
  | RelaySecureError
  | RelayPassthroughControlMessage;

export type RelaySecureEnvelope = {
  kind: "secureEnvelope";
  v: typeof RELAY_SECURE_ENVELOPE_VERSION;
  sender: RelayParticipantRole;
  counter: number;
  nonce: string;
  ciphertext: string;
};

type DecodeRelaySecureEnvelopeResult =
  | {
      ok: true;
      envelope: RelaySecureEnvelope;
      plaintext: string;
    }
  | {
      ok: false;
      error: string;
    };

const nonEmptyStringSchema = z.string().trim().min(1);
const jsonRpcIdSchema = z.union([z.string(), z.number().finite()]);

const jsonRpcRequestSchema = z.object({
  id: jsonRpcIdSchema,
  method: nonEmptyStringSchema,
  params: z.unknown().optional(),
}).strict();

const jsonRpcNotificationSchema = z.object({
  method: nonEmptyStringSchema,
  params: z.unknown().optional(),
}).strict();

const jsonRpcResponseSchema = z.object({
  id: jsonRpcIdSchema,
  result: z.unknown().optional(),
  error: z.object({
    code: z.number(),
    message: z.string(),
    data: z.unknown().optional(),
  }).optional(),
}).strict().refine((value) => value.result !== undefined || value.error !== undefined, {
  message: "Response must include result or error.",
});

const relaySecureEnvelopeSchema = z.object({
  kind: z.literal("secureEnvelope"),
  v: z.literal(RELAY_SECURE_ENVELOPE_VERSION),
  sender: z.enum(["mac", "phone"]),
  counter: z.number().int().positive(),
  nonce: nonEmptyStringSchema,
  ciphertext: nonEmptyStringSchema,
}).strict();

const relayMacRegistrationSchema = z.object({
  kind: z.literal("relayMacRegistration"),
  registration: z.object({
    sessionId: z.string().trim().min(1).nullable().optional(),
    macDeviceId: nonEmptyStringSchema,
    macIdentityPublicKey: nonEmptyStringSchema,
    displayName: z.string().trim().min(1).nullable().optional(),
    trustedPhoneDeviceId: z.string().trim().min(1).nullable().optional(),
    trustedPhonePublicKey: z.string().trim().min(1).nullable().optional(),
  }).strict(),
}).strict();

const relayClientHelloSchema = z.object({
  kind: z.literal("clientHello"),
  phoneDeviceId: nonEmptyStringSchema,
  phoneIdentityPublicKey: nonEmptyStringSchema,
  pairingProof: z.string().trim().min(1).optional(),
}).strict();

const relaySecureReadySchema = z.object({
  kind: z.literal("secureReady"),
}).strict();

const relaySecureErrorSchema = z.object({
  kind: z.literal("secureError"),
  message: nonEmptyStringSchema,
}).strict();

const relayPassthroughControlSchema = z.object({
  kind: z.enum(["serverHello", "clientAuth", "resumeState"]),
}).strict();

function getBufferCtor():
  | { from(data: Uint8Array | string, encoding?: string): Uint8Array & { toString(encoding?: string): string } }
  | null {
  const candidate = (globalThis as {
    Buffer?: { from(data: Uint8Array | string, encoding?: string): Uint8Array & { toString(encoding?: string): string } };
  }).Buffer;
  return candidate ?? null;
}

function bytesToBase64(bytes: Uint8Array): string {
  const bufferCtor = getBufferCtor();
  if (bufferCtor) {
    return bufferCtor.from(bytes).toString("base64");
  }
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  if (typeof globalThis.btoa !== "function") {
    throw new Error("Base64 encoding is unavailable in this runtime.");
  }
  return globalThis.btoa(binary);
}

function base64ToBytes(value: string): Uint8Array | null {
  try {
    const bufferCtor = getBufferCtor();
    if (bufferCtor) {
      return new Uint8Array(bufferCtor.from(value, "base64"));
    }
    if (typeof globalThis.atob !== "function") {
      return null;
    }
    const binary = globalThis.atob(value);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }
    return bytes;
  } catch {
    return null;
  }
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function clampRandomUnit(value: number): number {
  if (!Number.isFinite(value)) {
    return 0.5;
  }
  if (value <= 0) {
    return 0;
  }
  if (value >= 1) {
    return 1;
  }
  return value;
}

export function isValidRelayPublicKey(publicKeyBase64: string): boolean {
  const keyBytes = base64ToBytes(publicKeyBase64);
  return keyBytes?.length === nacl.box.publicKeyLength;
}

export function isValidRelayPrivateKey(privateKeyBase64: string): boolean {
  const keyBytes = base64ToBytes(privateKeyBase64);
  return keyBytes?.length === nacl.box.secretKeyLength;
}

export function isValidRelayKeyPair(opts: {
  publicKeyBase64: string;
  privateKeyBase64: string;
}): boolean {
  const publicKeyBytes = base64ToBytes(opts.publicKeyBase64);
  const privateKeyBytes = base64ToBytes(opts.privateKeyBase64);
  if (
    publicKeyBytes?.length !== nacl.box.publicKeyLength
    || privateKeyBytes?.length !== nacl.box.secretKeyLength
  ) {
    return false;
  }
  const derivedPublicKey = nacl.box.keyPair.fromSecretKey(privateKeyBytes).publicKey;
  return nacl.verify(publicKeyBytes, derivedPublicKey);
}

export function generateRelayKeyPair(): {
  publicKeyBase64: string;
  privateKeyBase64: string;
} {
  const keyPair = nacl.box.keyPair();
  return {
    publicKeyBase64: bytesToBase64(keyPair.publicKey),
    privateKeyBase64: bytesToBase64(keyPair.secretKey),
  };
}

export function deriveRelayPublicKey(privateKeyBase64: string): string {
  const privateKeyBytes = base64ToBytes(privateKeyBase64);
  if (privateKeyBytes?.length !== nacl.box.secretKeyLength) {
    throw new Error("Invalid relay private key.");
  }
  return bytesToBase64(nacl.box.keyPair.fromSecretKey(privateKeyBytes).publicKey);
}

export function buildRelayKeyFingerprint(publicKeyBase64: string): string {
  const publicKeyBytes = base64ToBytes(publicKeyBase64);
  if (!publicKeyBytes || publicKeyBytes.length === 0) {
    return publicKeyBase64.slice(0, 16);
  }
  return bytesToHex(nacl.hash(publicKeyBytes)).slice(0, 16);
}

function encodeRelayPairingProofInput(opts: {
  pairingSecret: string;
  sessionId: string;
  macDeviceId: string;
  phoneDeviceId: string;
  phoneIdentityPublicKey: string;
}): Uint8Array {
  const payload = [
    "relay-pairing-proof-v1",
    opts.pairingSecret.trim(),
    opts.sessionId.trim(),
    opts.macDeviceId.trim(),
    opts.phoneDeviceId.trim(),
    opts.phoneIdentityPublicKey.trim(),
  ].join("\n");
  return new TextEncoder().encode(payload);
}

export function buildRelayPairingProof(opts: {
  pairingSecret: string;
  sessionId: string;
  macDeviceId: string;
  phoneDeviceId: string;
  phoneIdentityPublicKey: string;
}): string {
  return bytesToBase64(nacl.hash(encodeRelayPairingProofInput(opts)));
}

export function verifyRelayPairingProof(opts: {
  pairingSecret: string;
  sessionId: string;
  macDeviceId: string;
  phoneDeviceId: string;
  phoneIdentityPublicKey: string;
  pairingProof: string;
}): boolean {
  const provided = base64ToBytes(opts.pairingProof);
  if (!provided || provided.length === 0) {
    return false;
  }
  const expected = base64ToBytes(buildRelayPairingProof(opts));
  if (!expected || expected.length !== provided.length) {
    return false;
  }
  return nacl.verify(expected, provided);
}

export function buildRelayHandshakeProofPayload(): string {
  return JSON.stringify({
    method: RELAY_HANDSHAKE_PROOF_METHOD,
    params: {
      proof: "v1",
    },
  });
}

export function isRelayHandshakeProofPayload(rawMessage: string): boolean {
  try {
    const parsed = JSON.parse(rawMessage) as Record<string, unknown>;
    return typeof parsed.method === "string"
      && parsed.method === RELAY_HANDSHAKE_PROOF_METHOD
      && !("id" in parsed);
  } catch {
    return false;
  }
}

export function createRelaySharedKey(
  privateKeyBase64: string,
  peerPublicKeyBase64: string,
  sessionId: string,
): Uint8Array {
  const normalizedSessionId = sessionId.trim();
  if (!normalizedSessionId) {
    throw new Error("Invalid relay session id.");
  }
  const privateKeyBytes = base64ToBytes(privateKeyBase64);
  if (privateKeyBytes?.length !== nacl.box.secretKeyLength) {
    throw new Error("Invalid relay private key.");
  }
  const peerPublicKeyBytes = base64ToBytes(peerPublicKeyBase64);
  if (peerPublicKeyBytes?.length !== nacl.box.publicKeyLength) {
    throw new Error("Invalid relay peer public key.");
  }
  const baseSharedKey = nacl.box.before(peerPublicKeyBytes, privateKeyBytes);
  const sessionContextBytes = new TextEncoder().encode(`${RELAY_SESSION_KEY_CONTEXT}:${normalizedSessionId}`);
  const keyMaterial = new Uint8Array(sessionContextBytes.length + 1 + baseSharedKey.length);
  keyMaterial.set(sessionContextBytes, 0);
  keyMaterial[sessionContextBytes.length] = 0;
  keyMaterial.set(baseSharedKey, sessionContextBytes.length + 1);
  return nacl.hash(keyMaterial).subarray(0, nacl.secretbox.keyLength);
}

export function encodeRelaySecureEnvelope(opts: {
  sharedKey: Uint8Array;
  sender: RelayParticipantRole;
  counter: number;
  plaintext: string;
}): RelaySecureEnvelope {
  const nonce = nacl.randomBytes(nacl.secretbox.nonceLength);
  const plaintextBytes = new TextEncoder().encode(opts.plaintext);
  const ciphertext = nacl.secretbox(plaintextBytes, nonce, opts.sharedKey);
  return {
    kind: "secureEnvelope",
    v: RELAY_SECURE_ENVELOPE_VERSION,
    sender: opts.sender,
    counter: opts.counter,
    nonce: bytesToBase64(nonce),
    ciphertext: bytesToBase64(ciphertext),
  };
}

export function decodeRelaySecureEnvelope(opts: {
  sharedKey: Uint8Array;
  rawMessage: string;
  expectedSender: RelayParticipantRole;
  lastAcceptedCounter: number;
}): DecodeRelaySecureEnvelopeResult {
  const envelope = parseRelaySecureEnvelope(opts.rawMessage);
  if (!envelope) {
    return {
      ok: false,
      error: "Invalid relay secure envelope.",
    };
  }
  if (envelope.sender !== opts.expectedSender) {
    return {
      ok: false,
      error: `Unexpected secure envelope sender: ${envelope.sender}.`,
    };
  }
  if (envelope.counter <= opts.lastAcceptedCounter) {
    return {
      ok: false,
      error: "Rejected replayed secure relay message.",
    };
  }
  const nonceBytes = base64ToBytes(envelope.nonce);
  if (nonceBytes?.length !== nacl.secretbox.nonceLength) {
    return {
      ok: false,
      error: "Invalid relay nonce.",
    };
  }
  const ciphertextBytes = base64ToBytes(envelope.ciphertext);
  if (!ciphertextBytes || ciphertextBytes.length <= nacl.secretbox.overheadLength) {
    return {
      ok: false,
      error: "Invalid relay ciphertext.",
    };
  }
  const plaintextBytes = nacl.secretbox.open(ciphertextBytes, nonceBytes, opts.sharedKey);
  if (!plaintextBytes) {
    return {
      ok: false,
      error: "Unable to decrypt secure relay message.",
    };
  }
  const plaintext = new TextDecoder().decode(plaintextBytes);
  if (!isCoworkJsonRpcPayload(plaintext)) {
    return {
      ok: false,
      error: "Rejected invalid JSON-RPC payload from secure relay message.",
    };
  }
  return {
    ok: true,
    envelope,
    plaintext,
  };
}

export function parseRelaySecureEnvelope(rawMessage: string): RelaySecureEnvelope | null {
  try {
    return relaySecureEnvelopeSchema.parse(JSON.parse(rawMessage));
  } catch {
    return null;
  }
}

export function parseRelayControlMessage(rawMessage: string): RelayControlMessage | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawMessage);
  } catch {
    return null;
  }
  const macRegistrationResult = relayMacRegistrationSchema.safeParse(parsed);
  if (macRegistrationResult.success) {
    return {
      kind: "relayMacRegistration",
      registration: {
        sessionId: macRegistrationResult.data.registration.sessionId ?? null,
        macDeviceId: macRegistrationResult.data.registration.macDeviceId,
        macIdentityPublicKey: macRegistrationResult.data.registration.macIdentityPublicKey,
        displayName: macRegistrationResult.data.registration.displayName ?? null,
        trustedPhoneDeviceId: macRegistrationResult.data.registration.trustedPhoneDeviceId ?? null,
        trustedPhonePublicKey: macRegistrationResult.data.registration.trustedPhonePublicKey ?? null,
      },
    };
  }
  const clientHelloResult = relayClientHelloSchema.safeParse(parsed);
  if (clientHelloResult.success) {
    return {
      ...clientHelloResult.data,
      pairingProof: clientHelloResult.data.pairingProof ?? null,
    };
  }
  const secureReadyResult = relaySecureReadySchema.safeParse(parsed);
  if (secureReadyResult.success) {
    return secureReadyResult.data;
  }
  const secureErrorResult = relaySecureErrorSchema.safeParse(parsed);
  if (secureErrorResult.success) {
    return secureErrorResult.data;
  }
  const passthroughResult = relayPassthroughControlSchema.safeParse(parsed);
  if (passthroughResult.success) {
    return passthroughResult.data;
  }
  return null;
}

export function isCoworkJsonRpcPayload(rawMessage: string): boolean {
  try {
    const parsed = JSON.parse(rawMessage) as unknown;
    return jsonRpcRequestSchema.safeParse(parsed).success
      || jsonRpcResponseSchema.safeParse(parsed).success
      || jsonRpcNotificationSchema.safeParse(parsed).success;
  } catch {
    return false;
  }
}

export function computeRelayReconnectDelayMs(
  attempt: number,
  opts: {
    baseDelayMs?: number;
    maxDelayMs?: number;
    jitterRatio?: number;
    random?: () => number;
  } = {},
): number {
  const normalizedAttempt = Math.max(1, Math.floor(attempt));
  const baseDelayMs = Math.max(1, Math.floor(opts.baseDelayMs ?? 1_000));
  const maxDelayMs = Math.max(baseDelayMs, Math.floor(opts.maxDelayMs ?? 30_000));
  const jitterRatio = Math.max(0, Math.min(1, opts.jitterRatio ?? 0.2));
  const rawDelayMs = Math.min(maxDelayMs, baseDelayMs * (2 ** (normalizedAttempt - 1)));
  const jitterWindowMs = Math.floor(rawDelayMs * jitterRatio);
  const randomUnit = clampRandomUnit((opts.random ?? Math.random)());
  return Math.max(1, rawDelayMs - jitterWindowMs + Math.round(randomUnit * jitterWindowMs * 2));
}
