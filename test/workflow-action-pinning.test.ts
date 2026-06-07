import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const workflowsDir = fileURLToPath(new URL("../.github/workflows", import.meta.url));
const actionsDir = fileURLToPath(new URL("../.github/actions", import.meta.url));

const SHA_RE = /^[0-9a-f]{40}$/;

function collectActionDefinitionFiles(): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(workflowsDir)) {
    if (entry.endsWith(".yml") || entry.endsWith(".yaml")) {
      files.push(path.join(workflowsDir, entry));
    }
  }
  for (const entry of readdirSync(actionsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    for (const name of ["action.yml", "action.yaml"]) {
      const candidate = path.join(actionsDir, entry.name, name);
      try {
        readFileSync(candidate);
        files.push(candidate);
      } catch {
        // no action definition with this name
      }
    }
  }
  return files;
}

function extractUsesRefs(content: string): string[] {
  return [...content.matchAll(/^\s*-?\s*uses:\s*(\S+)/gm)].map((match) => match[1]);
}

/** Local (`./...`) and GitHub first-party (`actions/*`) refs are exempt. */
function isThirdPartyRef(ref: string): boolean {
  return !ref.startsWith("./") && !ref.startsWith("actions/");
}

function refVersion(ref: string): string {
  const at = ref.lastIndexOf("@");
  return at >= 0 ? ref.slice(at + 1) : "";
}

describe("GitHub Actions supply-chain pinning", () => {
  const files = collectActionDefinitionFiles();

  test("discovers workflow and composite action definitions", () => {
    expect(files.length).toBeGreaterThan(0);
  });

  test("all third-party actions are pinned to immutable commit SHAs", () => {
    const violations: string[] = [];
    for (const file of files) {
      const content = readFileSync(file, "utf8");
      for (const ref of new Set(extractUsesRefs(content))) {
        if (!isThirdPartyRef(ref)) continue;
        if (!SHA_RE.test(refVersion(ref))) {
          violations.push(`${path.relative(process.cwd(), file)}: ${ref}`);
        }
      }
    }
    expect(violations).toEqual([]);
  });

  test("comment-triggered AI helper workflows pin their AI actions to SHAs", () => {
    const opencode = readFileSync(path.join(workflowsDir, "opencode.yml"), "utf8");
    const claude = readFileSync(path.join(workflowsDir, "claude.yml"), "utf8");

    expect(opencode).toMatch(/uses: anomalyco\/opencode\/github@[0-9a-f]{40}\b/);
    expect(opencode).not.toMatch(/uses: anomalyco\/opencode\/github@(latest|v\d)/);

    expect(claude).toMatch(/uses: anthropics\/claude-code-action@[0-9a-f]{40}\b/);
    expect(claude).not.toMatch(/uses: anthropics\/claude-code-action@v\d/);
  });

  test("release-publishing jobs pin softprops/action-gh-release to a SHA", () => {
    for (const name of ["cowork-server-release.yml", "desktop-release.yml"]) {
      const content = readFileSync(path.join(workflowsDir, name), "utf8");
      expect(content).toMatch(/uses: softprops\/action-gh-release@[0-9a-f]{40}\b/);
      expect(content).not.toMatch(/uses: softprops\/action-gh-release@v\d/);
    }
  });
});
