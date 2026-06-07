import { describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { ResearchFileStore } from "../../src/server/research/researchFileStore";

async function makeStore(): Promise<{ root: string; store: ResearchFileStore }> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cowork-research-store-"));
  return { root, store: new ResearchFileStore({ rootDir: root }) };
}

describe("ResearchFileStore.readPendingUpload", () => {
  test("round-trips a legitimately saved pending upload", async () => {
    const { root, store } = await makeStore();
    try {
      const saved = await store.savePendingUpload({
        filename: "notes.txt",
        mimeType: "text/plain",
        contentBase64: Buffer.from("hello").toString("base64"),
      });
      const read = await store.readPendingUpload(saved.fileId);
      expect(read).not.toBeNull();
      expect(read?.fileId).toBe(saved.fileId);
      expect(read?.path).toBe(saved.path);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  test("rejects non-UUID and path-traversal ids without reading outside uploads", async () => {
    const { root, store } = await makeStore();
    try {
      // Plant a secret and a spoofed metadata JSON reachable by traversal from uploads.
      const secret = path.join(root, "secret.txt");
      await fs.writeFile(secret, "TOP SECRET");
      const researchDir = path.join(root, "research");
      await fs.mkdir(researchDir, { recursive: true });
      await fs.writeFile(
        path.join(researchDir, "spoof.json"),
        JSON.stringify({
          version: 1,
          file: {
            fileId: "spoof",
            filename: "secret.txt",
            mimeType: "text/plain",
            path: secret,
            uploadedAt: new Date().toISOString(),
          },
        }),
      );
      // uploadsDir is <root>/research/uploads; "../spoof" -> <root>/research/spoof.json
      expect(await store.readPendingUpload("../spoof")).toBeNull();
      expect(await store.readPendingUpload("spoof")).toBeNull();
      expect(await store.readPendingUpload("../../etc/passwd")).toBeNull();
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  test("rejects spoofed metadata whose recorded path escapes the uploads directory", async () => {
    const { root, store } = await makeStore();
    try {
      const secret = path.join(root, "outside-secret.txt");
      await fs.writeFile(secret, "TOP SECRET");
      const uploadsDir = store.uploadsDir();
      await fs.mkdir(uploadsDir, { recursive: true });
      const fileId = crypto.randomUUID();
      // Valid id + shape, but the recorded path points OUTSIDE the uploads dir.
      await fs.writeFile(
        path.join(uploadsDir, `${fileId}.json`),
        JSON.stringify({
          version: 1,
          file: {
            fileId,
            filename: "secret.txt",
            mimeType: "text/plain",
            path: secret,
            uploadedAt: new Date().toISOString(),
          },
        }),
      );
      expect(await store.readPendingUpload(fileId)).toBeNull();
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  test("rejects metadata whose recorded id does not match the request", async () => {
    const { root, store } = await makeStore();
    try {
      const uploadsDir = store.uploadsDir();
      await fs.mkdir(uploadsDir, { recursive: true });
      const fileId = crypto.randomUUID();
      const otherId = crypto.randomUUID();
      await fs.writeFile(
        path.join(uploadsDir, `${fileId}.json`),
        JSON.stringify({
          version: 1,
          file: {
            fileId: otherId,
            filename: "notes.txt",
            mimeType: "text/plain",
            path: path.join(uploadsDir, `${otherId}-notes.txt`),
            uploadedAt: new Date().toISOString(),
          },
        }),
      );
      expect(await store.readPendingUpload(fileId)).toBeNull();
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
