import path from "node:path";

import { ensurePrivateDirectory, hardenPrivateFile } from "../../sessionDb/fileHardening";
import type { ResearchExportFormat, ResearchRecord } from "../types";
import { exportDocx } from "./exportDocx";
import { exportMarkdown } from "./exportMarkdown";
import { exportPdf } from "./exportPdf";

export async function exportResearch(opts: {
  rootDir: string;
  research: ResearchRecord;
  format: ResearchExportFormat;
}): Promise<{ path: string; sizeBytes: number }> {
  const filename =
    opts.format === "markdown" ? "report.md" : opts.format === "pdf" ? "report.pdf" : "report.docx";
  const outputPath = path.join(opts.rootDir, filename);
  await ensurePrivateDirectory(path.dirname(outputPath));

  const result =
    opts.format === "markdown"
      ? await exportMarkdown({ outputPath, research: opts.research })
      : opts.format === "pdf"
        ? await exportPdf({ outputPath, research: opts.research })
        : await exportDocx({ outputPath, research: opts.research });

  await hardenPrivateFile(result.path);
  return result;
}
