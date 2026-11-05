import os from "node:os";

import { hostPlatform } from "../src/platform/host";

/**
 * Host scratch directories for test fixtures and tooling temp dirs:
 * - win32: the OS temp dir
 * - darwin: `/tmp` plus its `/private/tmp` realpath
 * - anything else: `/tmp`
 */
export function scratchRoots(platform: NodeJS.Platform = hostPlatform()): string[] {
  if (platform === "win32") return [os.tmpdir()];
  if (platform === "darwin") return ["/tmp", "/private/tmp"];
  return ["/tmp"];
}
