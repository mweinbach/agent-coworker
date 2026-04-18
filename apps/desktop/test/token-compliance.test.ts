import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { extname, join, relative, resolve } from "node:path";

const desktopSrcDir = resolve(import.meta.dir, "../src");
const allowedLiteralColorFiles = new Set([
  resolve(desktopSrcDir, "styles/theme-bridge.css"),
  resolve(desktopSrcDir, "styles/tokens/base.css"),
  resolve(desktopSrcDir, "styles/tokens/platform.css"),
]);
const allowedColorMixFiles = new Set(allowedLiteralColorFiles);
const allowedInlineStyleFiles = new Set<string>([
  // Keep this narrow. Add entries only for intentional renderer exceptions that cannot use tokens.
  resolve(desktopSrcDir, "components/ConnectPage.tsx"),
  resolve(desktopSrcDir, "main.web.tsx"),
]);

const rawColorPattern = /#[0-9A-Fa-f]{3,8}\b|rgba?\(|oklch\(/g;
const colorMixPattern = /color-mix\(/g;
const hardcodedPaletteUtilityPattern =
  /\b(?:text|bg|border|ring|fill|stroke)-(?:amber|blue|emerald|green|red|orange|yellow|slate|zinc|neutral|stone|violet|purple|pink|rose|cyan|sky|teal|lime|indigo)(?:-[0-9]{2,3})?(?:\/(?:\[[^\]]+\]|[0-9]{1,3}))?\b/g;
const selfReferentialVarPattern = /(--[\w-]+)\s*:\s*var\(\1\)\s*;/g;
const inlineStyleBlockPattern = /style=\{\{([\s\S]*?)\}\}/g;
const colorBearingInlineStylePattern =
  /\b(?:background|backgroundColor|color|borderColor|boxShadow|outlineColor|fill|stroke|filter)\s*:/;

function walkFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      return walkFiles(fullPath);
    }
    return [fullPath];
  });
}

function readDesktopFiles() {
  return walkFiles(desktopSrcDir)
    .filter((filePath) => [".css", ".ts", ".tsx"].includes(extname(filePath)))
    .map((filePath) => ({
      filePath,
      relativePath: relative(desktopSrcDir, filePath).replaceAll("\\", "/"),
      content: readFileSync(filePath, "utf8"),
    }));
}

function collectMatches(
  files: Array<{ filePath: string; relativePath: string; content: string }>,
  pattern: RegExp,
  allowlist = new Set<string>(),
) {
  return files.flatMap(({ filePath, relativePath, content }) => {
    if (allowlist.has(filePath)) {
      return [];
    }
    const matches = Array.from(content.matchAll(new RegExp(pattern.source, pattern.flags)));
    return matches.map((match) => `${relativePath}: ${match[0]}`);
  });
}

describe("desktop token compliance", () => {
  test("declares the required semantic token contract in the bridge", () => {
    const themeBridgeCss = readFileSync(resolve(desktopSrcDir, "styles/theme-bridge.css"), "utf8");
    const requiredTokens = [
      "--surface-window",
      "--surface-shell",
      "--surface-sidebar",
      "--surface-sidebar-pane",
      "--surface-workspace-pane",
      "--surface-card",
      "--surface-card-elevated",
      "--surface-overlay",
      "--surface-field",
      "--surface-muted-fill",
      "--text-primary",
      "--text-secondary",
      "--text-muted",
      "--text-inverse",
      "--text-link",
      "--border-default",
      "--border-subtle",
      "--border-strong",
      "--border-glass",
      "--border-separator",
      "--shadow-surface",
      "--shadow-overlay",
      "--shadow-field",
    ];

    for (const token of requiredTokens) {
      expect(themeBridgeCss).toContain(`${token}:`);
    }
  });

  test("limits raw color literals to token definition files", () => {
    const violations = collectMatches(readDesktopFiles(), rawColorPattern, allowedLiteralColorFiles);
    expect(violations).toEqual([]);
  });

  test("limits color-mix formulas to token definition files", () => {
    const violations = collectMatches(readDesktopFiles(), colorMixPattern, allowedColorMixFiles);
    expect(violations).toEqual([]);
  });

  test("blocks hardcoded palette utility classes in renderer code", () => {
    const violations = collectMatches(readDesktopFiles(), hardcodedPaletteUtilityPattern);
    expect(violations).toEqual([]);
  });

  test("blocks direct color-bearing inline styles outside the documented allowlist", () => {
    const violations = readDesktopFiles().flatMap(({ filePath, relativePath, content }) => {
      if (allowedInlineStyleFiles.has(filePath)) {
        return [];
      }

      return Array.from(content.matchAll(new RegExp(inlineStyleBlockPattern.source, inlineStyleBlockPattern.flags)))
        .filter((match) => colorBearingInlineStylePattern.test(match[1] ?? ""))
        .map((match) => `${relativePath}: style={{${(match[1] ?? "").trim()}}}`);
    });

    expect(violations).toEqual([]);
  });

  test("does not define self-referential custom properties", () => {
    const violations = collectMatches(readDesktopFiles(), selfReferentialVarPattern);
    expect(violations).toEqual([]);
  });
});
