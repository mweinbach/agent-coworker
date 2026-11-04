#!/usr/bin/env bun

import fs from "node:fs/promises";
import path from "node:path";

import { WEBSOCKET_PROTOCOL_VERSION } from "../../../src/shared/protocol";
import { checkProviderSpecs } from "./generate_provider_specs";
import {
  loadRustProtocolSchemaManifest,
  loadRustWebSocketJsonRpcSchemaJson,
} from "./protocolManifest";

type CheckResult = { ok: true } | { ok: false; message: string };
const REPO_ROOT = path.resolve(import.meta.dir, "..", "..", "..");
const GENERATED_WS_SCHEMA_PATH = path.join(
  REPO_ROOT,
  "docs",
  "generated",
  "websocket-jsonrpc.schema.json",
);
const REPO_PATH_PREFIXES = [
  "src/",
  "crates/",
  "docs/",
  "agent_docs/",
  "packages/",
  "scripts/",
  "apps/",
  "config/",
  "skills/",
  "prompts/",
  "test/",
];
const GENERATED_REPO_PATH_PREFIXES = [
  "apps/desktop/resources/",
  "apps/desktop/out/",
  "apps/desktop/out-quality/",
  "apps/desktop/out-web/",
  "apps/desktop/release/",
];
const TOP_LEVEL_DOCS = ["README.md", "AGENTS.md", "CLAUDE.md", "GEMINI.md", "CONTRIBUTING.md"];
export const CURATED_DOCS_WITH_PATH_CHECKS = [
  ...TOP_LEVEL_DOCS,
  "apps/desktop/AGENTS.md",
  "apps/desktop/README.md",
  "agent_docs/adding-models.md",
  "agent_docs/astra.md",
  "agent_docs/code-review-rules.md",
  "agent_docs/cursor-cloud.md",
  "agent_docs/desktop-ui.md",
  "agent_docs/engineering-rules.md",
  "agent_docs/mobile-ui.md",
  "agent_docs/model-selection.md",
  "agent_docs/repo-contracts.md",
  "docs/harness/config.md",
  "docs/harness/context.md",
  "docs/harness/index.md",
  "docs/harness/observability.md",
  "docs/harness/office-conversion.md",
  "docs/harness/reliability.md",
  "docs/harness/runbook.md",
  "docs/harness/slo.md",
  "docs/harness/tool-calling.md",
  "docs/harness/ux-reliability-map.md",
  "docs/architecture.md",
  "docs/bundling-guide.md",
  "docs/cloud-sync.md",
  "docs/custom-tools.md",
  "docs/desktop-design-system.md",
  "docs/diagnostics.md",
  "docs/mcp-guide.md",
  "docs/mobile-accessibility.md",
  "docs/mobile-list-performance.md",
  "docs/mobile-remote-access.md",
  "docs/packaged-telemetry.md",
  "docs/privacy-telemetry.md",
  "docs/quic-pairing.md",
  "docs/release-telemetry-checklist.md",
  "docs/sandbox.md",
  "docs/session-storage-architecture.md",
  "docs/websocket-protocol.md",
  "docs/workflows.md",
  "docs/workspace-context.md",
] as const;

export function protocolVersionNeedle(
  version: string = loadRustProtocolSchemaManifest().websocketProtocolVersion,
): string {
  return `Current protocol version: \`${version}\``;
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    const stat = await fs.stat(filePath);
    return stat.isFile();
  } catch {
    return false;
  }
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await fs.stat(filePath);
    return true;
  } catch {
    return false;
  }
}

async function readText(filePath: string): Promise<string> {
  return await fs.readFile(filePath, "utf-8");
}

function assertContains(haystack: string, needle: string, context: string): CheckResult {
  if (!haystack.includes(needle)) {
    return { ok: false, message: `${context} is missing required reference: ${needle}` };
  }
  return { ok: true };
}

