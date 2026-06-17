import { confirmAction } from "./desktopCommands";

/**
 * Confirm, then open an external source URL in the user's default browser.
 *
 * This is the call-site (implementation-point) behavior for presentational
 * components like `SourcesCarousel` that surface external links but must not
 * own desktop-command wiring themselves.
 */
export async function openExternalSource(url: string): Promise<void> {
  const confirmed = await confirmAction({
    title: "Open external link?",
    message: "This will open the link in your default browser.",
    detail: url,
    kind: "info",
    confirmLabel: "Open link",
    cancelLabel: "Cancel",
    defaultAction: "cancel",
  });
  if (confirmed) {
    window.open(url, "_blank", "noopener,noreferrer");
  }
}
