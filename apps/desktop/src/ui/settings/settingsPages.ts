import {
  ActivityIcon,
  ArchiveRestoreIcon,
  BarChart3Icon,
  BotIcon,
  FlaskConicalIcon,
  HistoryIcon,
  type LucideIcon,
  MonitorIcon,
  RefreshCcwIcon,
  ShieldCheckIcon,
  SlidersHorizontalIcon,
  UserRoundCogIcon,
  UsersRoundIcon,
  WifiIcon,
  WrenchIcon,
} from "lucide-react";
import type { SettingsPageId } from "../../app/types";

/** System Settings–style icon tile colors (see `--settings-tile-*` in tokens/base.css). */
type SettingsTileTint =
  | "blue"
  | "indigo"
  | "purple"
  | "pink"
  | "red"
  | "orange"
  | "green"
  | "teal"
  | "gray";

export type SettingsPageDefinition = {
  id: SettingsPageId;
  label: string;
  icon: LucideIcon;
  tint: SettingsTileTint;
};

export const SETTINGS_PAGE_META: Record<SettingsPageId, { title: string; description: string }> = {
  models: {
    title: "Models",
    description: "Provider health, model defaults, and subagent routing.",
  },
  subagents: {
    title: "Subagents",
    description: "Specialized child-agent profiles and scoped tool access.",
  },
  toolAccess: {
    title: "Tool Access",
    description: "Connect external tools and data sources.",
  },
  desktop: {
    title: "Desktop",
    description: "Menu bar, tray, and quick chat controls for the desktop app.",
  },
  defaults: {
    title: "Behavior",
    description: "Defaults for models, tools, and behavior everywhere.",
  },
  profileMemory: {
    title: "Profile & Memory",
    description: "How Cowork should understand you and what it should remember.",
  },
  remoteAccess: {
    title: "Remote access",
    description: "Pair a phone to this folder or chat over the relay when the app is open.",
  },
  backup: {
    title: "Backups",
    description: "Recovery snapshots and restore points for chat sessions.",
  },
  chats: {
    title: "Chats",
    description: "Archived chat history, restore actions, and retention.",
  },
  usage: {
    title: "Usage",
    description: "Token usage and estimated cost across sessions.",
  },
  privacyTelemetry: {
    title: "Privacy & Telemetry",
    description: "Optional crash reports, product analytics, and AI trace consent.",
  },
  experiments: {
    title: "Experiments",
    description: "Enable or disable experimental capabilities.",
  },
  diagnostics: {
    title: "Diagnostics",
    description: "Debug visibility, runtime checks, and advanced output handling.",
  },
  updates: {
    title: "Updates",
    description: "App version and restart-based updates.",
  },
  providers: {
    title: "Models",
    description: "Provider health, model defaults, and subagent routing.",
  },
  openAiNativeConnectors: {
    title: "Tool Access",
    description: "Connect external tools and data sources.",
  },
  mcp: {
    title: "Tool Access",
    description: "Connect external tools and data sources.",
  },
  workspaces: {
    title: "Behavior",
    description: "Defaults for models, tools, and behavior everywhere.",
  },
  memory: {
    title: "Profile & Memory",
    description: "How Cowork should understand you and what it should remember.",
  },
  featureFlags: {
    title: "Experiments",
    description: "Enable or disable experimental capabilities.",
  },
  developer: {
    title: "Diagnostics",
    description: "Debug visibility, runtime checks, and advanced output handling.",
  },
  archivedChats: {
    title: "Chats",
    description: "Archived chat history, restore actions, and retention.",
  },
};

export function getSettingsGroups(
  remoteAccessAvailable: boolean,
  opts: { includeDevelopmentPages?: boolean } = {},
): Array<{
  label: string;
  pages: SettingsPageDefinition[];
}> {
  const includeDevelopmentPages = opts.includeDevelopmentPages ?? true;
  return [
    {
      label: "Models & tools",
      pages: [
        { id: "models", label: "Models", icon: BotIcon, tint: "purple" },
        {
          id: "subagents",
          label: "Subagents",
          icon: UsersRoundIcon,
          tint: "indigo",
        },
        {
          id: "toolAccess",
          label: "Tool Access",
          icon: WrenchIcon,
          tint: "blue",
        },
      ],
    },
    {
      label: "Workspace",
      pages: [
        {
          id: "defaults",
          label: "Behavior",
          icon: SlidersHorizontalIcon,
          tint: "gray",
        },
        {
          id: "profileMemory",
          label: "Profile & Memory",
          icon: UserRoundCogIcon,
          tint: "pink",
        },
        ...(remoteAccessAvailable
          ? [
              {
                id: "remoteAccess",
                label: "Remote access",
                icon: WifiIcon,
                tint: "blue",
              } satisfies SettingsPageDefinition,
            ]
          : []),
      ],
    },
    {
      label: "History & Data",
      pages: [
        { id: "backup", label: "Backups", icon: ArchiveRestoreIcon, tint: "teal" },
        { id: "chats", label: "Chats", icon: HistoryIcon, tint: "orange" },
        { id: "usage", label: "Usage", icon: BarChart3Icon, tint: "green" },
      ],
    },
    {
      label: "App",
      pages: [
        {
          id: "privacyTelemetry",
          label: "Privacy & Telemetry",
          icon: ShieldCheckIcon,
          tint: "blue",
        },
        { id: "desktop", label: "Desktop", icon: MonitorIcon, tint: "teal" },
        { id: "updates", label: "Updates", icon: RefreshCcwIcon, tint: "gray" },
      ],
    },
    {
      label: "Advanced",
      pages: [
        ...(includeDevelopmentPages
          ? [
              {
                id: "experiments",
                label: "Experiments",
                icon: FlaskConicalIcon,
                tint: "orange",
              } satisfies SettingsPageDefinition,
            ]
          : []),
        {
          id: "diagnostics",
          label: "Diagnostics",
          icon: ActivityIcon,
          tint: "red",
        },
      ],
    },
  ];
}
