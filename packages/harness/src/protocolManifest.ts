import { execFileSync } from "node:child_process";
import fsSync from "node:fs";
import path from "node:path";

import { binaryName, resolveSpawn, which } from "../../../src/platform/exec";
import { home } from "../../../src/platform/paths";

const REPO_ROOT = path.resolve(import.meta.dir, "..", "..", "..");

export type RustProtocolSchemaManifest = {
  protocolVersion: string;
  websocketProtocolVersion: string;
  subprotocol: string;
  namespaces: string[];
  methods: {
    requests: string[];
    results: string[];
    notifications: string[];
    serverRequests: string[];
  };
  schemas: Record<string, unknown>;
};

let cachedManifest: RustProtocolSchemaManifest | null = null;

function buildCargoEnv(): NodeJS.ProcessEnv {
  const userHome = home();
  return {
    ...process.env,
    CARGO_HOME: process.env.CARGO_HOME ?? path.join(userHome, ".cargo"),
    RUSTUP_HOME: process.env.RUSTUP_HOME ?? path.join(userHome, ".rustup"),
  };
}

function invokeRustManifestExporter(): string {
  const env = buildCargoEnv();
  const explicitBin = process.env.COWORK_PROTOCOL_MANIFEST_BINARY?.trim();
  if (explicitBin) {
    return execFileSync(explicitBin, ["--manifest"], {
      cwd: REPO_ROOT,
      env,
      encoding: "utf-8",
      maxBuffer: 16 * 1024 * 1024,
    });
  }

  const cargoPath = which("cargo", { env });
  if (cargoPath) {
    const plan = resolveSpawn(
      cargoPath,
      [
        "run",
        "--quiet",
        "-p",
        "cowork-protocol",
        "--bin",
        "cowork-protocol-manifest",
        "--",
        "--manifest",
      ],
      { env, cwd: REPO_ROOT },
    );
    return execFileSync(plan.file, plan.args, {
      cwd: REPO_ROOT,
      env,
      encoding: "utf-8",
      maxBuffer: 16 * 1024 * 1024,
      windowsHide: true,
    });
  }

  const manifestExe = binaryName("cowork-protocol-manifest");
  const serverExe = binaryName("cowork-server");
  for (const profile of ["release", "debug"]) {
    const manifestCandidate = path.join(REPO_ROOT, "target", profile, manifestExe);
    if (fsSync.existsSync(manifestCandidate)) {
      return execFileSync(manifestCandidate, ["--manifest"], {
        cwd: REPO_ROOT,
        env,
        encoding: "utf-8",
        maxBuffer: 16 * 1024 * 1024,
      });
    }
    const serverCandidate = path.join(REPO_ROOT, "target", profile, serverExe);
    if (fsSync.existsSync(serverCandidate)) {
      return execFileSync(serverCandidate, ["__export-jsonrpc-schema", "--manifest"], {
        cwd: REPO_ROOT,
        env,
        encoding: "utf-8",
        maxBuffer: 16 * 1024 * 1024,
      });
    }
  }

  throw new Error(
    "Unable to export Rust protocol manifest: neither `cargo` nor a compiled `cowork-protocol-manifest`/`cowork-server` binary is available.",
  );
}

export function loadRustProtocolSchemaManifest(): RustProtocolSchemaManifest {
  if (cachedManifest) return cachedManifest;
  const raw = invokeRustManifestExporter();
  const parsed = JSON.parse(raw) as Partial<RustProtocolSchemaManifest> | null;
  if (
    !parsed ||
    typeof parsed.protocolVersion !== "string" ||
    typeof parsed.websocketProtocolVersion !== "string" ||
    typeof parsed.subprotocol !== "string" ||
    !Array.isArray(parsed.namespaces) ||
    !parsed.methods ||
    !Array.isArray(parsed.methods.requests) ||
    !Array.isArray(parsed.methods.results) ||
    !Array.isArray(parsed.methods.notifications) ||
    !Array.isArray(parsed.methods.serverRequests) ||
    !parsed.schemas ||
    typeof parsed.schemas !== "object"
  ) {
    throw new Error("Invalid protocol schema manifest returned by cowork-protocol.");
  }
  const validated: RustProtocolSchemaManifest = {
    protocolVersion: parsed.protocolVersion,
    websocketProtocolVersion: parsed.websocketProtocolVersion,
    subprotocol: parsed.subprotocol,
    namespaces: parsed.namespaces,
    methods: parsed.methods,
    schemas: parsed.schemas,
  };
  cachedManifest = validated;
  return validated;
}
