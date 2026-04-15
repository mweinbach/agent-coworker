export const CLOUD_TARGET_MODES = [
  "hosted-single-tenant",
  "sandboxed-multi-tenant",
] as const;

export type CloudTargetMode = (typeof CLOUD_TARGET_MODES)[number];

export const CONTROL_PLANE_HOSTS = [
  "fly-machines",
  "railway",
  "render",
] as const;

export type ControlPlaneHost = (typeof CONTROL_PLANE_HOSTS)[number];

export type SandboxToolMapping = {
  adapter: string;
  supportsCwd: boolean;
  supportsPty: boolean;
  notes: string[];
};

export type SandboxProviderPrototype = {
  provider: "e2b";
  displayName: string;
  firstMilestoneTargetMode: CloudTargetMode;
  recommendedControlPlaneHost: ControlPlaneHost;
  supports: {
    shell: boolean;
    filesystem: boolean;
    pty: boolean;
    snapshots: boolean;
    pauseResume: boolean;
  };
  toolMappings: {
    bash: SandboxToolMapping;
    read: SandboxToolMapping;
    write: SandboxToolMapping;
    grep: SandboxToolMapping;
    glob: SandboxToolMapping;
  };
  notes: string[];
};

export const FIRST_CLOUD_MILESTONE = Object.freeze({
  targetMode: "hosted-single-tenant" as CloudTargetMode,
  controlPlaneHost: "fly-machines" as ControlPlaneHost,
  firstSandboxProvider: "e2b" as const,
});

export const E2B_SANDBOX_PROTOTYPE: SandboxProviderPrototype = Object.freeze({
  provider: "e2b",
  displayName: "E2B sandbox",
  firstMilestoneTargetMode: FIRST_CLOUD_MILESTONE.targetMode,
  recommendedControlPlaneHost: FIRST_CLOUD_MILESTONE.controlPlaneHost,
  supports: {
    shell: true,
    filesystem: true,
    pty: true,
    snapshots: true,
    pauseResume: true,
  },
  toolMappings: {
    bash: {
      adapter: "commands.run",
      supportsCwd: true,
      supportsPty: true,
      notes: [
        "Map bash directly to the sandbox command runner.",
        "Prefer PTY-backed commands for interactive shells or long-running subprocesses.",
      ],
    },
    read: {
      adapter: "files.read",
      supportsCwd: false,
      supportsPty: false,
      notes: [
        "Read text and binary payloads through the sandbox filesystem API.",
      ],
    },
    write: {
      adapter: "files.write + files.mkdir",
      supportsCwd: false,
      supportsPty: false,
      notes: [
        "Create parent directories before writes to mirror the current local tool behavior.",
      ],
    },
    grep: {
      adapter: "commands.run with rg inside sandbox",
      supportsCwd: true,
      supportsPty: false,
      notes: [
        "Provision ripgrep in the sandbox image or snapshot so grep stays in the execution plane.",
      ],
    },
    glob: {
      adapter: "commands.run with sandbox-local helper",
      supportsCwd: true,
      supportsPty: false,
      notes: [
        "Run glob matching inside the sandbox to avoid leaking host filesystem structure to the control plane.",
      ],
    },
  },
  notes: [
    "Keep the current Bun WebSocket server outside the sandbox as the control plane.",
    "Treat the sandbox as a per-workspace execution plane with explicit lifecycle and cleanup.",
  ],
});

export function validateSandboxPrototype(prototype: SandboxProviderPrototype): void {
  if (!prototype.supports.shell || !prototype.supports.filesystem || !prototype.supports.pty) {
    throw new Error(`${prototype.provider} prototype must cover shell, filesystem, and PTY mappings.`);
  }

  for (const [toolName, mapping] of Object.entries(prototype.toolMappings)) {
    if (!mapping.adapter.trim()) {
      throw new Error(`${prototype.provider} prototype is missing an adapter for ${toolName}.`);
    }
  }
}
