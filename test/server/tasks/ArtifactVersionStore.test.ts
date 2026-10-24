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

function errno(code: string): NodeJS.ErrnoException {
  const error = new Error(code) as NodeJS.ErrnoException;
  error.code = code;
  return error;
}

function digestFor(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function blobNames(blobPath: string): Promise<string[]> {
  return await fs.readdir(path.dirname(blobPath)).catch(() => []);
}

describe("ArtifactVersionStore publication locks", () => {
  test.each(["EBUSY", "EPERM"] as const)(
    "keeps a matching object when exclusive copy fails with %s",
    async (code) => {
      const { store } = await createStore();
      const payload = Buffer.from(`published despite ${code}`);
      const digest = digestFor(payload);
      const blobPath = store.getBlobPath(digest);
      const copy = spyOn(fs, "copyFile").mockImplementation(async (source, dest) => {
        if (String(dest) !== blobPath) return;
        await fs.writeFile(dest, await fs.readFile(source));
        throw errno(code);
      });

      try {
        await expect(store.putBytes(payload)).resolves.toEqual({
          sha256: digest,
          sizeBytes: payload.byteLength,
        });
        expect(copy).toHaveBeenCalledTimes(1);
      } finally {
        copy.mockRestore();
      }
      expect(Buffer.from(await store.readBytes(digest)).equals(payload)).toBe(true);
      expect((await blobNames(blobPath)).filter((name) => name.endsWith(".tmp"))).toEqual([]);
    },
  );

  test("fails closed when exclusive copy fails for a non-lock error", async () => {
    const { store } = await createStore();
    const payload = Buffer.from("copy must not publish");
    const blobPath = store.getBlobPath(digestFor(payload));
    const copy = spyOn(fs, "copyFile").mockImplementation(async () => {
      throw Object.assign(new Error("numeric"), { code: 16 });
    });

    try {
      await expect(store.putBytes(payload)).rejects.toMatchObject({ code: 16 });
    } finally {
      copy.mockRestore();
    }

    expect(await blobNames(blobPath)).not.toContain(digestFor(payload));
    expect((await blobNames(blobPath)).some((name) => name.endsWith(".tmp"))).toBe(false);
  });

  test("retries a locked object read and then validates the bytes", async () => {
    const { store } = await createStore();
    const payload = Buffer.from("readable after lock");
    const digest = digestFor(payload);
    const blobPath = store.getBlobPath(digest);
    let lockedReads = 0;
    const originalRead = fs.readFile.bind(fs);
    const read = spyOn(fs, "readFile").mockImplementation(async (target, options) => {
      if (String(target) === blobPath) {
        try {
          await fs.stat(target);
        } catch (error) {
          const missing = error as NodeJS.ErrnoException;
          if (missing.code === "ENOENT") return originalRead(target, options);
          throw error;
        }
        lockedReads += 1;
        if (lockedReads <= 2) throw errno("EPERM");
      }
      return originalRead(target, options);
    });

    try {
      await expect(store.putBytes(payload)).resolves.toEqual({
        sha256: digest,
        sizeBytes: payload.byteLength,
      });
    } finally {
      read.mockRestore();
    }

    expect(lockedReads).toBe(3);
    expect(Buffer.from(await store.readBytes(digest)).equals(payload)).toBe(true);
  });

  test("stops retrying a locked object read after five attempts", async () => {
    const { store } = await createStore();
    const payload = Buffer.from("still locked");
    const blobPath = store.getBlobPath(digestFor(payload));
    let lockedReads = 0;
    const originalRead = fs.readFile.bind(fs);
    const read = spyOn(fs, "readFile").mockImplementation(async (target, options) => {
      if (String(target) === blobPath) {
        try {
          await fs.stat(target);
        } catch (error) {
          const missing = error as NodeJS.ErrnoException;
          if (missing.code === "ENOENT") return originalRead(target, options);
          throw error;
        }
        lockedReads += 1;
        throw errno("EBUSY");
      }
      return originalRead(target, options);
    });

    try {
      await expect(store.putBytes(payload)).rejects.toMatchObject({ code: "EBUSY" });
    } finally {
      read.mockRestore();
    }

    expect(lockedReads).toBe(5);
  });

  test("does not retry a missing object after publication", async () => {
    const { store } = await createStore();
    const payload = Buffer.from("disappeared");
    const blobPath = store.getBlobPath(digestFor(payload));
    let missingReads = 0;
    const originalRead = fs.readFile.bind(fs);
    const read = spyOn(fs, "readFile").mockImplementation(async (target, options) => {
      if (String(target) === blobPath) {
        try {
          await fs.stat(target);
        } catch (error) {
          const missing = error as NodeJS.ErrnoException;
          if (missing.code === "ENOENT") return originalRead(target, options);
          throw error;
        }
        missingReads += 1;
        throw errno("ENOENT");
      }
      return originalRead(target, options);
    });

    try {
      await expect(store.putBytes(payload)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      read.mockRestore();
    }

    expect(missingReads).toBe(1);
  });

  test("publishes when chmod of the stored object is denied", async () => {
    const { store } = await createStore();
    const payload = Buffer.from("chmod denied");
    const chmod = spyOn(fs, "chmod").mockRejectedValue(errno("EPERM"));

    try {
      const stored = await store.putBytes(payload);
      expect(chmod).toHaveBeenCalledTimes(1);
      expect(stored.sizeBytes).toBe(payload.byteLength);
      expect(Buffer.from(await store.readBytes(stored.sha256)).equals(payload)).toBe(true);
    } finally {
      chmod.mockRestore();
    }
  });

  test("fingerprintFile rethrows permission errors", async () => {
    const { store, rootDir } = await createStore();
    const stat = spyOn(fs, "stat").mockRejectedValue(errno("EACCES"));

    try {
      await expect(store.fingerprintFile(path.join(rootDir, "report.md"))).rejects.toMatchObject({
        code: "EACCES",
      });
    } finally {
      stat.mockRestore();
    }
  });
});
