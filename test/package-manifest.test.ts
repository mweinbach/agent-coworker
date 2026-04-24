import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import fg from "fast-glob";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));

type PackageManifest = {
  files?: string[];
};

function patternToFileGlob(pattern: string): string[] {
  const normalized = pattern.replace(/\/+$/, "");
  if (normalized.includes("*")) {
    return [normalized];
  }

  const absolutePath = path.join(repoRoot, normalized);
  if (existsSync(absolutePath) && statSync(absolutePath).isDirectory()) {
    return [`${normalized}/**/*`];
  }

  return [normalized];
}

function dryRunPackPaths(): string[] {
  const manifest = JSON.parse(
    readFileSync(path.join(repoRoot, "package.json"), "utf8"),
  ) as PackageManifest;
  const filePatterns = manifest.files ?? [];

  const includePatterns = filePatterns
    .filter((pattern) => !pattern.startsWith("!"))
    .flatMap((pattern) => patternToFileGlob(pattern));
  const ignorePatterns = filePatterns
    .filter((pattern) => pattern.startsWith("!"))
    .map((pattern) => pattern.slice(1))
    .flatMap((pattern) => patternToFileGlob(pattern));

  return fg.sync(includePatterns, {
    cwd: repoRoot,
    dot: true,
    onlyFiles: true,
    unique: true,
    ignore: ignorePatterns,
  });
}

describe("package manifest", () => {
  test("packs runtime assets and excludes repo-only baggage", { timeout: 20_000 }, () => {
    const paths = dryRunPackPaths();

    expect(paths).toContain("src/index.ts");
    expect(paths).toContain("src/server/index.ts");
    expect(paths).toContain("config/defaults.json");
    expect(paths).not.toContain("docs/architecture.md");
    expect(paths).not.toContain("docs/bundling-guide.md");
    expect(paths).not.toContain("docs/custom-tools.md");
    expect(paths).not.toContain("docs/harness/index.md");
    expect(paths).not.toContain("docs/mcp-guide.md");
    expect(paths).not.toContain("docs/websocket-protocol.md");
    expect(paths).not.toContain("docs/generated/websocket-jsonrpc.schema.json");
    expect(paths).not.toContain("docs/generated/websocket-jsonrpc.d.ts");
    expect(paths).not.toContain("src/server/jsonrpc/codegen.ts");
    expect(paths).not.toContain("src/server/jsonrpc/schema.ts");
    expect(paths).not.toContain("src/server/jsonrpc/schema.provider.ts");
    expect(paths).not.toContain("src/server/jsonrpc/schema.skills.ts");
    expect(paths).not.toContain("src/server/jsonrpc/schema.backups.ts");
    expect(paths).not.toContain("src/server/jsonrpc/schema.memory.ts");
    expect(paths).not.toContain("src/server/jsonrpc/schema.mcp.ts");
    expect(paths).not.toContain("src/server/jsonrpc/schema.misc.ts");
    expect(paths).not.toContain("src/shared/jsonrpcControlSchemas.ts");
    expect(paths).not.toContain("src/server/agents/DelegateRunner.ts");
    expect(paths).not.toContain("src/harness/rawLoopValidation.ts");
    expect(paths).not.toContain("src/client/modelStreamReplay.ts");
    expect(paths).not.toContain("src/shared/displayCitationMarkers.ts");
    expect(paths).not.toContain("src/shared/mobileRelaySecurity.ts");
    expect(paths).not.toContain("src/shared/askPrompt.ts");
    expect(paths).not.toContain("src/runtime/openaiEventStream.ts");
    expect(paths).not.toContain("CHANGELOG.md");
    expect(paths).not.toContain("prompts/system-models/.research/anthropic-guide.md");
    expect(paths).not.toContain("prompts/system-models/.research/google-guide.md");
    expect(paths).not.toContain("prompts/system-models/.research/openai-guide.md");
    expect(paths).toContain("prompts/system.md");
    expect(paths).toContain("skills/doc/SKILL.md");
    expect(paths.some((path) => path.includes("/__pycache__/"))).toBeFalse();
    expect(paths.some((path) => path.endsWith(".pyc"))).toBeFalse();
    expect(paths).toContain("scripts/build_cowork_server_binary.ts");
    expect(paths).toContain("scripts/postinstall.ts");
    expect(paths).toContain("scripts/releaseBuildUtils.ts");

    expect(paths.some((path) => path.startsWith(".agents/"))).toBeFalse();
    expect(paths.some((path) => path.startsWith("apps/"))).toBeFalse();
    expect(paths.some((path) => path.startsWith("examples/"))).toBeFalse();
    expect(paths.some((path) => path.startsWith("tasks/"))).toBeFalse();
    expect(paths.some((path) => path.startsWith("test/"))).toBeFalse();
    expect(paths.some((path) => path.startsWith(".github/"))).toBeFalse();
    expect(paths.some((path) => path.startsWith("autoresearch"))).toBeFalse();
    expect(paths).not.toContain("docs/audit-code-bloat.md");
    expect(paths).not.toContain("docs/desktop-settings-ui-ux-audit-2026-03-13.md");
    expect(paths).not.toContain("docs/mobile-remote-access.md");
    expect(paths).not.toContain("docs/session-storage-architecture.md");
    expect(paths).not.toContain("scripts/check_docs.ts");
    expect(paths).not.toContain("scripts/run_raw_agent_loops.ts");
  });
});
