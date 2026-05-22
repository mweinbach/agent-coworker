import fs from "node:fs/promises";

export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

export function cmdQuote(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

export async function writePosixShim(
  shimPath: string,
  nodePath: string,
  helperPath: string,
): Promise<void> {
  const body = `#!/bin/sh\nexec ${shellQuote(nodePath)} ${shellQuote(helperPath)} "$@"\n`;
  await fs.writeFile(shimPath, body, { encoding: "utf-8", mode: 0o755 });
  await fs.chmod(shimPath, 0o755);
}

export async function writeWindowsShim(
  shimPath: string,
  nodePath: string,
  helperPath: string,
): Promise<void> {
  const body = `@echo off\r\n${cmdQuote(nodePath)} ${cmdQuote(helperPath)} %*\r\n`;
  await fs.writeFile(shimPath, body, { encoding: "utf-8" });
}
