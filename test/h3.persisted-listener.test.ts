import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  __internal,
  clearPersistedH3ListenerIdentity,
  loadOrCreatePersistedQuicCertificate,
  persistH3ListenerPort,
  resolvePersistedH3Port,
} from "../src/server/transport/h3/persistedListener";
import type { EphemeralQuicCertificate } from "../src/shared/quicCert";

const roots: string[] = [];
async function makeStoreRoot(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "cowork-h3-persisted-"));
  roots.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("H3 persisted listener identity", () => {
  test("reuses a stored TLS certificate across load calls and rotates on forceRotate", async () => {
    const storeRootPath = await makeStoreRoot();
    const first = await loadOrCreatePersistedQuicCertificate(storeRootPath);
    const second = await loadOrCreatePersistedQuicCertificate(storeRootPath);

    expect(second.certSha256).toBe(first.certSha256);
    expect(second.spkiSha256).toBe(first.spkiSha256);
    expect(second.identityPub).toBe(first.identityPub);

    const rotated = await loadOrCreatePersistedQuicCertificate(storeRootPath, {
      forceRotate: true,
    });
    expect(rotated.certSha256).not.toBe(first.certSha256);
    expect(rotated.spkiSha256).not.toBe(first.spkiSha256);
  });

  test("keeps the paired certificate identity after a next-day restart", async () => {
    const storeRootPath = await makeStoreRoot();
    const first = await loadOrCreatePersistedQuicCertificate(storeRootPath);
    const nowSpy = spyOn(Date, "now").mockReturnValue(Date.now() + 24 * 60 * 60 * 1000);
    try {
      const restarted = await loadOrCreatePersistedQuicCertificate(storeRootPath);
      expect(restarted.certSha256).toBe(first.certSha256);
      expect(restarted.identityPub).toBe(first.identityPub);
    } finally {
      nowSpy.mockRestore();
    }
  });

  test("persists and reloads the preferred H3 listener port", async () => {
    const storeRootPath = await makeStoreRoot();
    expect(await resolvePersistedH3Port(storeRootPath)).toBe(0);

    await persistH3ListenerPort(storeRootPath, 9443);
    expect(await resolvePersistedH3Port(storeRootPath)).toBe(9443);

    const raw = await readFile(__internal.resolveListenerConfigPath(storeRootPath), "utf8");
    expect(JSON.parse(raw)).toEqual({ version: 1, port: 9443 });
  });

  test("treats certificates at or inside the five-minute renewal buffer as unusable", () => {
    const now = Date.parse("2026-09-11T12:00:00.000Z");
    const cert = (notAfter: string) => ({ notAfter }) as EphemeralQuicCertificate;

    for (const [offsetMs, expected] of [
      [__internal.CERT_RENEWAL_BUFFER_MS + 1, true],
      [__internal.CERT_RENEWAL_BUFFER_MS, false],
      [__internal.CERT_RENEWAL_BUFFER_MS - 1, false],
    ] as const) {
      expect(
        __internal.isCertificateUsable(cert(new Date(now + offsetMs).toISOString()), now),
      ).toBe(expected);
    }
    expect(__internal.isCertificateUsable(cert("not-a-date"), now)).toBe(false);
  });

  test("clearPersistedH3ListenerIdentity removes stored TLS material", async () => {
    const storeRootPath = await makeStoreRoot();
    await loadOrCreatePersistedQuicCertificate(storeRootPath);
    await clearPersistedH3ListenerIdentity(storeRootPath);
    const recreated = await loadOrCreatePersistedQuicCertificate(storeRootPath);
    expect(recreated.certPem.length).toBeGreaterThan(0);
  });
});
