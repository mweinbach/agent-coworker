const { createHash } = require("node:crypto");
const fs = require("node:fs/promises");
const path = require("node:path");

const SANDBOX_BINARIES = [
  "cowork-win-sandbox.exe",
  "codex-windows-sandbox-setup.exe",
  "codex-command-runner.exe",
];
const MANIFEST_NAME = "cowork-win-sandbox.sha256.json";

async function sha256File(filePath) {
  return createHash("sha256")
    .update(await fs.readFile(filePath))
    .digest("hex");
}

async function writeSandboxHashManifest(binariesDir) {
  const manifestPath = path.join(binariesDir, MANIFEST_NAME);
  const previous = JSON.parse(await fs.readFile(manifestPath, "utf8"));
  if (previous.schemaVersion !== 1) {
    throw new Error(`Unsupported Windows sandbox hash manifest at ${manifestPath}`);
  }

  const files = {};
  for (const name of SANDBOX_BINARIES) {
    const binaryPath = path.join(binariesDir, name);
    const stat = await fs.stat(binaryPath).catch(() => null);
    if (!stat?.isFile()) {
      throw new Error(`Missing packaged Windows sandbox helper: ${binaryPath}`);
    }
    files[name] = await sha256File(binaryPath);
  }
  await fs.writeFile(
    manifestPath,
    `${JSON.stringify(
      {
        schemaVersion: 1,
        ...(typeof previous.rustTarget === "string" ? { rustTarget: previous.rustTarget } : {}),
        files,
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
}

async function afterPack(context) {
  if (context.electronPlatformName !== "win32") return;
  const binariesDir = path.join(context.appOutDir, "resources", "binaries");
  await writeSandboxHashManifest(binariesDir);
  console.log("[desktop] Refreshed trusted Windows sandbox hashes after Authenticode signing.");
}

module.exports = afterPack;
module.exports.__private = { SANDBOX_BINARIES, MANIFEST_NAME, writeSandboxHashManifest };
