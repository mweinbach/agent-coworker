import path from "node:path";

import { isPathInside } from "../utils/paths";
import { resolveAgentTargetPathRoots } from "../utils/permissions";
import type {
  SandboxFileSystemPolicy,
  SandboxMode,
  SandboxPolicy,
  SandboxPolicyInput,
  SandboxWritableRoot,
} from "./types";
import { SANDBOX_REFERENCE } from "./types";

const PROTECTED_METADATA_NAMES = [".git", ".agents", ".cowork"] as const;

function uniqueResolved(paths: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of paths) {
    const resolved = path.resolve(value);
    if (seen.has(resolved)) continue;
    seen.add(resolved);
    out.push(resolved);
  }
  return out;
}

function projectRootForConfig(input: SandboxPolicyInput): string {
  return path.dirname(input.config.projectCoworkDir);
}

function writeRootsForConfig(input: SandboxPolicyInput): string[] {
  return uniqueResolved([
    projectRootForConfig(input),
    input.config.workingDirectory,
    ...(input.config.outputDirectory ? [input.config.outputDirectory] : []),
    ...(input.config.uploadsDirectory ? [input.config.uploadsDirectory] : []),
  ]);
}

function targetWritableRoots(input: SandboxPolicyInput): string[] {
  const scopedRoots = resolveAgentTargetPathRoots(input.config, input.targetPaths);
  if (scopedRoots.length === 0) return writeRootsForConfig(input);

  const writableRoots = writeRootsForConfig(input);
  return uniqueResolved(scopedRoots).filter((scopeRoot) =>
    writableRoots.some((root) => isPathInside(root, scopeRoot)),
  );
}

function readOnlySubpathsForWritableRoot(root: string): string[] {
  return PROTECTED_METADATA_NAMES.map((name) => path.join(root, name));
}

function writableRoot(root: string): SandboxWritableRoot {
  return {
    root,
    readOnlySubpaths: readOnlySubpathsForWritableRoot(root),
  };
}

function readOnlyFileSystem(): SandboxFileSystemPolicy {
  return {
    kind: "restricted",
    readableRoots: [path.parse(path.resolve("/")).root],
    writableRoots: [],
    protectedMetadataNames: [...PROTECTED_METADATA_NAMES],
    allowTmpWrite: false,
  };
}

function workspaceWriteFileSystem(input: SandboxPolicyInput): SandboxFileSystemPolicy {
  return {
    kind: "restricted",
    readableRoots: [path.parse(path.resolve(input.config.workingDirectory)).root],
    writableRoots: targetWritableRoots(input).map(writableRoot),
    protectedMetadataNames: [...PROTECTED_METADATA_NAMES],
    allowTmpWrite: false,
  };
}

export function resolveSandboxMode(input: SandboxPolicyInput): SandboxMode {
  if (input.yolo === true) return "danger-full-access";
  if ((input.shellPolicy ?? "full") === "no_project_write") return "read-only";
  return "workspace-write";
}

export function resolveSandboxPolicy(input: SandboxPolicyInput): SandboxPolicy {
  const mode = resolveSandboxMode(input);
  if (mode === "danger-full-access") {
    return {
      mode,
      fileSystem: { kind: "unrestricted" },
      network: "enabled",
      platformSandboxRequired: false,
      reference: SANDBOX_REFERENCE,
    };
  }

  return {
    mode,
    fileSystem: mode === "read-only" ? readOnlyFileSystem() : workspaceWriteFileSystem(input),
    network: "restricted",
    platformSandboxRequired: true,
    reference: SANDBOX_REFERENCE,
  };
}

export const __internal = {
  PROTECTED_METADATA_NAMES,
  targetWritableRoots,
  writeRootsForConfig,
};
