import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  forgetH3TrustedDevice,
  loadH3PairingStoreState,
  rememberH3TrustedDevice,
  resolveH3PairingStoreDir,
  updateH3TrustedDevicePermissions,
  verifyH3SessionToken,
} from "../src/server/transport/h3/pairing";

const tempRoots: string[] = [];

async function createTempRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "cowork-h3-pairing-"));
  tempRoots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("H3 pairing store", () => {
  test("does not resurrect a trusted device when auth races with revocation", async () => {
    const storeRoot = await createTempRoot();
    const sessionToken = "session-token";

    await rememberH3TrustedDevice(storeRoot, {
      deviceId: "phone-1",
      identityPub: "phone-identity",
      displayName: "Phone",
      sessionToken,
    });

    await expect(verifyH3SessionToken(storeRoot, sessionToken, "phone-1")).resolves.toMatchObject({
      deviceId: "phone-1",
    });
    await expect(verifyH3SessionToken(storeRoot, sessionToken, "phone-2")).resolves.toBeNull();
    await expect(verifyH3SessionToken(storeRoot, sessionToken, null)).resolves.toBeNull();

    const [verified, removed] = await Promise.all([
      verifyH3SessionToken(storeRoot, sessionToken),
      forgetH3TrustedDevice(storeRoot, "phone-1"),
    ]);

    expect(verified?.deviceId).toBe("phone-1");
    expect(removed).toBe(true);
    await expect(loadH3PairingStoreState(storeRoot)).resolves.toEqual({
      version: 1,
      trustedDevices: [],
    });
  });

  test("preserves trusted device permissions when the same device re-pairs", async () => {
    const storeRoot = await createTempRoot();

    await rememberH3TrustedDevice(storeRoot, {
      deviceId: "phone-1",
      identityPub: "phone-identity",
      displayName: "Phone",
      sessionToken: "old-session-token",
    });
    await expect(
      updateH3TrustedDevicePermissions(storeRoot, "phone-1", {
        turns: true,
        providerAuth: true,
        mcpAuth: true,
      }),
    ).resolves.toMatchObject({
      deviceId: "phone-1",
      permissions: {
        turns: true,
        providerAuth: true,
        mcpAuth: true,
      },
    });

    await rememberH3TrustedDevice(storeRoot, {
      deviceId: "phone-1",
      identityPub: "phone-identity",
      displayName: "Phone",
      sessionToken: "new-session-token",
    });

    await expect(loadH3PairingStoreState(storeRoot)).resolves.toMatchObject({
      version: 1,
      trustedDevices: [
        {
          deviceId: "phone-1",
          permissions: {
            turns: true,
            serverRequests: false,
            providerAuth: true,
            mcpAuth: true,
            workspaceSettings: false,
            backups: false,
          },
        },
      ],
    });
    await expect(
      verifyH3SessionToken(storeRoot, "new-session-token", "phone-1"),
    ).resolves.toMatchObject({
      deviceId: "phone-1",
      permissions: {
        providerAuth: true,
        mcpAuth: true,
      },
    });
  });

  test("newly paired devices default to no conversations (thread-read) access", async () => {
    const storeRoot = await createTempRoot();
    const device = await rememberH3TrustedDevice(storeRoot, {
      deviceId: "fresh-phone",
      identityPub: "fresh-identity",
      displayName: "Fresh Phone",
      sessionToken: "fresh-token",
    });
    expect(device.permissions.conversations).toBe(false);
    const loaded = await loadH3PairingStoreState(storeRoot);
    expect(
      loaded.trustedDevices.find((entry) => entry.deviceId === "fresh-phone")?.permissions
        .conversations,
    ).toBe(false);
  });

  test("grandfathers thread-read access for devices paired before the conversations permission", async () => {
    const storeRoot = await createTempRoot();
    await rememberH3TrustedDevice(storeRoot, {
      deviceId: "legacy-phone",
      identityPub: "legacy-identity",
      displayName: "Legacy Phone",
      sessionToken: "legacy-token",
    });

    // Emulate a record persisted before the `conversations` permission existed:
    // thread reads were always-allowed, so the stored record has no such key.
    const devicesFile = path.join(resolveH3PairingStoreDir(storeRoot), "devices.json");
    const state = JSON.parse(await readFile(devicesFile, "utf8")) as {
      version: number;
      trustedDevices: Array<{ deviceId: string; permissions: Record<string, boolean> }>;
    };
    const stored = state.trustedDevices.find((entry) => entry.deviceId === "legacy-phone");
    if (!stored) throw new Error("expected stored legacy device");
    delete stored.permissions.conversations;
    await writeFile(devicesFile, JSON.stringify(state, null, 2), "utf8");

    const loaded = await loadH3PairingStoreState(storeRoot);
    expect(
      loaded.trustedDevices.find((entry) => entry.deviceId === "legacy-phone")?.permissions
        .conversations,
    ).toBe(true);
    // The grandfathered permission flows through session verification (used by the gate).
    await expect(
      verifyH3SessionToken(storeRoot, "legacy-token", "legacy-phone"),
    ).resolves.toMatchObject({ permissions: { conversations: true } });
  });
});
