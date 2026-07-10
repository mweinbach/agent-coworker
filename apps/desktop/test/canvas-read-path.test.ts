import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

describe("Canvas file reads", () => {
  test("uses capped document-session reads instead of full-file IPC reads", () => {
    const canvasSource = readFileSync(resolve(import.meta.dir, "../src/ui/Canvas.tsx"), "utf8");
    const controllerSource = readFileSync(
      resolve(import.meta.dir, "../src/lib/canvasDocumentController.ts"),
      "utf8",
    );

    expect(canvasSource).toContain("const CANVAS_PREVIEW_MAX_BYTES = 256 * 1024");
    expect(canvasSource).toContain("openCanvasDocument");
    expect(controllerSource).toContain("maxBytes: this.options.maxBytes");
    expect(canvasSource).not.toContain("readFile, writeFile");
    expect(canvasSource).not.toContain("readFile({ path })");
    expect(canvasSource).not.toContain("readFileForPreview");
  });
});
