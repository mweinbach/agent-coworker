import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import { buildServerBinary } from "../scripts/build_cowork_server_binary";
import { scratchRoots } from "../src/platform/sandbox/policy";
import {
  WINDOWS_SANDBOX_COMMAND_RUNNER_NAME,
  WINDOWS_SANDBOX_HASH_MANIFEST_NAME,
  WINDOWS_SANDBOX_HELPER_NAME,
  WINDOWS_SANDBOX_SETUP_NAME,
} from "../src/platform/sandbox/windows";

describe("standalone server bundles", () => {
  test("rejects repository-root output before compiling or deleting source resources", async () => {
    const root = await fs.mkdtemp(path.join(scratchRoots()[0], "cowork-server-build-"));
    const source = path.join(root, "prompts", "system.md");
    let compiled = false;
    try {
      await fs.mkdir(path.dirname(source), { recursive: true });
      await fs.writeFile(source, "protected source");

      const failure = await buildServerBinary({
        root,
        argv: ["--outfile", "cowork-server", "--platform", "linux", "--arch", "x64"],
        commandRunner: async () => {
          compiled = true;
        },
      }).then(
        () => null,
        (error: unknown) => error,
      );

      expect(await fs.readFile(source, "utf8").catch(() => null)).toBe("protected source");
      expect(compiled).toBe(false);
      expect(failure).toBeInstanceOf(Error);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  test.each(["prompts/generated", "src/generated", "build-link"])(
    "rejects unsafe output through %s before creating build directories",
    async (directory) => {
      const root = await fs.mkdtemp(path.join(scratchRoots()[0], "cowork-server-build-"));
      let compiled = false;
      try {
        await fs.mkdir(path.join(root, "prompts"));
        await fs.writeFile(path.join(root, "prompts", "system.md"), "protected source");
        if (directory === "build-link") {
          await fs.symlink(root, path.join(root, directory), "junction");
        }
        const outfile = path.join(root, directory, "cowork-server");
        await expect(
          buildServerBinary({
            root,
            argv: ["--outfile", outfile, "--platform", "linux", "--arch", "x64"],
            commandRunner: async () => {
              compiled = true;
            },
          }),
        ).rejects.toThrow("Unsafe server bundle output");
        expect(compiled).toBe(false);
        expect(await fs.readFile(path.join(root, "prompts", "system.md"), "utf8")).toBe(
          "protected source",
        );
        await expect(fs.stat(outfile)).rejects.toThrow();
        if (directory !== "build-link") {
          await expect(fs.stat(path.dirname(outfile))).rejects.toThrow();
        }
      } finally {
        await fs.rm(root, { recursive: true, force: true });
      }
    },
  );

  test.each([
    { arch: "x64", rustTarget: "x86_64-pc-windows-msvc" },
    { arch: "arm64", rustTarget: "aarch64-pc-windows-msvc" },
  ])("stages a complete sandbox bundle for Windows $arch", async ({ arch, rustTarget }) => {
    const root = await fs.mkdtemp(path.join(scratchRoots()[0], "cowork-server-windows-"));
    const binaryNames = [
      WINDOWS_SANDBOX_HELPER_NAME,
      WINDOWS_SANDBOX_SETUP_NAME,
      WINDOWS_SANDBOX_COMMAND_RUNNER_NAME,
    ];
    const outfile = path.join(root, "dist", "bundle", "cowork-server.exe");
    const commands: string[][] = [];
    try {
      await fs.mkdir(path.join(root, "prompts"));
      await fs.writeFile(path.join(root, "prompts", "system.md"), "bundled prompt");

      await buildServerBinary({
        root,
        argv: ["--outfile", outfile, "--platform", "win32", "--arch", arch],
        commandRunner: async (command) => {
          commands.push(command);
          if (command.includes("--compile")) {
            await fs.writeFile(outfile, "native server");
          }
          if (command[0] === "cargo") {
            const releaseDir = path.join(
              root,
              "crates",
              "cowork-win-sandbox",
              "target",
              rustTarget,
              "release",
            );
            await fs.mkdir(releaseDir, { recursive: true });
            for (const name of binaryNames) await fs.writeFile(path.join(releaseDir, name), name);
          }
        },
      });

      const outputDir = path.dirname(outfile);
      const manifest = JSON.parse(
        await fs.readFile(path.join(outputDir, WINDOWS_SANDBOX_HASH_MANIFEST_NAME), "utf8"),
      );
      expect(manifest.rustTarget).toBe(rustTarget);
      for (const name of binaryNames) {
        const bytes = await fs.readFile(path.join(outputDir, name));
        expect(manifest.files[name]).toBe(createHash("sha256").update(bytes).digest("hex"));
      }
      expect(await fs.readFile(path.join(outputDir, "prompts", "system.md"), "utf8")).toBe(
        "bundled prompt",
      );
      expect(commands[0][0]).toBe(process.execPath);
      expect(commands[0]).toContain(`bun-windows-${arch}`);
      expect(commands).toContainEqual(["rustup", "target", "add", rustTarget]);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
