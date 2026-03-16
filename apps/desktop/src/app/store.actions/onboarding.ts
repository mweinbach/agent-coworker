import type { AppStoreActions, StoreGet, StoreSet } from "../store.helpers";
import type { OnboardingState, OnboardingStep } from "../types";
import { nowIso, persistNow } from "../store.helpers";

export function createOnboardingActions(set: StoreSet, get: StoreGet): Pick<AppStoreActions, "startOnboarding" | "dismissOnboarding" | "completeOnboarding" | "setOnboardingStep" | "nextOnboardingStep" | "previousOnboardingStep"> {
  const steps: OnboardingStep[] = ["welcome", "workspace", "provider", "defaults", "firstThread"];

  return {
    startOnboarding: () => {
      set({
        onboardingVisible: true,
        onboardingStep: "welcome",
      });
    },

    dismissOnboarding: () => {
      const onboardingState: OnboardingState = {
        status: "dismissed",
        completedAt: null,
        dismissedAt: nowIso(),
      };
      set({
        onboardingVisible: false,
        onboardingState,
      });
      void persistNow(get);
    },

    completeOnboarding: () => {
      const onboardingState: OnboardingState = {
        status: "completed",
        completedAt: nowIso(),
        dismissedAt: null,
      };
      set({
        onboardingVisible: false,
        onboardingState,
      });
      void persistNow(get);
    },

    setOnboardingStep: (step: OnboardingStep) => {
      set({ onboardingStep: step });
    },

    nextOnboardingStep: () => {
      const current = get().onboardingStep;
      const currentIndex = steps.indexOf(current);
      if (currentIndex < steps.length - 1) {
        set({ onboardingStep: steps[currentIndex + 1]! });
      }
    },

    previousOnboardingStep: () => {
      const current = get().onboardingStep;
      const currentIndex = steps.indexOf(current);
      if (currentIndex > 0) {
        set({ onboardingStep: steps[currentIndex - 1]! });
      }
    },
  };
}
