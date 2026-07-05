import { SettingsPage } from "../SettingsPrimitives";
import { ArchivedChatsPage } from "./ArchivedChatsPage";
import { MemoryPage } from "./MemoryPage";
import { ProvidersPage } from "./ProvidersPage";
import { ToolAccessTabs } from "./ToolAccessPage";
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
  return (
    <SettingsPage>
      <ToolAccessTabs />
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
