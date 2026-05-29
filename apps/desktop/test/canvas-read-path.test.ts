import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

describe("Canvas file reads", () => {
  test("uses capped preview reads instead of full-file IPC reads", () => {
    const source = readFileSync(resolve(import.meta.dir, "../src/ui/Canvas.tsx"), "utf8");

    expect(source).toContain("const CANVAS_PREVIEW_MAX_BYTES = 256 * 1024");
    expect(source).toContain("readFileForPreview");
    expect(source).not.toContain("readFile, writeFile");
    expect(source).not.toContain("readFile({ path })");
    expect(source).not.toContain("readFileForPreview({ path })");
    expect(source.match(/readFileForPreview\(\{ path, maxBytes: CANVAS_PREVIEW_MAX_BYTES \}\)/g))
      .toHaveLength(2);
  });
});
