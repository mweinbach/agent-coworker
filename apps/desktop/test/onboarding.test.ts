import { describe, expect, test } from "bun:test";

import { normalizePersistedOnboardingState, shouldShowOnboarding } from "../src/app/persistedOnboardingState";
import type { OnboardingState } from "../src/app/types";

describe("onboarding state normalization", () => {
  test("normalizes valid onboarding state", () => {
    const input = {
      status: "completed",
      completedAt: "2024-01-01T00:00:00.000Z",
      dismissedAt: null,
    };
    const result = normalizePersistedOnboardingState(input);
    expect(result).toEqual({
      status: "completed",
      completedAt: "2024-01-01T00:00:00.000Z",
      dismissedAt: null,
    });
  });

  test("normalizes dismissed state", () => {
    const input = {
      status: "dismissed",
      completedAt: null,
      dismissedAt: "2024-01-01T00:00:00.000Z",
    };
    const result = normalizePersistedOnboardingState(input);
    expect(result).toEqual({
      status: "dismissed",
      completedAt: null,
      dismissedAt: "2024-01-01T00:00:00.000Z",
    });
  });

  test("returns undefined for pending state with no timestamps", () => {
    const input = {
      status: "pending",
      completedAt: null,
      dismissedAt: null,
    };
    const result = normalizePersistedOnboardingState(input);
    expect(result).toBeUndefined();
  });

  test("returns undefined for invalid input", () => {
    expect(normalizePersistedOnboardingState(null)).toBeUndefined();
    expect(normalizePersistedOnboardingState(undefined)).toBeUndefined();
    expect(normalizePersistedOnboardingState("invalid")).toBeUndefined();
    expect(normalizePersistedOnboardingState([])).toBeUndefined();
  });

  test("normalizes invalid status to pending", () => {
    const input = {
      status: "invalid",
      completedAt: null,
      dismissedAt: null,
    };
    const result = normalizePersistedOnboardingState(input);
    expect(result).toBeUndefined(); // pending with no timestamps returns undefined
  });
});

describe("shouldShowOnboarding", () => {
  test("returns false for dismissed onboarding", () => {
    const onboardingState: OnboardingState = {
      status: "dismissed",
      completedAt: null,
      dismissedAt: "2024-01-01T00:00:00.000Z",
    };
    expect(
      shouldShowOnboarding({
        onboardingState,
        hasWorkspaces: false,
        hasThreads: false,
        hasConnectedProviders: false,
      }),
    ).toBe(false);
  });

  test("returns false for completed onboarding", () => {
    const onboardingState: OnboardingState = {
      status: "completed",
      completedAt: "2024-01-01T00:00:00.000Z",
      dismissedAt: null,
    };
    expect(
      shouldShowOnboarding({
        onboardingState,
        hasWorkspaces: false,
        hasThreads: false,
        hasConnectedProviders: false,
      }),
    ).toBe(false);
  });

  test("returns false for existing users with workspaces", () => {
    expect(
      shouldShowOnboarding({
        onboardingState: undefined,
        hasWorkspaces: true,
        hasThreads: false,
        hasConnectedProviders: false,
      }),
    ).toBe(false);
  });

  test("returns false for existing users with threads", () => {
    expect(
      shouldShowOnboarding({
        onboardingState: undefined,
        hasWorkspaces: false,
        hasThreads: true,
        hasConnectedProviders: false,
      }),
    ).toBe(false);
  });

  test("returns false for existing users with connected providers", () => {
    expect(
      shouldShowOnboarding({
        onboardingState: undefined,
        hasWorkspaces: false,
        hasThreads: false,
        hasConnectedProviders: true,
      }),
    ).toBe(false);
  });

  test("returns true for new users", () => {
    expect(
      shouldShowOnboarding({
        onboardingState: undefined,
        hasWorkspaces: false,
        hasThreads: false,
        hasConnectedProviders: false,
      }),
    ).toBe(true);
  });

  test("returns true for pending state with new users", () => {
    const onboardingState: OnboardingState = {
      status: "pending",
      completedAt: null,
      dismissedAt: null,
    };
    expect(
      shouldShowOnboarding({
        onboardingState,
        hasWorkspaces: false,
        hasThreads: false,
        hasConnectedProviders: false,
      }),
    ).toBe(true);
  });
});
