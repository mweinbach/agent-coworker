import type { AppStoreActions, StoreGet, StoreSet } from "../store.helpers";
import { nowIso, persistNow } from "../store.helpers";
import type { OnboardingStep, PersistedOnboardingState } from "../types";

export const DEFAULT_ONBOARDING_STATE: PersistedOnboardingState = {
  status: "pending",
  completedAt: null,
  dismissedAt: null,
};

/**
 * Pure helper: determines whether onboarding should auto-open on startup.
 * Returns true when the user has no meaningful desktop usage and onboarding
 * has not been dismissed or completed.
 */
export function shouldAutoOpenOnboarding(opts: {
  onboarding: PersistedOnboardingState | undefined;
  workspaceCount: number;
  threadCount: number;
  hasConnectedProvider: boolean;
}): boolean {
  const ob = opts.onboarding ?? DEFAULT_ONBOARDING_STATE;

  // Already dismissed or completed — never auto-open.
  if (ob.status === "dismissed" || ob.status === "completed") {
    return false;
  }

  // If the user already has meaningful state, treat as existing user.
  const isExistingUser =
    opts.workspaceCount > 0 || opts.threadCount > 0 || opts.hasConnectedProvider;

  return !isExistingUser;
}

/**
 * Returns true when an existing user is detected but the onboarding metadata
 * is still "pending" — indicating the field was added after they started
 * using the app. In that case we should silently mark onboarding as completed.
 */
export function shouldBackfillOnboardingCompleted(opts: {
  onboarding: PersistedOnboardingState | undefined;
  workspaceCount: number;
  threadCount: number;
  hasConnectedProvider: boolean;
}): boolean {
  const ob = opts.onboarding ?? DEFAULT_ONBOARDING_STATE;
  if (ob.status !== "pending") return false;

  return opts.workspaceCount > 0 || opts.threadCount > 0 || opts.hasConnectedProvider;
}

export function createOnboardingActions(
  set: StoreSet,
  get: StoreGet,
): Pick<
  AppStoreActions,
  "startOnboarding" | "dismissOnboarding" | "completeOnboarding" | "setOnboardingStep"
> {
  return {
    startOnboarding: () => {
      set({
        onboardingVisible: true,
        onboardingStep: "welcome",
      });
    },

    dismissOnboarding: () => {
      const now = nowIso();
      const nextState: PersistedOnboardingState = {
        status: "dismissed",
        completedAt: get().onboardingState.completedAt,
        dismissedAt: now,
      };
      set({
        onboardingVisible: false,
        onboardingStep: "welcome",
        onboardingState: nextState,
      });
      void persistNow(get);
    },

    completeOnboarding: () => {
      const now = nowIso();
      const nextState: PersistedOnboardingState = {
        status: "completed",
        completedAt: now,
        dismissedAt: get().onboardingState.dismissedAt,
      };
      set({
        onboardingVisible: false,
        onboardingStep: "welcome",
        onboardingState: nextState,
      });
      void persistNow(get);
    },

    setOnboardingStep: (step: OnboardingStep) => {
      set({ onboardingStep: step });
    },
  };
}
