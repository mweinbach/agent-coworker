import { ExternalLinkIcon } from "lucide-react";
import { useState } from "react";

import { useAppStore } from "../../../app/store";
import { marketplaceRemovePendingKey } from "../../../app/store.actions/marketplaces";
import { operationKey } from "../../../app/store.helpers";
import type { MarketplaceDetail } from "../../../app/types";
import { Badge } from "../../../components/ui/badge";
import { Button } from "../../../components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "../../../components/ui/dialog";
import { Skeleton } from "../../../components/ui/skeleton";
import { confirmAction, openExternalUrl } from "../../../lib/desktopCommands";
import { OperationFeedback } from "../../OperationFeedback";
import { EntityIcon, SettingsSection } from "../SettingsPrimitives";

type MarketplaceDetailPlugin = MarketplaceDetail["plugins"][number];
type MarketplaceDetailSkill = MarketplaceDetail["skills"][number];

function DetailListSkeleton() {
  return (
    <div className="flex flex-col gap-2">
      <Skeleton className="h-12 w-full" />
      <Skeleton className="h-12 w-full" />
      <Skeleton className="h-12 w-full" />
    </div>
  );
}

function InstalledState({ enabled }: { enabled: boolean | undefined }) {
  return (
    <div className="flex shrink-0 items-center gap-2">
      <Badge variant="secondary">Installed</Badge>
      <span className="text-xs text-muted-foreground">{enabled ? "Enabled" : "Disabled"}</span>
    </div>
  );
}

/**
 * Everything one marketplace includes — plugins, standalone skills, and the
 * connectors its installed plugins contribute — assembled server-side by
 * `cowork/marketplaces/detail` and rendered here as a thin view.
 */
