import { useAppStore } from "../../../app/store";
import { SettingsPage } from "../SettingsPrimitives";
import { ArchivedChatsPage } from "./ArchivedChatsPage";
import { McpServersPage } from "./McpServersPage";
import { MemoryPage } from "./MemoryPage";
import { OpenAiNativeConnectorsPage } from "./OpenAiNativeConnectorsPage";
import { ProvidersPage } from "./ProvidersPage";
import { WorkspacesPage } from "./WorkspacesPage";

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

  return (
    <SettingsPage>
      <ProvidersPage surface="tools" />
      <McpServersPage />
      {openAiNativeConnectorsAvailable ? <OpenAiNativeConnectorsPage /> : null}
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
