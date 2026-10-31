export type ImportSource = "claude" | "codex";

export type ImportableKind = "plugin" | "skill";

interface ImportDiagnostic {
  code: string;
  message: string;
}

export interface ImportableItem {
  kind: ImportableKind;
  source: ImportSource;
  /** Plugin id (manifest name) or skill name. */
  id: string;
  displayName: string;
  description: string;
  version?: string;
  /** Absolute path passed to the install pipeline. */
  sourcePath: string;
  alreadyInstalledGlobal: boolean;
  alreadyInstalledWorkspace: boolean;
  /** Non-empty => not importable; surfaced to the user. */
  diagnostics: ImportDiagnostic[];
  /** True when the bundle is a Claude `.claude-plugin` that needs conversion. */
  conversionRequired?: boolean;
}
