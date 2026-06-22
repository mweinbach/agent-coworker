import { afterAll, describe, expect, test } from "bun:test";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { buildRuntimeEnv } from "../src/coworkRuntime";

const execFileAsync = promisify(execFile);
const runtimeDir = process.env.COWORK_RUNTIME_E2E_DIR;
const e2eDescribe = runtimeDir ? describe : describe.skip;
const roots: string[] = [];

afterAll(async () => {
  await Promise.all(roots.map((root) => fs.rm(root, { recursive: true, force: true })));
});

e2eDescribe("signed Cowork runtime document workflow", () => {
  test("runs DOCX to PDF to PNG through managed Python, LibreOffice, and Poppler", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cowork-runtime-docx-e2e-"));
    roots.push(root);
    const input = path.join(root, "runtime-smoke.docx");
    const output = path.join(root, "rendered");
    const pluginRoot = path.resolve(
      process.env.COWORK_WORKSPACE_TOOLS_ROOT ??
        path.join(import.meta.dirname, "..", "..", "cowork-skills-plugins"),
    );
    const renderer = path.join(
      pluginRoot,
      "plugins",
      "workspace-tools",
      "skills",
      "documents",
      "render_docx.py",
    );
    await fs.access(renderer);
    const env = await buildRuntimeEnv(path.resolve(runtimeDir!), process.env, process.platform);
    const python = env.COWORK_RUNTIME_PYTHON!;

    await execFileAsync(
      python,
      [
        "-c",
        "from docx import Document; import sys; d=Document(); d.add_heading('Cowork runtime smoke', 0); d.add_paragraph('Managed LibreOffice and Poppler are healthy.'); d.save(sys.argv[1])",
        input,
      ],
      { env, windowsHide: true, timeout: 60_000 },
    );
    await execFileAsync(python, [renderer, input, "--output_dir", output, "--emit_pdf"], {
      env,
      windowsHide: true,
      timeout: 180_000,
      maxBuffer: 8 * 1024 * 1024,
    });

    const png = await fs.stat(path.join(output, "page-1.png"));
    const pdf = await fs.stat(path.join(output, "runtime-smoke.pdf"));
    expect(png.size).toBeGreaterThan(1_000);
    expect(pdf.size).toBeGreaterThan(1_000);
  }, 300_000);
});
