import type { OnboardingState, OnboardingStatus } from "./types";

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function asNonEmptyString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function normalizeOnboardingStatus(value: unknown): OnboardingStatus {
  if (value === "pending" || value === "dismissed" || value === "completed") {
    return value;
  }
  return "pending";
}

export function normalizePersistedOnboardingState(value: unknown): OnboardingState | undefined {
  if (!isRecord(value)) return undefined;

  const status = normalizeOnboardingStatus(value.status);
  const completedAt = value.completedAt === null ? null : (asNonEmptyString(value.completedAt) ?? null);
  const dismissedAt = value.dismissedAt === null ? null : (asNonEmptyString(value.dismissedAt) ?? null);

  // Only persist if status is not "pending" (i.e., user has interacted with onboarding)
  if (status === "pending" && !completedAt && !dismissedAt) {
    return undefined;
  }

  return {
    status,
    completedAt,
    dismissedAt,
  };
}

export function shouldShowOnboarding(opts: {
  onboardingState?: OnboardingState;
  hasWorkspaces: boolean;
  hasThreads: boolean;
  hasConnectedProviders: boolean;
}): boolean {
  // If onboarding is explicitly dismissed or completed, don't show it
  if (opts.onboardingState?.status === "dismissed" || opts.onboardingState?.status === "completed") {
    return false;
  }

  // If user has meaningful usage, treat as existing user and don't show onboarding
  if (opts.hasWorkspaces || opts.hasThreads || opts.hasConnectedProviders) {
    return false;
  }

  // Otherwise, show onboarding for new users
  return true;
}
