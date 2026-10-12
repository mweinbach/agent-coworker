import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import {
  ArtifactFingerprintConflictError,
  ArtifactVersionStore,
} from "../../../src/server/tasks/ArtifactVersionStore";

const tempRoots: string[] = [];

async function createStore() {
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

    for (const invalid of ["not-a-hash", "", "a".repeat(63)]) {
      await expect(store.readBytes(invalid)).rejects.toThrow("Invalid artifact object SHA-256");
    }
    expect(() => store.getBlobPath(`${"a".repeat(64)}!`)).toThrow(
      "Invalid artifact object SHA-256",
    );
    await expect(fs.readdir(rootDir)).resolves.toEqual([]);
  });

  test("read and rewrite fail closed when a stored blob is tampered", async () => {
    const { store } = await createStore();
    const stored = await store.putBytes(Buffer.from("original bytes"));
    await fs.writeFile(store.getBlobPath(stored.sha256), "tampered bytes");

    const message = `Artifact object failed integrity validation: ${stored.sha256}`;
    await expect(store.readBytes(stored.sha256)).rejects.toThrow(message);
    await expect(store.putBytes(Buffer.from("original bytes"))).rejects.toThrow(message);
  });

  test("fingerprintFile returns null for missing paths and rejects directories", async () => {
    const { store, rootDir } = await createStore();
    const directory = path.join(rootDir, "not-a-file");
    await fs.mkdir(directory);

    await expect(store.fingerprintFile(path.join(rootDir, "missing.txt"))).resolves.toBeNull();
    await expect(store.fingerprintFile(directory)).rejects.toThrow(
      `Artifact is not a file: ${directory}`,
    );
  });

  test("restoreFile fails closed on conflicts or missing files and writes when fingerprint matches", async () => {
    const { store, rootDir } = await createStore();
    const stored = await store.putBytes(Buffer.from("restored bytes"));
    const livePath = path.join(rootDir, "workspace", "report.md");
    await fs.mkdir(path.dirname(livePath), { recursive: true });
    await fs.writeFile(livePath, "current bytes");
    const current = (await store.fingerprintFile(livePath))!;
    expect(current).not.toBeNull();

    const conflictPromise = store.restoreFile({
      blobSha256: stored.sha256,
      filePath: livePath,
      expectedFingerprint: "c".repeat(64),
    });
    await expect(conflictPromise).rejects.toBeInstanceOf(ArtifactFingerprintConflictError);
    await expect(conflictPromise).rejects.toMatchObject({
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

    const restored = await store.restoreFile({
      blobSha256: stored.sha256,
      filePath: livePath,
      expectedFingerprint: current.sha256,
    });
    expect(restored).toEqual({ sha256: stored.sha256, sizeBytes: stored.sizeBytes });
    expect(await fs.readFile(livePath, "utf8")).toBe("restored bytes");
  });

  test.each(["EBUSY", "EPERM"] as const)(
    "putBytes keeps a peer blob when exclusive copy fails with %s",
    async (code) => {
      const { store, rootDir } = await createStore();
      const payload = Buffer.from(`peer-owned-${code}`);
      const digest = createHash("sha256").update(payload).digest("hex");
      const blobPath = store.getBlobPath(digest);
      const copyFile = spyOn(fs, "copyFile").mockImplementation(async () => {
        await fs.writeFile(blobPath, payload);
        throw Object.assign(new Error(code), { code });
      });
      try {
        await expect(store.putBytes(payload)).resolves.toEqual({
          sha256: digest,
          sizeBytes: payload.byteLength,
        });
        const prefix = path.join(rootDir, "objects", "sha256", digest.slice(0, 2));
        expect((await fs.readdir(prefix)).filter((name) => name.includes(".tmp"))).toEqual([]);
      } finally {
        copyFile.mockRestore();
      }
    },
  );

  test("putBytes retries a locked blob read and then validates the peer bytes", async () => {
    const { store } = await createStore();
    const payload = Buffer.from("eventually visible");
    const digest = createHash("sha256").update(payload).digest("hex");
    const blobPath = store.getBlobPath(digest);
    const realReadFile = fs.readFile.bind(fs);
    let reads = 0;
    const readFile = spyOn(fs, "readFile").mockImplementation(async (filePath, options) => {
      if (filePath !== blobPath) return await realReadFile(filePath, options);
      reads += 1;
      if (reads === 1) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      if (reads === 2) throw Object.assign(new Error("EBUSY"), { code: "EBUSY" });
      if (reads === 3) throw Object.assign(new Error("EPERM"), { code: "EPERM" });
      await fs.writeFile(blobPath, payload);
      return await realReadFile(filePath, options);
    });
    const copyFile = spyOn(fs, "copyFile").mockImplementation(async () => {
      throw Object.assign(new Error("EBUSY"), { code: "EBUSY" });
    });
    try {
      await expect(store.putBytes(payload)).resolves.toEqual({
        sha256: digest,
        sizeBytes: payload.byteLength,
      });
      expect(reads).toBe(4);
    } finally {
      readFile.mockRestore();
      copyFile.mockRestore();
    }
  });

  test("putBytes does not retry a missing blob and surfaces a lock that never clears", async () => {
    const { store } = await createStore();
    const missing = Buffer.from("never published");
    const missingDigest = createHash("sha256").update(missing).digest("hex");
    const missingPath = store.getBlobPath(missingDigest);
    const locked = Buffer.from("stays locked");
    const lockedDigest = createHash("sha256").update(locked).digest("hex");
    const lockedPath = store.getBlobPath(lockedDigest);
    const realReadFile = fs.readFile.bind(fs);
    const reads = new Map<string, number>();
    const readFile = spyOn(fs, "readFile").mockImplementation(async (filePath, options) => {
      if (filePath !== missingPath && filePath !== lockedPath) {
        return await realReadFile(filePath, options);
      }
      const count = (reads.get(String(filePath)) ?? 0) + 1;
      reads.set(String(filePath), count);
      if (count === 1 || filePath === missingPath) {
        throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      }
      throw Object.assign(new Error("EBUSY"), { code: "EBUSY" });
    });
    const copyFile = spyOn(fs, "copyFile").mockImplementation(async () => {
      throw Object.assign(new Error("EPERM"), { code: "EPERM" });
    });
    try {
      await expect(store.putBytes(missing)).rejects.toMatchObject({ code: "ENOENT" });
      expect(reads.get(missingPath)).toBe(2);
      await expect(store.putBytes(locked)).rejects.toMatchObject({ code: "EBUSY" });
      expect(reads.get(lockedPath)).toBe(6);
    } finally {
      readFile.mockRestore();
      copyFile.mockRestore();
    }
  });

  test("putBytes rejects a peer blob whose bytes do not match the digest", async () => {
    const { store } = await createStore();
    const payload = Buffer.from("expected bytes");
    const digest = createHash("sha256").update(payload).digest("hex");
    const blobPath = store.getBlobPath(digest);
    const realReadFile = fs.readFile.bind(fs);
    let reads = 0;
    const readFile = spyOn(fs, "readFile").mockImplementation(async (filePath, options) => {
      if (filePath !== blobPath) return await realReadFile(filePath, options);
      reads += 1;
      if (reads === 1) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      return Buffer.from("corrupt bytes");
    });
    const copyFile = spyOn(fs, "copyFile").mockImplementation(async () => {
      throw Object.assign(new Error("EEXIST"), { code: "EEXIST" });
    });
    try {
      await expect(store.putBytes(payload)).rejects.toThrow(
        `Artifact object failed integrity validation: ${digest}`,
      );
      expect(reads).toBe(2);
    } finally {
      readFile.mockRestore();
      copyFile.mockRestore();
    }
  });

  test("putBytes propagates copy failures that are not a publish race", async () => {
    const { store, rootDir } = await createStore();
    const payload = Buffer.from("disk full");
    const digest = createHash("sha256").update(payload).digest("hex");
    const blobPath = store.getBlobPath(digest);
    const realReadFile = fs.readFile.bind(fs);
    let reads = 0;
    const readFile = spyOn(fs, "readFile").mockImplementation(async (filePath, options) => {
      if (filePath !== blobPath) return await realReadFile(filePath, options);
      reads += 1;
      throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    });
    const copyFile = spyOn(fs, "copyFile").mockImplementation(async () => {
      throw Object.assign(new Error("ENOSPC"), { code: "ENOSPC" });
    });
    try {
      await expect(store.putBytes(payload)).rejects.toMatchObject({ code: "ENOSPC" });
      expect(reads).toBe(1);
      const prefix = path.join(rootDir, "objects", "sha256", digest.slice(0, 2));
      expect((await fs.readdir(prefix)).filter((name) => name.includes(".tmp"))).toEqual([]);
    } finally {
      readFile.mockRestore();
      copyFile.mockRestore();
    }
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
