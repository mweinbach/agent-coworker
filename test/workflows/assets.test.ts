import { describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import path from "node:path";

describe("bundled workflow assets", () => {
  test("ships workflow definitions in package and desktop resources", async () => {
    const root = path.resolve(import.meta.dir, "../..");
    const packageJson = JSON.parse(await fs.readFile(path.join(root, "package.json"), "utf8"));
    const serverBuild = await fs.readFile(
      path.join(root, "scripts", "build_cowork_server_binary.ts"),
      "utf8",
    );
    const desktopBuild = await fs.readFile(
      path.join(root, "scripts", "build_desktop_resources.ts"),
      "utf8",
    );

    expect(packageJson.files).toContain("workflows/**/*");
    expect(serverBuild).toContain('"workflows"');
    expect(desktopBuild).toContain("workflowsFingerprint");
    expect(desktopBuild).toContain('path.join(root, "workflows")');
    expect(await fs.stat(path.join(root, "workflows", "deep-research.ts"))).toBeTruthy();
  });
});