function normalizeDocReference(reference: string): string {
  return reference.replace(/[#?].*$/, "").trim();
}

function isPlainRelativeDocLink(reference: string): boolean {
  const normalized = normalizeDocReference(reference);
  if (!normalized || normalized.includes(" ")) return false;
  if (
    normalized.startsWith("http://") ||
    normalized.startsWith("https://") ||
    normalized.startsWith("mailto:")
  ) {
    return false;
  }
  if (normalized.startsWith("./") || normalized.startsWith("../")) return false;
  if (normalized.startsWith("~")) return false;
  if (normalized.startsWith(".")) return false;
  if (REPO_PATH_PREFIXES.some((prefix) => normalized.startsWith(prefix))) return false;
  return /\.md$/i.test(normalized);
}

const NON_PATH_INLINE_TOKENS = new Set<string>(["config/read"]);

function isGeneratedRepoPath(candidate: string): boolean {
  return GENERATED_REPO_PATH_PREFIXES.some((prefix) => candidate.startsWith(prefix));
}

function looksLikeInlineRepoPath(reference: string): boolean {
  const normalized = normalizeDocReference(reference);
  if (
    !normalized ||
    NON_PATH_INLINE_TOKENS.has(normalized) ||
    normalized.startsWith("http://") ||
    normalized.startsWith("https://") ||
    normalized.startsWith("mailto:")
  ) {
    return false;
  }
  if (normalized.startsWith("~/.cowork")) return false;
  if (normalized.includes("<") || normalized.includes(">")) return false;
  if (
    normalized.includes("myTool") ||
    normalized.includes("myProvider") ||
    normalized.includes("my-skill")
  )
    return false;
  if (normalized.startsWith("./")) {
    const stripped = normalized.slice(2);
    if (stripped.startsWith(".") || isGeneratedRepoPath(stripped)) return false;
    return REPO_PATH_PREFIXES.some((prefix) => stripped.startsWith(prefix));
  }
  if (normalized.startsWith("../")) {
    const stripped = normalized.replace(/^(\.\.\/)+/, "");
    if (stripped.startsWith(".") || isGeneratedRepoPath(stripped)) return false;
    return (
      TOP_LEVEL_DOCS.includes(stripped) ||
      REPO_PATH_PREFIXES.some((prefix) => stripped.startsWith(prefix))
    );
  }
  if (isGeneratedRepoPath(normalized)) return false;
  if (TOP_LEVEL_DOCS.includes(normalized)) return true;
  return REPO_PATH_PREFIXES.some((prefix) => normalized.startsWith(prefix));
}

function looksLikeMarkdownRepoPath(reference: string): boolean {
  const normalized = normalizeDocReference(reference);
  if (normalized.startsWith("./")) {
    const stripped = normalized.slice(2);
    if (stripped.startsWith(".")) return false;
    if (/\.md$/i.test(stripped)) return true;
  }

  return looksLikeInlineRepoPath(reference) || isPlainRelativeDocLink(reference);
}

export function extractMarkdownLinks(text: string): string[] {
  return Array.from(text.matchAll(/\[[^\]]+\]\(([^)]+)\)/g))
    .map((match) => match[1]?.trim() ?? "")
    .filter((value) => value.length > 0 && looksLikeMarkdownRepoPath(value));
}

