import fs from "node:fs";
import path from "node:path";
import { describe, expect, test } from "bun:test";

const ROOT = process.cwd();

const INPUT_FILES = [
  "apps/TUI/routes/session/question.tsx",
  "apps/TUI/ui/dialog-prompt.tsx",
  "apps/TUI/ui/dialog-select.tsx",
];

function read(relPath: string): string {
  return fs.readFileSync(path.join(ROOT, relPath), "utf8");
}

describe("TUI input submit guidance", () => {
  test("every OpenTUI <input> uses onSubmit", () => {
    for (const relPath of INPUT_FILES) {
      const content = read(relPath);
      const inputTags = content.match(/<input[\s\S]*?\/>/g) ?? [];
      expect(inputTags.length).toBeGreaterThan(0);
      for (const tag of inputTags) {
        expect(tag).toContain("onSubmit=");
      }
    }
  });
});
