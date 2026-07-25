import type { CoworkRuntimeBootstrapProgress } from "../../coworkRuntime/types";
import type { CodexAppServerInstallStatus } from "../../providers/codexAppServerResolver";
import type { ProviderCatalogPayload } from "../../providers/connectionCatalog";
import type { LmStudioLocalStatus } from "../../providers/lmstudio/local";
import {
  COWORK_RUNTIME_STARTING_MESSAGE,
  type CreationPreflightParams,
  type CreationPreflightResult,
  type CreationReadinessCheck,
} from "../../shared/creationReadiness";
import type { AgentConfig } from "../../types";
import { hasGoogleResearchApiKey } from "../research/googleApiKey";

export type CreationPreflightDependencies = {
  config: AgentConfig;
  resolveWorkspace: (cwd: string | undefined) => string;
  getProviderCatalog: () => Promise<ProviderCatalogPayload>;
  getRuntimeStartup: () => {
    ready: boolean;
    error?: string;
    progress?: CoworkRuntimeBootstrapProgress | null;
  };
  getLmStudioStatus?: () => Promise<LmStudioLocalStatus>;
  getCodexAppServerStatus?: () => Promise<CodexAppServerInstallStatus>;
  hasResearchCredentials?: () => boolean;
};

/**
 * Names the setup step currently running so a two-minute first launch reads as
 * progress rather than as an opaque wait.
 */
function startupProgressMessage(
  progress: CoworkRuntimeBootstrapProgress | null | undefined,
): string {
  if (!progress) return COWORK_RUNTIME_STARTING_MESSAGE;
  switch (progress.phase) {
    case "waiting":
      return "Another Cowork window is finishing the one-time setup.";
    case "downloading":
      return progress.percent === null
        ? "Downloading the Cowork runtime."
        : `Downloading the Cowork runtime — ${Math.round(progress.percent)}%.`;
    case "installing":
      return "Verifying and installing the Cowork runtime.";
    default:
      return COWORK_RUNTIME_STARTING_MESSAGE;
  }
}

/** Pending checks resolve without user action, so only blocked checks gate creation. */
function isReady(checks: CreationReadinessCheck[]): boolean {
  return checks.every((entry) => entry.status !== "blocked");
}

function check(
  id: CreationReadinessCheck["id"],
  status: CreationReadinessCheck["status"],
  message: string,
  repairAction?: CreationReadinessCheck["repairAction"],
): CreationReadinessCheck {
  return {
    id,
    status,
    message,
    ...(repairAction ? { repairAction } : {}),
  };
}

async function appendRuntimeChecks(
  checks: CreationReadinessCheck[],
  provider: AgentConfig["provider"] | undefined,
  deps: CreationPreflightDependencies,
): Promise<void> {
  const startup = deps.getRuntimeStartup();
  if (!startup.ready) {
    // Startup bootstrap resolves on its own and `turn/start` already awaits it,
    // so this is pending work, not a blocker the person has to act on.
    checks.push(
      startup.error
        ? check("runtime_ready", "blocked", `Cowork runtime failed to start: ${startup.error}`)
        : check("runtime_ready", "pending", startupProgressMessage(startup.progress)),
    );
    return;
  }

  if (provider === "lmstudio" && deps.getLmStudioStatus) {
    const status = await deps.getLmStudioStatus();
    checks.push(
      status.running
        ? check("runtime_ready", "ok", `LM Studio is running at ${status.baseUrl}.`)
        : check(
            "runtime_ready",
            "blocked",
            status.message ?? `LM Studio is not running at ${status.baseUrl}.`,
            {
              type: "startLmStudio",
              baseUrl: status.baseUrl,
              canAutoStart: status.canAutoStart,
            },
          ),
    );
    return;
  }

  if (provider === "codex-cli" && deps.getCodexAppServerStatus) {
    const status = await deps.getCodexAppServerStatus();
    checks.push(
      status.available
        ? check("runtime_ready", "ok", "Codex app-server is available.")
        : check("runtime_ready", "blocked", status.message, {
            type: "installCodexRuntime",
          }),
    );
    return;
  }

  checks.push(check("runtime_ready", "ok", "Runtime is ready."));
}

export async function runCreationPreflight(
  params: CreationPreflightParams,
  deps: CreationPreflightDependencies,
): Promise<CreationPreflightResult> {
  const checks: CreationReadinessCheck[] = [];

  try {
    const workspace = deps.resolveWorkspace(params.cwd);
    checks.push(check("project_access", "ok", `Workspace is accessible: ${workspace}`));
  } catch (error) {
    checks.push(
      check(
        "project_access",
        "blocked",
        error instanceof Error ? error.message : "The selected workspace is not accessible.",
      ),
    );
    return { ready: false, checks };
  }

  if (params.kind === "research") {
    const hasCredentials = deps.hasResearchCredentials?.() ?? hasGoogleResearchApiKey(deps.config);
    checks.push(
      hasCredentials
        ? check("research_credentials", "ok", "Google Deep Research credentials are available.")
        : check(
            "research_credentials",
            "blocked",
            "Connect Google with an API key to use Deep Research.",
            { type: "connectProvider", provider: "google" },
          ),
    );
    await appendRuntimeChecks(checks, undefined, deps);
    return { ready: isReady(checks), checks };
  }

  const provider = params.provider ?? deps.config.provider;
  const model = params.model ?? deps.config.model;
  let catalog: ProviderCatalogPayload;
  try {
    catalog = await deps.getProviderCatalog();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    checks.push(
      check("provider_connected", "blocked", `Provider status could not be loaded: ${message}`, {
        type: "openProviderSettings",
        provider,
      }),
    );
    await appendRuntimeChecks(checks, provider, deps);
    return { ready: false, checks };
  }

  const providerEntry = catalog.all.find((entry) => entry.id === provider);
  const providerReachable = providerEntry !== undefined && providerEntry.state !== "unreachable";
  checks.push(
    providerReachable
      ? check("provider_connected", "ok", `${providerEntry.name} is available.`)
      : check(
          "provider_connected",
          "blocked",
          providerEntry?.message ?? `Provider ${provider} is unavailable.`,
          { type: "openProviderSettings", provider },
        ),
  );

  const credentialsReady = provider === "lmstudio" || catalog.connected.includes(provider);
  checks.push(
    credentialsReady
      ? check("credentials", "ok", `Credentials for ${providerEntry?.name ?? provider} are ready.`)
      : check(
          "credentials",
          "blocked",
          `Connect ${providerEntry?.name ?? provider} before starting this chat.`,
          { type: "connectProvider", provider },
        ),
  );

  const selectedModel = providerEntry?.models.find(
    (entry) => entry.id === model || entry.model === model,
  );
  checks.push(
    selectedModel && selectedModel.enabled !== false
      ? check("model_available", "ok", `${selectedModel.displayName} is available.`)
      : check(
          "model_available",
          "blocked",
          `Model ${model} is not available for ${providerEntry?.name ?? provider}.`,
          { type: "openProviderSettings", provider },
        ),
  );

  await appendRuntimeChecks(checks, provider, deps);
  return { ready: isReady(checks), checks };
}
