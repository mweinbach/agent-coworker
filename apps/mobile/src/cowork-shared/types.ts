export * from "../../../../src/types";

export const RUNTIME_NAMES = [
  "pi",
  "openai-responses",
  "google-interactions",
  "codex-app-server",
  "antigravity",
] as const;

export type ModelRuntimeSettings = Record<string, unknown>;
export type UserProfile = NonNullable<import("../../../../src/types").AgentConfig["userProfile"]>;
export type InstalledPluginSkillSummary = {
  name: string;
  displayName?: string;
  description?: string;
};
export type PluginSourceInputKind = "marketplace" | "direct";
export type SkillInstallState = "effective" | "shadowed" | "disabled" | "invalid";
export type SkillInstallOriginKind = import("../../../../src/types").SkillInstallOrigin["kind"];
export type SkillInstallationDiagnosticSeverity =
  import("../../../../src/types").SkillInstallationDiagnostic["severity"];
export type ObservabilityHealthStatus =
  import("../../../../src/types").ObservabilityHealth["status"];
export interface HarnessConfig {
  observability?: import("../../../../src/types").ObservabilityConfig;
}
export interface HarnessContextMetadata {
  [key: string]: unknown;
}
export type AgentMessages = import("../../../../src/types").ModelMessage[];