export function extractInlineRepoPaths(text: string): string[] {
  const inlineMatches = Array.from(text.matchAll(/`([^`\n]+)`/g)).map(
    (match) => match[1]?.trim() ?? "",
  );
  const shellFenceTokens: string[] = [];
  for (const fenceMatch of text.matchAll(/```(?:bash|sh)\n([\s\S]*?)```/g)) {
    const block = fenceMatch[1] ?? "";
    for (const line of block.split("\n")) {
      const uncommented = line.replace(/\s+#.*$/, "").trim();
      if (!uncommented || uncommented.startsWith("#")) continue;
      for (const rawToken of uncommented.split(/\s+/)) {
        const cleaned = rawToken.replace(/^['"(]+|[)'",;\\]+$/g, "");
        if (cleaned) shellFenceTokens.push(cleaned);
      }
    }
  }
  return [...inlineMatches, ...shellFenceTokens].filter((value) => looksLikeInlineRepoPath(value));
}

export function resolveDocReferencePath(
  cwd: string,
  docPath: string,
  reference: string,
  kind: "markdown" | "inline",
): string {
  const normalized = normalizeDocReference(reference);
  const docDir = path.dirname(path.join(cwd, docPath));

  if (kind === "markdown") {
    if (
      isPlainRelativeDocLink(normalized) ||
      normalized.startsWith("./") ||
      normalized.startsWith("../")
    ) {
      return path.resolve(docDir, normalized);
    }
    return path.resolve(cwd, normalized);
  }

  if (normalized.startsWith("./") || normalized.startsWith("../")) {
    return path.resolve(docDir, normalized);
  }
  return path.resolve(cwd, normalized);
}

const JSONRPC_DOC_METHOD_PATTERN = /`([A-Za-z][A-Za-z0-9_-]*(?:\/[A-Za-z0-9_-]+)+)`/g;
// Method names the protocol doc may reference even though they are not cowork
// wire methods (e.g. upstream Codex app-server requests handled internally).
const JSONRPC_DOC_METHOD_ALLOWLIST = new Set<string>(["item/fileChange/requestApproval"]);

export function registeredJsonRpcMethods(): Set<string> {
  const manifest = loadRustProtocolSchemaManifest();
  return new Set([
    ...manifest.methods.requests,
    ...manifest.methods.notifications,
    ...manifest.methods.serverRequests,
  ]);
}

function looksLikeJsonRpcMethod(reference: string): boolean {
  if (reference.includes(".")) return false;
  if (REPO_PATH_PREFIXES.some((prefix) => reference.startsWith(prefix))) return false;
  return reference.split("/").every((part) => /^[A-Za-z][A-Za-z0-9_-]*$/.test(part));
}

export function extractDocumentedJsonRpcMethods(text: string): Set<string> {
  const methods = new Set<string>();
  for (const match of text.matchAll(JSONRPC_DOC_METHOD_PATTERN)) {
    const method = match[1];
    if (method && looksLikeJsonRpcMethod(method)) methods.add(method);
  }
  return methods;
}

export function checkJsonRpcMethodDrift(wsProtocol: string): CheckResult[] {
  const registered = registeredJsonRpcMethods();
  const documented = extractDocumentedJsonRpcMethods(wsProtocol);
  const checks: CheckResult[] = [];

  for (const method of [...registered].sort()) {
    if (!wsProtocol.includes(`\`${method}\``)) {
      checks.push({
        ok: false,
        message: `JSON-RPC method registered in schema but missing from docs/websocket-protocol.md: ${method}`,
      });
    }
  }
  for (const method of [...documented].sort()) {
    if (!registered.has(method) && !JSONRPC_DOC_METHOD_ALLOWLIST.has(method)) {
      checks.push({
        ok: false,
        message: `docs/websocket-protocol.md mentions JSON-RPC method not in the schema registry: ${method}`,
      });
    }
  }
  return checks;
}

async function resolvedReferenceExists(resolved: string): Promise<boolean> {
  if (!resolved.includes("*")) {
    return await pathExists(resolved);
  }

  const parentDir = path.dirname(resolved);
  const basenamePattern = path.basename(resolved);
  if (parentDir.includes("*")) {
    return false;
  }

  try {
    const entries = await fs.readdir(parentDir);
    const regexSource = basenamePattern
      .replace(/[.+?^${}()|[\]\\]/g, "\\$&")
      .replace(/\*/g, "[^/]*");
    const matcher = new RegExp(`^${regexSource}$`);
    return entries.some((entry) => matcher.test(entry));
  } catch {
    return false;
  }
}

export async function validateReferencedPaths(
  cwd: string,
  docPath: string,
  text: string,
): Promise<CheckResult[]> {
  const references = [
    ...extractMarkdownLinks(text).map((reference) => ({ kind: "markdown" as const, reference })),
    ...extractInlineRepoPaths(text).map((reference) => ({ kind: "inline" as const, reference })),
  ];
  const checks: CheckResult[] = [];
  const seen = new Set<string>();

  for (const { kind, reference } of references) {
    const normalized = normalizeDocReference(reference);
    const key = `${kind}:${normalized}`;
    if (!normalized || seen.has(key)) continue;
    seen.add(key);

    const resolved = resolveDocReferencePath(cwd, docPath, normalized, kind);
    if (!(await resolvedReferenceExists(resolved))) {
      checks.push({
        ok: false,
        message: `${docPath} references missing path: ${normalized}`,
      });
    }
  }

  return checks;
}

