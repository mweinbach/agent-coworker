import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import path from "node:path";

import { removeWithRetry } from "../../src/platform/fs";
import { scratchRoots } from "../../src/platform/sandbox";
import { __internal as webFetchInternal } from "../../src/tools/webFetch";

const temporaryDirectories: string[] = [];

async function makeTempDir(): Promise<string> {
  const directory = await fs.mkdtemp(
    path.join(scratchRoots()[0] ?? "/tmp", "cowork-webfetch-finalize-"),
  );
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  while (temporaryDirectories.length > 0) {
    const directory = temporaryDirectories.pop();
    if (directory) await removeWithRetry(directory, { recursive: true, bestEffort: true });
  }
});

describe("webFetch finalize mutation-gate rollback", () => {
  test("removes the copied destination when the post-copy gate closes", async () => {
    const downloadDir = await makeTempDir();
    const tempPath = path.join(downloadDir, "report.pdf.part");
    const destination = path.join(downloadDir, "report.pdf");
    await fs.writeFile(tempPath, "fresh payload", "utf-8");
    let checks = 0;

    await expect(
      webFetchInternal.finalizeDownloadedFile(tempPath, downloadDir, "report.pdf", () => {
        checks += 1;
        if (checks > 1) throw new Error("gate closed after copy");
      }),
    ).rejects.toThrow("gate closed after copy");

    expect(checks).toBe(2);
    await expect(fs.stat(destination)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await fs.readFile(tempPath, "utf-8")).toBe("fresh payload");
  });

  test("does not copy when the pre-copy gate closes", async () => {
    const downloadDir = await makeTempDir();
    const tempPath = path.join(downloadDir, "report.pdf.part");
    await fs.writeFile(tempPath, "fresh payload", "utf-8");

    await expect(
      webFetchInternal.finalizeDownloadedFile(tempPath, downloadDir, "report.pdf", () => {
        throw new Error("gate closed before copy");
      }),
    ).rejects.toThrow("gate closed before copy");

    await expect(fs.stat(path.join(downloadDir, "report.pdf"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(await fs.readFile(tempPath, "utf-8")).toBe("fresh payload");
  });
});
