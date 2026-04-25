#!/usr/bin/env bun

import fs from "node:fs/promises";
import path from "node:path";

import { WEBSOCKET_PROTOCOL_VERSION } from "../src/server/protocol";

type CheckResult = { ok: true } | { ok: false; message: string };
const REPO_PATH_PREFIXES = [
  "src/",
  "docs/",
  "scripts/",
  "apps/",
  "config/",
  "skills/",
  "prompts/",
  "test/",
];
const TOP_LEVEL_DOCS = ["README.md", "AGENTS.md", "CLAUDE.md", "GEMINI.md", "CONTRIBUTING.md"];
const CURATED_DOCS_WITH_PATH_CHECKS = [
  ...TOP_LEVEL_DOCS,
  "docs/harness/index.md",
  "docs/harness/config.md",
  "docs/harness/context.md",
  "docs/harness/runbook.md",
  "docs/architecture.md",
];

export function protocolVersionNeedle(version: string = WEBSOCKET_PROTOCOL_VERSION): string {
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

function looksLikeInlineRepoPath(reference: string): boolean {
  const normalized = normalizeDocReference(reference);
  if (
    !normalized ||
    normalized.startsWith("http://") ||
    normalized.startsWith("https://") ||
    normalized.startsWith("mailto:")
  ) {
    return false;
  }
  if (normalized.startsWith("~/.agent") || normalized.startsWith("~/.cowork")) return false;
  if (normalized.includes("<") || normalized.includes(">")) return false;
  if (
    normalized.includes("myTool") ||
    normalized.includes("myProvider") ||
    normalized.includes("my-skill")
  )
    return false;
  if (normalized.startsWith("./")) {
    const stripped = normalized.slice(2);
    if (stripped.startsWith(".")) return false;
    return REPO_PATH_PREFIXES.some((prefix) => stripped.startsWith(prefix));
  }
  if (normalized.startsWith("../")) {
    const stripped = normalized.replace(/^(\.\.\/)+/, "");
    if (stripped.startsWith(".")) return false;
    return (
      TOP_LEVEL_DOCS.includes(stripped) ||
      REPO_PATH_PREFIXES.some((prefix) => stripped.startsWith(prefix))
    );
  }
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
  return Array.from(text.matchAll(/`([^`\n]+)`/g))
    .map((match) => match[1]?.trim() ?? "")
    .filter((value) => looksLikeInlineRepoPath(value));
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

async function validateReferencedPaths(
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
    if (!(await pathExists(resolved))) {
      checks.push({
        ok: false,
        message: `${docPath} references missing path: ${normalized}`,
      });
    }
  }

  return checks;
}

async function main() {
  const cwd = process.cwd();
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

  const checks: CheckResult[] = [
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
