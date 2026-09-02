import { describe, expect, test } from "bun:test";

import {
  ANDROID_MINIMUM_TOUCH_TARGET,
  IOS_MINIMUM_TOUCH_TARGET,
  MAX_DYNAMIC_TYPE_MULTIPLIER,
  minimumTouchTarget,
  shouldAnimateLayout,
} from "../apps/mobile/src/features/accessibility/mobile-accessibility-policy";
import {
  describeComposerCapabilityAvailability,
  resolveComposerCapabilityAvailability,
} from "../apps/mobile/src/features/cowork/model-capability-availability";
import { pendingInputBadgeValue } from "../apps/mobile/src/features/navigation/mobile-navigation";

describe("mobile accessibility contract", () => {
  test("uses native minimum target sizes and supports 200% Dynamic Type", () => {
    expect(minimumTouchTarget("ios")).toBe(IOS_MINIMUM_TOUCH_TARGET);
    expect(minimumTouchTarget("android")).toBe(ANDROID_MINIMUM_TOUCH_TARGET);
    expect(IOS_MINIMUM_TOUCH_TARGET).toBe(44);
    expect(ANDROID_MINIMUM_TOUCH_TARGET).toBe(48);
    expect(MAX_DYNAMIC_TYPE_MULTIPLIER).toBe(2);
  });

  test("skips nonessential layout animation when reduced motion is enabled", () => {
    expect(shouldAnimateLayout(true)).toBe(false);
    expect(shouldAnimateLayout(false)).toBe(true);
  });

  test("bounds pending-input badges without exposing an empty badge", () => {
    expect(pendingInputBadgeValue({})).toBeUndefined();
    expect(pendingInputBadgeValue({ ask: {}, empty: null })).toBe("1");
    expect(
      pendingInputBadgeValue(
        Object.fromEntries(Array.from({ length: 105 }, (_, index) => [String(index), {}])),
      ),
    ).toBe("99+");
  });

  test("reports model and attachment availability without implying unsupported input", () => {
    const catalog = [
      {
        id: "openai",
        name: "OpenAI",
        defaultModel: "gpt-text",
        state: "ready" as const,
        models: [
          {
            id: "gpt-text",
            displayName: "GPT Text",
            knowledgeCutoff: "2025-01",
            supportsImageInput: false,
          },
          {
            id: "gpt-vision",
            displayName: "GPT Vision",
            knowledgeCutoff: "2025-01",
            supportsImageInput: true,
          },
        ],
      },
    ];

    const textOnly = resolveComposerCapabilityAvailability({
      connected: true,
      providerId: "openai",
      modelId: "gpt-text",
      catalog,
      attachmentPickerAvailable: true,
    });
    expect(textOnly.model.availability).toBe("available");
    expect(textOnly.attachments).toEqual({
      availability: "unavailable",
      label: "Selected model does not accept images",
    });
    expect(describeComposerCapabilityAvailability(textOnly)).toContain(
      "Selected model does not accept images",
    );

    const vision = resolveComposerCapabilityAvailability({
      connected: true,
      providerId: "openai",
      modelId: "gpt-vision",
      catalog,
      attachmentPickerAvailable: true,
    });
    expect(vision.attachments.availability).toBe("available");

    const disconnected = resolveComposerCapabilityAvailability({
      connected: false,
      providerId: "openai",
      modelId: "gpt-vision",
      catalog,
      attachmentPickerAvailable: true,
    });
    expect(disconnected.provider.availability).toBe("unavailable");
    expect(disconnected.model.availability).toBe("unavailable");
    expect(disconnected.attachments.availability).toBe("unavailable");
  });

  test("blocks explicitly unauthorized providers without letting stale discovery block valid credentials", () => {
    const catalog = [
      {
        id: "openai",
        name: "OpenAI",
        defaultModel: "gpt-5",
        state: "ready" as const,
        models: [
          {
            id: "gpt-5",
            displayName: "GPT 5",
            knowledgeCutoff: "2025-01",
            supportsImageInput: false,
          },
        ],
      },
    ];
    const unauthorized = resolveComposerCapabilityAvailability({
      connected: true,
      providerId: "openai",
      modelId: "gpt-5",
      catalog,
      providerStatus: {
        authorized: false,
        message: "Add an OpenAI API key in Settings > Providers.",
      },
      attachmentPickerAvailable: false,
    });

    expect(unauthorized.provider.availability).toBe("unavailable");
    expect(unauthorized.model.availability).toBe("unavailable");
    expect(describeComposerCapabilityAvailability(unauthorized)).toContain(
      "Add an OpenAI API key in Settings > Providers.",
    );

    const staleDiscovery = resolveComposerCapabilityAvailability({
      connected: true,
      providerId: "openai",
      modelId: "gpt-5",
      catalog: [{ ...catalog[0], state: "unreachable" }],
      providerStatus: { authorized: true, message: "Connected and ready." },
      attachmentPickerAvailable: false,
    });
    expect(staleDiscovery.provider.availability).toBe("available");
    expect(staleDiscovery.model.availability).toBe("available");

    const unknownStatus = resolveComposerCapabilityAvailability({
      connected: true,
      providerId: "openai",
      modelId: "gpt-5",
      catalog,
      attachmentPickerAvailable: false,
    });
    expect(unknownStatus.model.availability).toBe("available");
  });
});
