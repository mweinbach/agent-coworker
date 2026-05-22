import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { DEFAULT_LIBREOFFICE_VERSION, SOFFICE_HELPER_VERSION } from "./constants";

const HELPER_TEMPLATE_PATH = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "assets",
  "managed-soffice-helper.mjs",
);

let cachedTemplate: string | undefined;

export function helperTemplatePathCandidates(): string[] {
  const fromEnv = process.env.COWORK_MANAGED_SOFFICE_HELPER_PATH?.trim();
  const executableDir = path.dirname(process.execPath);
  const builtInDir = process.env.COWORK_BUILTIN_DIR?.trim();
  return [
    ...(fromEnv ? [fromEnv] : []),
    HELPER_TEMPLATE_PATH,
    path.join(executableDir, "assets", "managed-soffice-helper.mjs"),
    path.join(executableDir, "server", "assets", "managed-soffice-helper.mjs"),
    ...(builtInDir
      ? [
          path.join(path.dirname(builtInDir), "binaries", "assets", "managed-soffice-helper.mjs"),
          path.join(
            path.dirname(builtInDir),
            "binaries",
            "server",
            "assets",
            "managed-soffice-helper.mjs",
          ),
        ]
      : []),
  ];
}

function readHelperTemplate(): string {
  if (cachedTemplate) return cachedTemplate;
  const failures: string[] = [];
  for (const candidate of helperTemplatePathCandidates()) {
    try {
      cachedTemplate = fs.readFileSync(candidate, "utf-8");
      return cachedTemplate;
    } catch (error) {
      if (error && typeof error === "object" && "code" in error) {
        failures.push(`${candidate}: ${(error as { code?: unknown }).code ?? "error"}`);
      } else {
        failures.push(`${candidate}: error`);
      }
    }
  }
  throw new Error(
    `Managed LibreOffice helper template was not found. Tried: ${failures.join(", ")}`,
  );
}

export function helperSource(): string {
  return readHelperTemplate()
    .replaceAll("__COWORK_HELPER_VERSION__", String(SOFFICE_HELPER_VERSION))
    .replaceAll("__COWORK_LIBREOFFICE_VERSION__", DEFAULT_LIBREOFFICE_VERSION);
}

export function resetHelperSourceCacheForTest(): void {
  cachedTemplate = undefined;
}
