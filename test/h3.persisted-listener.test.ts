import { describe, expect, test } from "bun:test";
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

describe("H3 persisted listener identity", () => {
  test("reuses a stored TLS certificate across load calls", async () => {
    const storeRootPath = await mkdtemp(path.join(tmpdir(), "cowork-h3-persisted-"));
    try {
      const first = await loadOrCreatePersistedQuicCertificate(storeRootPath);
      const second = await loadOrCreatePersistedQuicCertificate(storeRootPath);

      expect(second.certSha256).toBe(first.certSha256);
      expect(second.spkiSha256).toBe(first.spkiSha256);
      expect(second.identityPub).toBe(first.identityPub);
    } finally {
      await rm(storeRootPath, { recursive: true, force: true });
    }
  });

  test("rotates the stored TLS certificate when forceRotate is requested", async () => {
    const storeRootPath = await mkdtemp(path.join(tmpdir(), "cowork-h3-persisted-"));
    try {
      const first = await loadOrCreatePersistedQuicCertificate(storeRootPath);
      const rotated = await loadOrCreatePersistedQuicCertificate(storeRootPath, {
        forceRotate: true,
      });

      expect(rotated.certSha256).not.toBe(first.certSha256);
      expect(rotated.spkiSha256).not.toBe(first.spkiSha256);
    } finally {
      await rm(storeRootPath, { recursive: true, force: true });
    }
  });

  test("persists and reloads the preferred H3 listener port", async () => {
    const storeRootPath = await mkdtemp(path.join(tmpdir(), "cowork-h3-persisted-"));
    try {
      expect(await resolvePersistedH3Port(storeRootPath)).toBe(0);

      await persistH3ListenerPort(storeRootPath, 9443);
      expect(await resolvePersistedH3Port(storeRootPath)).toBe(9443);

      const raw = await readFile(__internal.resolveListenerConfigPath(storeRootPath), "utf8");
      expect(JSON.parse(raw)).toEqual({ version: 1, port: 9443 });
    } finally {
      await rm(storeRootPath, { recursive: true, force: true });
    }
  });

  test("clearPersistedH3ListenerIdentity removes stored TLS material", async () => {
    const storeRootPath = await mkdtemp(path.join(tmpdir(), "cowork-h3-persisted-"));
    try {
      await loadOrCreatePersistedQuicCertificate(storeRootPath);
      await clearPersistedH3ListenerIdentity(storeRootPath);
      const recreated = await loadOrCreatePersistedQuicCertificate(storeRootPath);
      expect(recreated.certPem.length).toBeGreaterThan(0);
    } finally {
      await rm(storeRootPath, { recursive: true, force: true });
    }
  });
});