export function MarketplaceDetailDialog({ workspaceId }: { workspaceId: string }) {
  const runtime = useAppStore((s) => s.workspaceRuntimeById[workspaceId]);
  const selectMarketplace = useAppStore((s) => s.selectMarketplace);
  const readMarketplaceDetail = useAppStore((s) => s.readMarketplaceDetail);
  const installPlugins = useAppStore((s) => s.installPlugins);
  const installSkills = useAppStore((s) => s.installSkills);
  const removeMarketplace = useAppStore((s) => s.removeMarketplace);
  const operationsByKey = useAppStore((s) => s.operationsByKey);

  const [installingKey, setInstallingKey] = useState<string | null>(null);

  const selectedId = runtime?.selectedMarketplaceId ?? null;
  const detail = runtime?.selectedMarketplaceDetail ?? null;
  const detailLoading = runtime?.marketplaceDetailLoading ?? false;
  const detailError = runtime?.marketplaceDetailError ?? null;
  const listEntry = runtime?.marketplaces?.find((entry) => entry.id === selectedId) ?? null;
  const marketplacePendingKeys = runtime?.marketplaceMutationPendingKeys ?? {};
  const marketplaceMutationError = runtime?.marketplaceMutationError ?? null;
  const pluginPendingKeys = runtime?.pluginMutationPendingKeys ?? {};
  const skillPendingKeys = runtime?.skillMutationPendingKeys ?? {};

  const source = detail?.source ?? listEntry;
  const displayName = source?.displayName || source?.repo || selectedId || "";
  const removePending =
    selectedId !== null && marketplacePendingKeys[marketplaceRemovePendingKey(selectedId)] === true;
  const installPending =
    installingKey !== null ||
    Object.keys(pluginPendingKeys).some((key) => key.startsWith("plugin:install:")) ||
    Object.keys(skillPendingKeys).some((key) => key.startsWith("install:"));
  const selectedOperation =
    selectedId === null
      ? undefined
      : [
          operationsByKey[operationKey("marketplace", "remove", selectedId)],
          installingKey?.startsWith("plugin:")
            ? operationsByKey[operationKey("plugin", "install")]
            : undefined,
          installingKey?.startsWith("skill:")
            ? operationsByKey[operationKey("skill", "install")]
            : undefined,
        ].find((operation) => operation?.status === "pending" || operation?.status === "error");

  const handleOpenChange = (open: boolean) => {
    if (!open && !removePending && !installPending) {
      void selectMarketplace(null);
    }
  };

  const handleInstallPlugin = async (plugin: MarketplaceDetailPlugin) => {
    if (!plugin.installSource || selectedId === null) return;
    setInstallingKey(`plugin:${plugin.name}`);
    try {
      const result = await installPlugins(plugin.installSource, "user");
      if (result.ok) await readMarketplaceDetail(selectedId);
    } finally {
      setInstallingKey(null);
    }
  };

  const handleInstallSkill = async (skill: MarketplaceDetailSkill) => {
    if (!skill.installSource || selectedId === null) return;
    setInstallingKey(`skill:${skill.name}`);
    try {
      const result = await installSkills(skill.installSource, "global");
      if (result.ok) await readMarketplaceDetail(selectedId);
    } finally {
      setInstallingKey(null);
    }
  };

  const handleRemove = async () => {
    if (selectedId === null) return;
    const confirmed = await confirmAction({
      title: "Remove marketplace",
      message: `Remove "${displayName}"?`,
      detail:
        "Plugins and skills installed from this marketplace stay installed but will no longer receive updates from it.",
      confirmLabel: "Remove",
      cancelLabel: "Cancel",
      kind: "warning",
      defaultAction: "cancel",
    });
    if (!confirmed) return;
    const result = await removeMarketplace(selectedId);
    if (result.ok) {
      void selectMarketplace(null);
    }
  };

  if (selectedId === null) return null;

  return (
    <Dialog open={selectedId !== null} onOpenChange={handleOpenChange}>
      <DialogContent className="max-w-3xl max-h-[85vh] overflow-y-auto flex flex-col gap-0 p-0">
        <div className="border-b border-border/50 p-6 pb-4">
          <DialogHeader className="space-y-4">
            <div className="flex items-start gap-4">
              <EntityIcon name={displayName} size="lg" />
              <div className="space-y-1">
                <div className="flex flex-wrap items-center gap-2">
                  <DialogTitle className="text-xl">{displayName}</DialogTitle>
                  {source?.builtIn ? <Badge variant="secondary">Built-in</Badge> : null}
                </div>
                <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
                  {source ? (
                    <>
                      <span>{source.repo}</span>
                      <span>·</span>
                      <span>{source.ref}</span>
                      <Button
                        type="button"
                        variant="link"
                        className="h-auto p-0 text-muted-foreground hover:text-foreground"
                        onClick={() => {
                          void openExternalUrl({ url: source.url });
                        }}
                      >
                        <span className="flex items-center gap-1">
                          Open on GitHub <ExternalLinkIcon className="h-3 w-3" />
                        </span>
                      </Button>
                    </>
                  ) : null}
                </div>
                <DialogDescription className="sr-only">
                  What this marketplace includes.
                </DialogDescription>
              </div>
            </div>
          </DialogHeader>
        </div>

        <div className="flex-1 space-y-6 overflow-y-auto p-6">
          {marketplaceMutationError ? (
            <div className="rounded-lg border border-destructive/35 bg-destructive/5 px-3 py-3 text-sm text-destructive">
              {marketplaceMutationError}
            </div>
          ) : null}
          <OperationFeedback operation={selectedOperation} />

          {detailError ? (
            <div className="flex items-center gap-3 rounded-lg border border-destructive/35 bg-destructive/5 px-3 py-3">
              <span className="min-w-0 flex-1 text-sm text-destructive">{detailError}</span>
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={detailLoading}
                onClick={() => void readMarketplaceDetail(selectedId)}
              >
                Retry
              </Button>
            </div>
          ) : null}

          {detail === null && detailError === null ? (
            <DetailListSkeleton />
          ) : detail !== null ? (
            <>
              {detail.plugins.length > 0 ? (
                <SettingsSection title="Plugins">
                  {detail.plugins.map((plugin) => (
                    <div key={plugin.name} className="flex items-center gap-3 px-4 py-3">
                      <EntityIcon src={plugin.icon} name={plugin.displayName} />
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-sm font-medium text-foreground">
                          {plugin.displayName}
                        </div>
                        {plugin.category ? (
                          <div className="truncate text-xs text-muted-foreground">
                            {plugin.category}
                          </div>
                        ) : null}
                      </div>
                      {plugin.installed ? (
                        <InstalledState enabled={plugin.enabled} />
                      ) : plugin.installSource ? (
                        <Button
                          type="button"
                          size="sm"
                          variant="secondary"
                          className="shrink-0"
                          disabled={installPending}
                          onClick={() => void handleInstallPlugin(plugin)}
                        >
                          {installingKey === `plugin:${plugin.name}` ? "Installing..." : "Install"}
                        </Button>
                      ) : null}
                    </div>
                  ))}
                </SettingsSection>
              ) : null}

              {detail.skills.length > 0 ? (
                <SettingsSection title="Skills">
                  {detail.skills.map((skill) => (
                    <div key={skill.name} className="flex items-center gap-3 px-4 py-3">
                      <EntityIcon src={skill.icon} name={skill.displayName} />
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-sm font-medium text-foreground">
                          {skill.displayName}
                        </div>
                        {skill.category ? (
                          <div className="truncate text-xs text-muted-foreground">
                            {skill.category}
                          </div>
                        ) : null}
                      </div>
                      {skill.installed ? (
                        <InstalledState enabled={skill.enabled} />
                      ) : skill.installSource ? (
                        <Button
                          type="button"
                          size="sm"
                          variant="secondary"
                          className="shrink-0"
                          disabled={installPending}
                          onClick={() => void handleInstallSkill(skill)}
                        >
                          {installingKey === `skill:${skill.name}` ? "Installing..." : "Install"}
                        </Button>
                      ) : null}
                    </div>
                  ))}
                </SettingsSection>
              ) : null}

              <SettingsSection title="Connectors">
                {detail.connectors.length === 0 ? (
                  <div className="px-4 py-3 text-xs text-muted-foreground">
                    Connectors appear here once a plugin that provides them is installed.
                  </div>
                ) : (
                  detail.connectors.map((connector) => (
                    <div
                      key={`${connector.pluginName}:${connector.name}`}
                      className="flex items-center gap-3 px-4 py-3"
                    >
                      <EntityIcon name={connector.name} />
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-sm font-medium text-foreground">
                          {connector.name}
                        </div>
                        <div className="truncate text-xs text-muted-foreground">
                          via {connector.pluginDisplayName}
                        </div>
                      </div>
                    </div>
                  ))
                )}
              </SettingsSection>
            </>
          ) : null}
        </div>

        <div className="flex items-center justify-between border-t border-border/50 bg-muted/10 p-4">
          <div className="flex items-center gap-2">
            {source && !source.builtIn ? (
              <Button
                type="button"
                variant="destructive"
                size="sm"
                disabled={removePending}
                onClick={() => void handleRemove()}
              >
                {removePending ? "Removing..." : "Remove marketplace"}
              </Button>
            ) : null}
          </div>
          <Button
            type="button"
            size="sm"
            disabled={removePending || installPending}
            onClick={() => handleOpenChange(false)}
          >
            Close
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
