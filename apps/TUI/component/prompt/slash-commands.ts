import type { AutocompleteItem } from "./autocomplete";

type LocalSlashDependencies = {
  syncActions: {
    reset: () => void;
    cancel: () => void;
    setProviderApiKey: (provider: string, methodId: string, apiKey: string) => void;
    requestHarnessContext: () => void;
    setHarnessContext: (context: {
      runId: string;
      taskId?: string;
      objective: string;
      acceptanceCriteria: string[];
      constraints: string[];
      metadata?: Record<string, string>;
    }) => void;
  };
  route: {
    navigate: (next: { route: "home" } | { route: "session"; sessionId: string }) => void;
  };
  dialog: unknown;
  exit: {
    exit: () => void;
  };
};

export type LocalSlashCommand = {
  name: string;
  aliases: string[];
  description: string;
  icon: string;
  execute: (argumentsText: string) => void | Promise<void>;
};

function normalizeCommandName(value: string): string {
  return value.trim().toLowerCase();
}

function buildDefaultHarnessContext(objectiveOverride: string) {
  const now = new Date();
  const isoNow = now.toISOString();
  const runId = `tui-${isoNow.replace(/[:.]/g, "-")}`;
  const objective = objectiveOverride.trim() || "Validate the current workspace behavior with harness visibility.";

  return {
    runId,
    objective,
    acceptanceCriteria: [
      "Requested behavior is implemented and demonstrated in this workspace.",
      "No regressions are introduced while making the change.",
    ],
    constraints: [
      "Keep scope focused on the requested behavior.",
      "Use reproducible checks where possible.",
    ],
    metadata: {
      source: "tui",
      createdAt: isoNow,
    },
  };
}

function parseWithKnownCommandNames(
  body: string,
  knownCommandNames: readonly string[]
): { name: string; argumentsText: string } | null {
  if (knownCommandNames.length === 0) return null;
  const lowerBody = body.toLowerCase();

  const normalizedCandidates = [...new Set(
    knownCommandNames
      .map((name) => name.trim())
      .filter(Boolean)
  )].sort((a, b) => b.length - a.length);

  for (const candidate of normalizedCandidates) {
    const lowerCandidate = candidate.toLowerCase();
    if (lowerBody === lowerCandidate) {
      return { name: candidate, argumentsText: "" };
    }
    if (lowerBody.startsWith(`${lowerCandidate} `)) {
      return {
        name: candidate,
        argumentsText: body.slice(candidate.length).trim(),
      };
    }
  }

  return null;
}

export function parseSlashInput(
  text: string,
  knownCommandNames: readonly string[] = []
): { name: string; argumentsText: string } | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith("/")) return null;

  const body = trimmed.slice(1).trim();
  if (!body) return null;

  const known = parseWithKnownCommandNames(body, knownCommandNames);
  if (known) return known;

  const [name = "", ...rest] = body.split(/\s+/);
  if (!name) return null;

  return {
    name,
    argumentsText: rest.join(" ").trim(),
  };
}

export function findLocalSlashCommand(commands: LocalSlashCommand[], name: string): LocalSlashCommand | null {
  const normalized = normalizeCommandName(name);
  if (!normalized) return null;

  for (const command of commands) {
    if (normalizeCommandName(command.name) === normalized) return command;
    if (command.aliases.some((alias) => normalizeCommandName(alias) === normalized)) return command;
  }

  return null;
}

export function localSlashCommandsToAutocompleteItems(commands: LocalSlashCommand[]): AutocompleteItem[] {
  return commands.map((command) => ({
    label: `/${command.name}`,
    value: `/${command.name}`,
    description: command.description,
    category: "command",
    icon: command.icon,
  }));
}

export function createLocalSlashCommands(deps: LocalSlashDependencies): LocalSlashCommand[] {
  return [
    {
      name: "new",
      aliases: ["reset", "clear"],
      description: "New session",
      icon: "+",
      execute: () => {
        deps.syncActions.reset();
        deps.route.navigate({ route: "home" });
      },
    },
    {
      name: "status",
      aliases: [],
      description: "Show status",
      icon: "i",
      execute: async () => {
        const { openStatusDialog } = await import("../dialog-status");
        openStatusDialog(deps.dialog as any);
      },
    },
    {
      name: "hctx",
      aliases: ["harness-context"],
      description: "Get harness context or set defaults (/hctx set)",
      icon: "h",
      execute: (argumentsText) => {
        const trimmed = argumentsText.trim();
        if (!trimmed) {
          deps.syncActions.requestHarnessContext();
          return;
        }

        if (trimmed === "set" || trimmed.startsWith("set ")) {
          const objective = trimmed.slice(3).trim();
          deps.syncActions.setHarnessContext(buildDefaultHarnessContext(objective));
          return;
        }

        deps.syncActions.requestHarnessContext();
      },
    },
    {
      name: "help",
      aliases: [],
      description: "Show help",
      icon: "?",
      execute: async () => {
        const { openHelpDialog } = await import("../../ui/dialog-help");
        openHelpDialog(deps.dialog as any);
      },
    },
    {
      name: "models",
      aliases: ["model"],
      description: "Switch model",
      icon: "m",
      execute: async () => {
        const { openModelPicker } = await import("../dialog-model");
        openModelPicker(deps.dialog as any);
      },
    },
    {
      name: "themes",
      aliases: ["theme"],
      description: "Change theme",
      icon: "t",
      execute: async () => {
        const { openThemePicker } = await import("../dialog-theme-list");
        openThemePicker(deps.dialog as any);
      },
    },
    {
      name: "connect",
      aliases: [],
      description: "Connect provider",
      icon: "c",
      execute: async (argumentsText) => {
        if (argumentsText) {
          const [provider = "", ...rest] = argumentsText.trim().split(/\s+/).filter(Boolean);
          if (!provider) {
            const { openProviderDialog } = await import("../dialog-provider");
            openProviderDialog(deps.dialog as any);
            return;
          }
          const apiKey = rest.join(" ").trim();
          if (apiKey) {
            deps.syncActions.setProviderApiKey(provider, "api_key", apiKey);
            return;
          }
          const { openProviderDialogForProvider } = await import("../dialog-provider");
          openProviderDialogForProvider(deps.dialog as any, provider);
          return;
        }

        const { openProviderDialog } = await import("../dialog-provider");
        openProviderDialog(deps.dialog as any);
      },
    },
    {
      name: "sessions",
      aliases: [],
      description: "Show sessions",
      icon: "s",
      execute: async () => {
        const { openSessionList } = await import("../dialog-session-list");
        openSessionList(deps.dialog as any);
      },
    },
    {
      name: "mcp",
      aliases: [],
      description: "Show MCP status",
      icon: "p",
      execute: async () => {
        const { openMcpDialog } = await import("../dialog-mcp");
        openMcpDialog(deps.dialog as any);
      },
    },
    {
      name: "cancel",
      aliases: [],
      description: "Cancel current turn",
      icon: "!",
      execute: () => {
        deps.syncActions.cancel();
      },
    },
    {
      name: "exit",
      aliases: ["quit"],
      description: "Exit",
      icon: "q",
      execute: () => {
        deps.exit.exit();
      },
    },
  ];
}
