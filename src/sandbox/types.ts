import type { AgentShellPolicy } from "../server/agents/commandPolicy";
import type { AgentConfig } from "../types";

export const SANDBOX_REFERENCE = {
  repository: "https://github.com/openai/codex",
  commit: "4de7a2b9d8eae19e00ca7f744647fa1aabdc204f",
} as const;

export const SANDBOX_MODES = ["read-only", "workspace-write", "danger-full-access"] as const;
export type SandboxMode = (typeof SANDBOX_MODES)[number];

export type SandboxNetworkPolicy = "enabled" | "restricted";

export type SandboxWritableRoot = {
  root: string;
  readOnlySubpaths: string[];
};

export type SandboxFileSystemPolicy =
  | {
      kind: "unrestricted";
    }
  | {
      kind: "restricted";
      readableRoots: string[];
      writableRoots: SandboxWritableRoot[];
      protectedMetadataNames: string[];
      allowTmpWrite: boolean;
    };

export type SandboxPolicy = {
  mode: SandboxMode;
  fileSystem: SandboxFileSystemPolicy;
  network: SandboxNetworkPolicy;
  platformSandboxRequired: boolean;
  reference: typeof SANDBOX_REFERENCE;
};

export type SandboxPolicyInput = {
  config: AgentConfig;
  shellPolicy?: AgentShellPolicy | null;
  yolo?: boolean;
  targetPaths?: readonly string[] | null;
};

export type SandboxCommand = {
  file: string;
  args: string[];
};

export type SandboxExecutionPlan = SandboxCommand & {
  unavailableReason?: string;
};
