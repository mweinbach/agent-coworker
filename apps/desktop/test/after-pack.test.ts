import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";

const require = createRequire(import.meta.url);
const afterPackModule = require("../scripts/afterPack.cjs") as {
  __private: {
    SANDBOX_BINARIES: string[];
    MANIFEST_NAME: string;
    writeSandboxHashManifest: (directory: string) => Promise<void>;
  };
};
const { MANIFEST_NAME, SANDBOX_BINARIES, writeSandboxHashManifest } = afterPackModule.__private;
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe("desktop afterPack trust manifest", () => {
  test("rehashes all sandbox helpers after signing changes their bytes", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cowork-after-pack-"));
    roots.push(root);
    for (const [index, name] of SANDBOX_BINARIES.entries()) {
      await fs.writeFile(path.join(root, name), `signed-helper-${index}`);
    }
    await fs.writeFile(
      path.join(root, MANIFEST_NAME),
      `${JSON.stringify({ schemaVersion: 1, rustTarget: "x86_64-pc-windows-msvc", files: {} })}\n`,
    );

    await writeSandboxHashManifest(root);

    const manifest = JSON.parse(await fs.readFile(path.join(root, MANIFEST_NAME), "utf8"));
    expect(manifest.rustTarget).toBe("x86_64-pc-windows-msvc");
    for (const [index, name] of SANDBOX_BINARIES.entries()) {
      expect(manifest.files[name]).toBe(
        createHash("sha256").update(`signed-helper-${index}`).digest("hex"),
      );
    }
  });

  test("fails packaging when any trusted helper is absent", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cowork-after-pack-"));
    roots.push(root);
    await fs.writeFile(path.join(root, SANDBOX_BINARIES[0]!), "helper");
    await fs.writeFile(path.join(root, MANIFEST_NAME), '{"schemaVersion":1,"files":{}}\n');
    await expect(writeSandboxHashManifest(root)).rejects.toThrow("Missing packaged");
  });
});
