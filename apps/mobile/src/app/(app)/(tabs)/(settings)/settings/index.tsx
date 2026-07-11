import {
  GroupedScreen,
  GroupedSection,
  GroupedSwitchRow,
  GroupedValueRow,
} from "@/components/pairing/grouped-list";
import { HubLinkRow } from "@/components/ui/hub-link-row";
import { useWorkspaceStore } from "@/features/cowork/workspaceStore";
import { usePairingStore } from "@/features/pairing/pairingStore";
import { useDisplayPreferencesStore } from "@/features/preferences/displayPreferencesStore";
import {
  describeTransportStatus,
  isWorkspaceConnectionReady,
} from "@/features/relay/connectionState";

export default function SettingsHubScreen() {
  const activeWorkspaceName = useWorkspaceStore((state) => state.activeWorkspaceName);
  const activeWorkspaceCwd = useWorkspaceStore((state) => state.activeWorkspaceCwd);
  const controlSnapshot = useWorkspaceStore((state) => state.controlSnapshot);
  const connectionState = usePairingStore((state) => state.connectionState);
  const isConnected = isWorkspaceConnectionReady(connectionState);
  const showDebugMessages = useDisplayPreferencesStore((state) => state.showDebugMessages);
  const setShowDebugMessages = useDisplayPreferencesStore((state) => state.setShowDebugMessages);

  return (
    <GroupedScreen>
      <GroupedSection
        title="Connection"
        footer={
          activeWorkspaceCwd ??
          "Pair with a desktop to populate the live workspace context on this device."
        }
      >
        <GroupedValueRow label="Status" value={describeTransportStatus(connectionState)} />
        <GroupedValueRow label="Active workspace" value={activeWorkspaceName ?? "None"} />
        <HubLinkRow
          label="Remote access"
          description="Pair, reconnect, and inspect trusted computers."
          detail={isConnected ? "Connected" : "Set up"}
          href="/(pairing)"
          icon="iphone.and.arrow.forward"
          isLast
        />
      </GroupedSection>

      <GroupedSection
        title="Workspace controls"
        footer="These controls use the live workspace session from the paired desktop."
      >
        <HubLinkRow
          label="Providers"
          description="Authorization, model availability, and account limits."
          detail={controlSnapshot?.config?.provider ?? "Not set"}
          href="/settings/providers"
          icon="person.crop.circle.badge.checkmark"
        />
        <HubLinkRow
          label="Integrations"
          description="MCP servers, authentication, and validation."
          detail={controlSnapshot?.settings?.enableMcp ? "On" : "Off"}
          href="/settings/mcp"
          icon="puzzlepiece.extension"
        />
        <HubLinkRow
          label="Usage"
          description="Threads, tokens, and estimated spend."
          href="/settings/usage"
          icon="chart.bar"
          isLast
        />
      </GroupedSection>

      <GroupedSection title="Display">
        <GroupedSwitchRow
          label="Show debug messages"
          description="Include system and observability lines in chat transcripts."
          value={showDebugMessages}
          onValueChange={setShowDebugMessages}
          isLast
        />
      </GroupedSection>

      <GroupedSection
        title="Workspace editors"
        footer="Changes apply to the currently selected project workspace."
      >
        <HubLinkRow
          label="General"
          description="Provider, model routing, MCP, and backup defaults."
          href="/workspace/general"
          icon="gearshape.2"
        />
        <HubLinkRow
          label="Memory"
          description="Workspace and user memory entries."
          href="/workspace/memory"
          icon="brain.head.profile"
        />
        <HubLinkRow
          label="Backups"
          description="Create, restore, and clean up checkpoints."
          href="/workspace/backups"
          icon="externaldrive.badge.timemachine"
          isLast
        />
      </GroupedSection>
    </GroupedScreen>
  );
}
