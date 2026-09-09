import type { ProviderCatalogEntry } from "@/cowork-shared/jsonrpcControlSchemas";

type CapabilityAvailability = "available" | "unavailable" | "unknown";

export type ComposerCapabilityAvailability = {
  provider: {
    id: string | null;
    label: string;
    availability: CapabilityAvailability;
    authorizationMessage: string | null;
  };
  model: {
    id: string | null;
    label: string;
    availability: CapabilityAvailability;
    supportsImageInput: boolean | null;
  };
  attachments: {
    availability: CapabilityAvailability;
    label: string;
  };
};

export function resolveComposerCapabilityAvailability(input: {
  connected: boolean;
  providerId: string | null | undefined;
  modelId: string | null | undefined;
  catalog: readonly ProviderCatalogEntry[];
  providerStatus?: { authorized: boolean; message?: string } | null;
  attachmentPickerAvailable: boolean;
}): ComposerCapabilityAvailability {
  const providerId = input.providerId?.trim() || null;
  const modelId = input.modelId?.trim() || null;
  const providerEntry = providerId
    ? (input.catalog.find((provider) => provider.id === providerId) ?? null)
    : null;
  const modelEntry =
    providerEntry && modelId
      ? (providerEntry.models.find(
          (model) => model.id === modelId || (model.model ?? model.id) === modelId,
        ) ?? null)
      : null;

  const explicitlyUnauthorized = input.providerStatus?.authorized === false;
  const discoveryUnavailable =
    providerEntry?.state !== undefined &&
    providerEntry.state !== "ready" &&
    input.providerStatus?.authorized !== true;
  const providerUnavailable = !input.connected || explicitlyUnauthorized || discoveryUnavailable;
  const providerAvailability: CapabilityAvailability = !providerId
    ? "unknown"
    : providerUnavailable
      ? "unavailable"
      : providerEntry
        ? "available"
        : "unknown";
  const modelAvailability: CapabilityAvailability = !modelId
    ? "unknown"
    : providerUnavailable || modelEntry?.enabled === false
      ? "unavailable"
      : modelEntry
        ? "available"
        : "unknown";

  let attachmentAvailability: CapabilityAvailability = "unknown";
  let attachmentLabel = "Attachment support is unknown";
  if (!input.attachmentPickerAvailable) {
    attachmentAvailability = "unavailable";
    attachmentLabel = "Attachments unavailable in Cowork Mobile";
  } else if (modelAvailability === "unavailable") {
    attachmentAvailability = "unavailable";
    attachmentLabel = "Attachments unavailable for the selected model";
  } else if (modelEntry?.supportsImageInput === true) {
    attachmentAvailability = "available";
    attachmentLabel = "Image attachments available";
  } else if (modelEntry?.supportsImageInput === false) {
    attachmentAvailability = "unavailable";
    attachmentLabel = "Selected model does not accept images";
  }

  return {
    provider: {
      id: providerId,
      label: providerEntry?.name ?? providerId ?? "No provider selected",
      availability: providerAvailability,
      authorizationMessage: explicitlyUnauthorized
        ? input.providerStatus?.message?.trim() || "Finish provider setup in Settings > Providers."
        : null,
    },
    model: {
      id: modelId,
      label: modelEntry?.displayName ?? modelId ?? "No model selected",
      availability: modelAvailability,
      supportsImageInput: modelEntry?.supportsImageInput ?? null,
    },
    attachments: {
      availability: attachmentAvailability,
      label: attachmentLabel,
    },
  };
}

export function describeComposerCapabilityAvailability(
  capability: ComposerCapabilityAvailability,
): string {
  const providerStatus = capability.provider.authorizationMessage
    ? `${capability.provider.label}: ${capability.provider.authorizationMessage}`
    : capability.provider.label;
  const modelStatus =
    capability.model.availability === "unavailable"
      ? `${capability.model.label} unavailable`
      : capability.model.label;
  return `${providerStatus} · ${modelStatus} · ${capability.attachments.label}`;
}
