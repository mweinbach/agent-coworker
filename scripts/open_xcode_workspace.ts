#!/usr/bin/env bun
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const workspacePath = path.join(repoRoot, "apps", "mobile", "ios", "CoworkMobile.xcworkspace");

if (process.platform !== "darwin") {
  console.error("Opening the iOS Xcode workspace is only supported on macOS.");
  process.exit(1);
}

try {
  const proc = Bun.spawn(["open", workspacePath], { stdout: "inherit", stderr: "inherit" });
  process.exit(await proc.exited);
} catch (error) {
  console.error(
    `Failed to open Xcode workspace: ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exit(1);
}
