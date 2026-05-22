import { describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { makeResearchRecord } from "./research.harness";
import { exportResearch } from "../../src/server/research/export";

describe("research export", () => {
  test("writes markdown, pdf, and docx reports", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "research-export-"));
    const research = makeResearchRecord({
      id: "research-export",
      status: "completed",
      outputsMarkdown: [
        "# Findings",
        "",
        "The benchmark improved by **14%** on the latest run.",
        "",
        "- GPU utilization stayed stable",
        "- Thermal throttling did not appear",
      ].join("\n"),
      thoughtSummaries: [
        {
          id: "thought-1",
          text: "Check the previous run for regressions before calling this stable.",
          ts: "2026-04-21T00:05:00.000Z",
        },
      ],
      sources: [
        {
          url: "https://example.com/source",
          title: "Primary source",
          sourceType: "url",
          host: "example.com",
        },
      ],
    });

    try {
      const markdown = await exportResearch({
        rootDir: tmpDir,
        research,
        format: "markdown",
      });
      const pdf = await exportResearch({
        rootDir: tmpDir,
        research,
        format: "pdf",
      });
      const docx = await exportResearch({
        rootDir: tmpDir,
        research,
        format: "docx",
      });

      const markdownText = await fs.readFile(markdown.path, "utf-8");
      const pdfHeader = await fs.readFile(pdf.path);
      const docxHeader = await fs.readFile(docx.path);

      expect(markdownText).toContain("# Research title");
      expect(markdownText).toContain("## Sources");
      expect(markdownText).toContain("Primary source");
      expect(Buffer.from(pdfHeader).subarray(0, 4).toString("utf-8")).toBe("%PDF");
      expect(Buffer.from(docxHeader).subarray(0, 2).toString("utf-8")).toBe("PK");
      expect(pdf.sizeBytes).toBeGreaterThan(100);
      expect(docx.sizeBytes).toBeGreaterThan(100);
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });
});
