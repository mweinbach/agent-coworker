import { useMemo, useState } from "react";

import {
  GroupedRow,
  GroupedScreen,
  GroupedSection,
  GroupedValueRow,
} from "@/components/pairing/grouped-list";
import { HubLinkRow } from "@/components/ui/hub-link-row";
import { WorkspaceSwitcher } from "@/components/workspace/workspace-switcher";
import {
  describeComposerCapabilityAvailability,
  resolveComposerCapabilityAvailability,
} from "@/features/cowork/model-capability-availability";
import { useProviderStore } from "@/features/cowork/providerStore";
import { useWorkspaceStore } from "@/features/cowork/workspaceStore";
import { usePairingStore } from "@/features/pairing/pairingStore";
import {
  describeTransportStatus,
  isWorkspaceConnectionReady,
} from "@/features/relay/connectionState";

export default function WorkspaceHubScreen() {
  const activeWorkspaceName = useWorkspaceStore((state) => state.activeWorkspaceName);
  const activeWorkspaceCwd = useWorkspaceStore((state) => state.activeWorkspaceCwd);
  const controlSnapshot = useWorkspaceStore((state) => state.controlSnapshot);
  const workspaces = useWorkspaceStore((state) => state.workspaces);
  const providerCatalog = useProviderStore((state) => state.catalog);
  const connectionState = usePairingStore((state) => state.connectionState);
  const isConnected = isWorkspaceConnectionReady(connectionState);
  const [switcherVisible, setSwitcherVisible] = useState(false);

  const capability = useMemo(
    () =>
      resolveComposerCapabilityAvailability({
        connected: isConnected,
        providerId: controlSnapshot?.config?.provider,
        modelId: controlSnapshot?.config?.model,
        catalog: providerCatalog,
        attachmentPickerAvailable: false,
      }),
    [
      controlSnapshot?.config?.model,
      controlSnapshot?.config?.provider,
      isConnected,
      providerCatalog,
    ],
  );

  const modelValue =
    capability.model.availability === "unavailable"
      ? `${capability.model.label} · Unavailable`
      : capability.model.label;

  return (
    <>
      <GroupedScreen>
        <GroupedSection
          title="Current workspace"
          footer={
            activeWorkspaceCwd ?? "Pair with a desktop to select and configure a live workspace."
          }
        >
          <GroupedValueRow label="Connection" value={describeTransportStatus(connectionState)} />
          <GroupedValueRow label="Workspace" value={activeWorkspaceName ?? "None"} />
          <GroupedRow
            label="Switch workspace"
            detail={`${workspaces.length} available`}
            onPress={() => setSwitcherVisible(true)}
            isLast
          />
        </GroupedSection>

        <GroupedSection
          title="Model availability"
          footer={describeComposerCapabilityAvailability(capability)}
        >
          <GroupedValueRow label="Provider" value={capability.provider.label} />
          <GroupedValueRow label="Model" value={modelValue} />
          <GroupedValueRow label="Attachments" value={capability.attachments.label} isLast />
        </GroupedSection>

        <GroupedSection title="Workspace editors" footer="Changes apply to the active workspace.">
          <HubLinkRow
            label="General"
            description="Provider, model routing, MCP, and backup defaults."
            detail={controlSnapshot?.config?.provider ?? "Not set"}
            href="/workspace/general"
            icon="gearshape.2"
          />
          <HubLinkRow
            label="Memory"
            description="Workspace and user memory entries."
            detail={controlSnapshot?.settings?.enableMemory ? "On" : "Off"}
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

        <GroupedSection title="Related controls">
          <HubLinkRow
            label="Providers"
            description="Authorization, model catalogs, and limits."
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
      </GroupedScreen>

      <WorkspaceSwitcher visible={switcherVisible} onClose={() => setSwitcherVisible(false)} />
    </>
  );
}
