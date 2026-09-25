import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import path from "node:path";

import {
  ArtifactFingerprintConflictError,
  ArtifactVersionStore,
} from "../../../src/server/tasks/ArtifactVersionStore";

const tempRoots: string[] = [];

async function createStore(): Promise<{ store: ArtifactVersionStore; rootDir: string }> {
  const rootDir = path.join(import.meta.dir, `.artifact-store-${crypto.randomUUID()}`);
  await fs.mkdir(rootDir, { recursive: true });
  tempRoots.push(rootDir);
  return { store: new ArtifactVersionStore({ rootDir }), rootDir };
}

afterEach(async () => {
  await Promise.all(
    tempRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});

describe("ArtifactVersionStore", () => {
  test("rejects invalid SHA-256 keys before touching the object store", async () => {
    const { store, rootDir } = await createStore();

    await expect(store.readBytes("not-a-hash")).rejects.toThrow("Invalid artifact object SHA-256");
    await expect(store.readBytes("")).rejects.toThrow("Invalid artifact object SHA-256");
    await expect(store.readBytes("a".repeat(63))).rejects.toThrow(
      "Invalid artifact object SHA-256",
    );
    expect(() => store.getBlobPath(`${"a".repeat(64)}!`)).toThrow(
      "Invalid artifact object SHA-256",
    );
    await expect(fs.readdir(rootDir)).resolves.toEqual([]);
  });

  test("read and rewrite fail closed when a stored blob is tampered", async () => {
    const { store } = await createStore();
    const stored = await store.putBytes(Buffer.from("original bytes"));
    await fs.writeFile(store.getBlobPath(stored.sha256), "tampered bytes");

    await expect(store.readBytes(stored.sha256)).rejects.toThrow(
      `Artifact object failed integrity validation: ${stored.sha256}`,
    );
    await expect(store.putBytes(Buffer.from("original bytes"))).rejects.toThrow(
      `Artifact object failed integrity validation: ${stored.sha256}`,
    );
  });

  test("fingerprintFile returns null for missing paths and rejects directories", async () => {
    const { store, rootDir } = await createStore();
    const missing = path.join(rootDir, "missing.txt");
    const directory = path.join(rootDir, "not-a-file");
    await fs.mkdir(directory);

    await expect(store.fingerprintFile(missing)).resolves.toBeNull();
    await expect(store.fingerprintFile(directory)).rejects.toThrow(
      `Artifact is not a file: ${directory}`,
    );
  });

  test("restoreFile fails closed on fingerprint conflicts and missing expected files", async () => {
    const { store, rootDir } = await createStore();
    const stored = await store.putBytes(Buffer.from("restored bytes"));
    const livePath = path.join(rootDir, "workspace", "report.md");
    await fs.mkdir(path.dirname(livePath), { recursive: true });
    await fs.writeFile(livePath, "current bytes");
    const current = await store.fingerprintFile(livePath);
    if (!current) throw new Error("Expected live fingerprint");

    await expect(
      store.restoreFile({
        blobSha256: stored.sha256,
        filePath: livePath,
        expectedFingerprint: "c".repeat(64),
      }),
    ).rejects.toBeInstanceOf(ArtifactFingerprintConflictError);
    await expect(
      store.restoreFile({
        blobSha256: stored.sha256,
        filePath: livePath,
        expectedFingerprint: "c".repeat(64),
      }),
    ).rejects.toMatchObject({
      expectedFingerprint: "c".repeat(64),
      actualFingerprint: current.sha256,
    });
    expect(await fs.readFile(livePath, "utf8")).toBe("current bytes");

    const missingPath = path.join(rootDir, "workspace", "missing.md");
    await expect(
      store.restoreFile({
        blobSha256: stored.sha256,
        filePath: missingPath,
        expectedFingerprint: current.sha256,
      }),
    ).rejects.toMatchObject({
      name: "ArtifactFingerprintConflictError",
      expectedFingerprint: current.sha256,
      actualFingerprint: null,
    });
    await expect(fs.stat(missingPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("restoreFile writes stored bytes when the expected fingerprint matches", async () => {
    const { store, rootDir } = await createStore();
    const stored = await store.putBytes(Buffer.from("restored bytes"));
    const livePath = path.join(rootDir, "workspace", "report.md");
    await fs.mkdir(path.dirname(livePath), { recursive: true });
    await fs.writeFile(livePath, "current bytes");
    const current = await store.fingerprintFile(livePath);
    if (!current) throw new Error("Expected live fingerprint");

    const restored = await store.restoreFile({
      blobSha256: stored.sha256,
      filePath: livePath,
      expectedFingerprint: current.sha256,
    });

    expect(restored).toEqual({ sha256: stored.sha256, sizeBytes: stored.sizeBytes });
    expect(await fs.readFile(livePath, "utf8")).toBe("restored bytes");
  });

  test("concurrent putBytes of the same digest stays idempotent", async () => {
    const { store } = await createStore();
    const payload = Buffer.from("same concurrent bytes");

    const [first, second, third] = await Promise.all([
      store.putBytes(payload),
      store.putBytes(payload),
      store.putBytes(Buffer.from("same concurrent bytes")),
    ]);

    expect(second).toEqual(first);
    expect(third).toEqual(first);
    expect(Buffer.from(await store.readBytes(first.sha256)).toString("utf8")).toBe(
      "same concurrent bytes",
    );
  });
});
