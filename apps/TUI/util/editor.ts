import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

/**
 * Opens an external editor with the given text and returns the edited result.
 */
export function openInEditor(text: string): string | null {
  const editor = process.env.EDITOR || process.env.VISUAL || "vi";
  const tmpFile = path.join(os.tmpdir(), `cowork-edit-${Date.now()}.md`);

  try {
    fs.writeFileSync(tmpFile, text, "utf-8");
    execSync(`${editor} ${tmpFile}`, { stdio: "inherit" });
    const result = fs.readFileSync(tmpFile, "utf-8");
    fs.unlinkSync(tmpFile);
    return result;
  } catch {
    try {
      fs.unlinkSync(tmpFile);
    } catch {
      // ignore cleanup errors
    }
    return null;
  }
}
