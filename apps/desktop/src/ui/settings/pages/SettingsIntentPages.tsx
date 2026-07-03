import { PackageIcon } from "lucide-react";
import { useMemo } from "react";

import { useAppStore } from "../../../app/store";
import { SettingsEmptyState, SettingsPage } from "../SettingsPrimitives";
import { ArchivedChatsPage } from "./ArchivedChatsPage";
import { McpServersPage } from "./McpServersPage";
import { MemoryPage } from "./MemoryPage";
import { OpenAiNativeConnectorsPage } from "./OpenAiNativeConnectorsPage";
import { ProvidersPage } from "./ProvidersPage";
import { ToolAccessCatalogSections, useToolAccessCatalogWorkspaceId } from "./ToolAccessPage";
import { SearchSettingsCard, WorkspacesPage } from "./WorkspacesPage";

export function ModelsSettingsPage() {
  return (
    <SettingsPage>
      <ProvidersPage surface="models" />
      <WorkspacesPage surface="models" />
    </SettingsPage>
  );
}

export function ToolAccessSettingsPage() {
  const openAiNativeConnectorsAvailable = useAppStore(
    (s) => s.desktopFeatureFlags.openAiNativeConnectors === true,
  );
  const catalogWorkspaceId = useToolAccessCatalogWorkspaceId();
  const workspaces = useAppStore((s) => s.workspaces);
  const providerStatusByName = useAppStore((s) => s.providerStatusByName);
  const updateWorkspaceDefaults = useAppStore((s) => s.updateWorkspaceDefaults);
  const workspace = useMemo(
    () =>
      catalogWorkspaceId
        ? (workspaces.find((entry) => entry.id === catalogWorkspaceId) ?? null)
        : null,
    [workspaces, catalogWorkspaceId],
  );

  return (
    <SettingsPage>
      {catalogWorkspaceId ? (
        <ToolAccessCatalogSections workspaceId={catalogWorkspaceId} />
      ) : (
        <SettingsEmptyState
          icon={<PackageIcon />}
          title="Pick a workspace"
          description="Select a workspace to load plugin, skill, and MCP server catalogs."
        />
      )}
      <McpServersPage />
      {openAiNativeConnectorsAvailable ? <OpenAiNativeConnectorsPage /> : null}
      {workspace ? (
        <SearchSettingsCard
          workspace={workspace}
          updateWorkspaceDefaults={updateWorkspaceDefaults}
          providerStatusByName={providerStatusByName}
        />
      ) : null}
      <ProvidersPage surface="tools" />
    </SettingsPage>
  );
}

export function DefaultsSettingsPage() {
  return (
    <SettingsPage>
      <WorkspacesPage surface="defaults" />
    </SettingsPage>
  );
}

export function ProfileMemorySettingsPage() {
  return (
    <SettingsPage>
      <WorkspacesPage surface="profile" />
      <MemoryPage />
    </SettingsPage>
  );
}

export function ChatsSettingsPage() {
  return (
    <SettingsPage>
      <ArchivedChatsPage />
    </SettingsPage>
  );
}
