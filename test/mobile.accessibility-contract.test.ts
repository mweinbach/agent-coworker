import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

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

function mobileSource(relativePath: string): string {
  return readFileSync(new URL(`../apps/mobile/src/${relativePath}`, import.meta.url), "utf8");
}

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
    expect(mobileSource("features/accessibility/mobile-accessibility.ts")).toContain(
      "if (!shouldAnimateLayout(reducedMotionEnabled))",
    );
  });

  test("labels core chat controls and exposes busy, disabled, expanded, and live states", () => {
    const appButton = mobileSource("components/ui/app-button.tsx");
    const composer = mobileSource("components/ComposerBar.tsx");
    const pendingRequest = mobileSource("components/thread/pending-request-card.tsx");
    const activity = mobileSource("components/thread/activity-group-card.tsx");
    const sources = mobileSource("components/thread/sources-carousel.tsx");

    expect(appButton).toContain('accessibilityRole="button"');
    expect(appButton).toContain("accessibilityState={{ busy, disabled, expanded }}");
    expect(composer).toContain(
      'const actionLabel = isBusy ? (isStopping ? "Stopping turn" : "Stop turn")',
    );
    expect(composer).toContain("accessibilityLabel={actionLabel}");
    expect(composer).toContain("accessibilityState={{");
    expect(pendingRequest).toContain('accessibilityLiveRegion="assertive"');
    expect(pendingRequest).toContain('accessibilityLabel="Approve command"');
    expect(pendingRequest).toContain('accessibilityLabel="Decline command"');
    expect(activity).toContain("accessibilityState={{ expanded");
    expect(sources).toContain('accessibilityRole="link"');
    expect(sources).not.toContain("numberOfLines=");
  });

  test("announces pairing progress and errors on both platform implementations", () => {
    for (const platformFile of [
      "components/pairing/pairing-scan.ios.tsx",
      "components/pairing/pairing-scan.fallback.tsx",
    ]) {
      const source = mobileSource(platformFile);
      expect(source).toContain("useAccessibilityAnnouncement(");
      expect(source).toContain('accessibilityLabel="QR code scanner camera"');
      expect(source).toContain('accessibilityLabel="Pairing key"');
    }
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
});
