import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  forgetH3TrustedDevice,
  loadH3PairingStoreState,
  rememberH3TrustedDevice,
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
});
