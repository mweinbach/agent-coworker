#!/usr/bin/env bun
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const workspacePath = path.join(repoRoot, "apps", "mobile", "ios", "CoworkMobile.xcworkspace");

if (process.platform !== "darwin") {
  console.error("Opening the iOS Xcode workspace is only supported on macOS.");
  process.exit(1);
}

const child = spawn("open", [workspacePath], { stdio: "inherit" });
child.on("error", (error) => {
  console.error(`Failed to open Xcode workspace: ${error.message}`);
  process.exit(1);
});

child.on("exit", (code, signal) => {
  if (signal) {
    console.error(`open was terminated by ${signal}`);
    process.exit(1);
  }
  process.exit(code ?? 0);
});
