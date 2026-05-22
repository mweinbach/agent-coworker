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

function readHelperTemplate(): string {
  cachedTemplate ??= fs.readFileSync(HELPER_TEMPLATE_PATH, "utf-8");
  return cachedTemplate;
}

export function helperSource(): string {
  return readHelperTemplate()
    .replaceAll("__COWORK_HELPER_VERSION__", String(SOFFICE_HELPER_VERSION))
    .replaceAll("__COWORK_LIBREOFFICE_VERSION__", DEFAULT_LIBREOFFICE_VERSION);
}