async function main() {
  const cwd = REPO_ROOT;
  const requiredFiles = [
    "docs/harness/index.md",
    "docs/harness/config.md",
    "docs/harness/observability.md",
    "docs/harness/context.md",
    "docs/harness/slo.md",
    "docs/websocket-protocol.md",
  ];

  for (const rel of requiredFiles) {
    const abs = path.join(cwd, rel);
    if (!(await fileExists(abs))) {
      throw new Error(`Missing required documentation file: ${rel}`);
    }
  }

  const agents = await readText(path.join(cwd, "AGENTS.md"));
  const claude = await readText(path.join(cwd, "CLAUDE.md"));
  const gemini = await readText(path.join(cwd, "GEMINI.md"));
  const contributing = await readText(path.join(cwd, "CONTRIBUTING.md"));
  const harnessIndex = await readText(path.join(cwd, "docs/harness/index.md"));
  const readme = await readText(path.join(cwd, "README.md"));
  const wsProtocol = await readText(path.join(cwd, "docs/websocket-protocol.md"));
  const generatedSchemaOnDisk = await readText(GENERATED_WS_SCHEMA_PATH);
  const manifest = loadRustProtocolSchemaManifest();
  const expectedSchemaJson = loadRustWebSocketJsonRpcSchemaJson();

  const checks: CheckResult[] = [
    manifest.websocketProtocolVersion === WEBSOCKET_PROTOCOL_VERSION
      ? { ok: true }
      : {
          ok: false,
          message: `WEBSOCKET_PROTOCOL_VERSION in src/shared/protocol.ts (${WEBSOCKET_PROTOCOL_VERSION}) drifted from Rust cowork-protocol (${manifest.websocketProtocolVersion})`,
        },
    generatedSchemaOnDisk === expectedSchemaJson
      ? { ok: true }
      : {
          ok: false,
          message:
            "docs/generated/websocket-jsonrpc.schema.json is out of sync with Rust cowork-protocol; run `bun run docs:generate-jsonrpc`",
        },
    assertContains(agents, "docs/harness/index.md", "AGENTS.md"),
    assertContains(claude, "docs/harness/index.md", "CLAUDE.md"),
    assertContains(gemini, "docs/harness/index.md", "GEMINI.md"),
    assertContains(contributing, "docs/harness/index.md", "CONTRIBUTING.md"),
    assertContains(harnessIndex, "config.md", "docs/harness/index.md"),
    assertContains(harnessIndex, "observability.md", "docs/harness/index.md"),
    assertContains(harnessIndex, "context.md", "docs/harness/index.md"),
    assertContains(harnessIndex, "slo.md", "docs/harness/index.md"),
    assertContains(readme, "docs/harness/index.md", "README.md"),
    assertContains(readme, "docs/harness/config.md", "README.md"),
    assertContains(readme, "docs/websocket-protocol.md", "README.md"),
    assertContains(wsProtocol, "cowork/session/harnessContext/get", "docs/websocket-protocol.md"),
    assertContains(wsProtocol, "observability_status", "docs/websocket-protocol.md"),
    assertContains(wsProtocol, protocolVersionNeedle(), "docs/websocket-protocol.md"),
    ...checkJsonRpcMethodDrift(wsProtocol),
    ...(await checkProviderSpecs()).map((message) => ({ ok: false as const, message })),
  ];

  for (const docPath of CURATED_DOCS_WITH_PATH_CHECKS) {
    const text = await readText(path.join(cwd, docPath));
    checks.push(...(await validateReferencedPaths(cwd, docPath, text)));
  }

  const failures = checks.filter((check): check is { ok: false; message: string } => !check.ok);
  if (failures.length > 0) {
    for (const failure of failures) {
      console.error(`[docs-check] ${failure.message}`);
    }
    process.exitCode = 1;
    return;
  }

  console.log("[docs-check] OK");
}

if (import.meta.main) {
  main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}
