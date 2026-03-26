import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const {
  forgetRemodexTrustedPhoneRecord,
  readRemodexStateResult,
  readResolvedRemodexState,
  rememberRemodexTrustedPhoneRecord,
  resolveRemodexStateDir,
} = await import("../electron/services/remodexState");

describe("remodex state reader", () => {
  let tmpDir = "";

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "cowork-remodex-reader-"));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
    tmpDir = "";
  });

  test("resolves the remodex state dir from env override", () => {
    expect(resolveRemodexStateDir({
      env: { REMODEX_DEVICE_STATE_DIR: "/tmp/remodex-env" } as NodeJS.ProcessEnv,
      homeDir: "/Users/tester",
    })).toBe("/tmp/remodex-env");
  });

  test("reads valid remodex state and extracts the trusted phone", async () => {
    await writeRemodexState(tmpDir);

    const result = readRemodexStateResult({ stateDir: tmpDir });
    const state = readResolvedRemodexState({ stateDir: tmpDir });

    expect(result.status).toBe("resolved");
    expect(state.relayUrl).toBe("wss://api.phodex.app/relay");
    expect(state.serviceStatus).toBe("running");
    expect(state.identityState.macDeviceId).toBe("mac-1");
    expect(state.identityState.trustedPhone?.phoneDeviceId).toBe("phone-1");
    expect(state.pairingSession?.pairingPayload?.sessionId).toBe("remodex-session");
  });

  test("classifies a fully absent remodex state as missing", async () => {
    const result = readRemodexStateResult({ stateDir: tmpDir });

    expect(result).toMatchObject({
      status: "missing",
      stateDir: tmpDir,
    });
    await expect(async () => readResolvedRemodexState({ stateDir: tmpDir })).toThrow(
      "Remodex daemon config is missing or unreadable",
    );
  });

  test("classifies partial remodex state as invalid", async () => {
    await fs.mkdir(tmpDir, { recursive: true });
    await fs.writeFile(path.join(tmpDir, "daemon-config.json"), JSON.stringify({
      relayUrl: "wss://api.phodex.app/relay",
    }, null, 2));

    const result = readRemodexStateResult({ stateDir: tmpDir });

    expect(result).toMatchObject({
      status: "invalid",
      stateDir: tmpDir,
    });
    expect(result.errorMessage).toContain("Remodex device state is missing or unreadable");
  });

  test("throws when device state is invalid", async () => {
    await fs.mkdir(tmpDir, { recursive: true });
    await fs.writeFile(path.join(tmpDir, "daemon-config.json"), JSON.stringify({
      relayUrl: "wss://api.phodex.app/relay",
    }, null, 2));
    await fs.writeFile(path.join(tmpDir, "device-state.json"), "{not-json");

    const result = readRemodexStateResult({ stateDir: tmpDir });

    expect(result.status).toBe("invalid");
    await expect(async () => readResolvedRemodexState({ stateDir: tmpDir })).toThrow(
      "Remodex device state is missing or unreadable",
    );
  });

  test("persists trusted-phone updates back into remodex device state", async () => {
    await writeRemodexState(tmpDir, {});

    const remembered = await rememberRemodexTrustedPhoneRecord({
      phoneDeviceId: "phone-2",
      phoneIdentityPublicKey: Buffer.from("phone-2-public-key").toString("base64"),
    }, {
      stateDir: tmpDir,
      now: () => new Date("2026-03-25T18:00:00.000Z"),
    });

    expect(remembered.trustedPhone?.phoneDeviceId).toBe("phone-2");

    const rawDeviceState = JSON.parse(await fs.readFile(path.join(tmpDir, "device-state.json"), "utf8"));
    expect(rawDeviceState.trustedPhones["phone-2"]).toBe(Buffer.from("phone-2-public-key").toString("base64"));

    const forgotten = await forgetRemodexTrustedPhoneRecord("phone-2", { stateDir: tmpDir });
    expect(forgotten.trustedPhone?.phoneDeviceId).toBe("phone-1");
  });
});

async function writeRemodexState(
  stateDir: string,
  overrides: {
    trustedPhones?: Record<string, string>;
  } = {},
) {
  await fs.mkdir(stateDir, { recursive: true });
  await fs.writeFile(path.join(stateDir, "daemon-config.json"), JSON.stringify({
    relayUrl: "wss://api.phodex.app/relay",
  }, null, 2));
  await fs.writeFile(path.join(stateDir, "bridge-status.json"), JSON.stringify({
    state: "running",
    connectionStatus: "connected",
    lastError: "",
    updatedAt: "2026-03-25T17:00:00.000Z",
  }, null, 2));
  await fs.writeFile(path.join(stateDir, "device-state.json"), JSON.stringify({
    version: 1,
    macDeviceId: "mac-1",
    macIdentityPublicKey: Buffer.from("mac-public-key").toString("base64"),
    macIdentityPrivateKey: Buffer.from("mac-private-key").toString("base64"),
    trustedPhones: overrides.trustedPhones ?? {
      "phone-1": Buffer.from("phone-1-public-key").toString("base64"),
    },
  }, null, 2));
  await fs.writeFile(path.join(stateDir, "pairing-session.json"), JSON.stringify({
    createdAt: "2026-03-25T17:00:00.000Z",
    pairingPayload: {
      v: 2,
      relay: "wss://api.phodex.app/relay",
      sessionId: "remodex-session",
      macDeviceId: "mac-1",
      macIdentityPublicKey: Buffer.from("mac-public-key").toString("base64"),
      expiresAt: 1_700_000_000_000,
    },
  }, null, 2));
}
