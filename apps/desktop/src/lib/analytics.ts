import type {
  ProductAnalyticsEventName,
  ProductAnalyticsEventProperties,
} from "../../../../src/telemetry/productAnalytics";
import { captureProductEvent as captureProductEventCommand } from "./desktopCommands";

function getDesktopProductAnalyticsConfig() {
  return typeof window === "undefined" ? undefined : window.cowork?.productAnalytics;
}

let rendererProductAnalyticsEnabled = getDesktopProductAnalyticsConfig()?.enabled === true;

export function initProductAnalytics(): void {
  rendererProductAnalyticsEnabled = getDesktopProductAnalyticsConfig()?.enabled === true;
}

export function identifyAnonymous(): string | null {
  return null;
}

export function captureProductEvent<Name extends ProductAnalyticsEventName>(
  name: Name,
  properties?: ProductAnalyticsEventProperties<Name>,
): void {
  if (!rendererProductAnalyticsEnabled) {
    return;
  }
  void captureProductEventCommand({ name, properties }).catch(() => {
    // Renderer analytics is best effort and must never affect UI flows.
  });
}

export function setProductAnalyticsEnabled(enabled: boolean): void {
  rendererProductAnalyticsEnabled =
    enabled && getDesktopProductAnalyticsConfig()?.keyConfigured === true;
}

export function shutdownProductAnalytics(): void {
  rendererProductAnalyticsEnabled = false;
}
