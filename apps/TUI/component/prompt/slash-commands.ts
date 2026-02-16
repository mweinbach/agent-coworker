import type { AutocompleteItem } from "./autocomplete";

type LocalSlashDependencies = {
  syncActions: {
    reset: () => void;
    cancel: () => void;
    connectProvider: (provider: string, apiKey?: string) => void;
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

export function parseSlashInput(text: string): { name: string; argumentsText: string } | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith("/")) return null;

  const body = trimmed.slice(1).trim();
  if (!body) return null;

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
          deps.syncActions.connectProvider(argumentsText);
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
