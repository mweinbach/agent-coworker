import { afterAll, describe, expect, mock, test } from "bun:test";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { DESKTOP_API_OVERRIDE_KEY } from "../src/lib/desktopApiOverride";
import type { ChatRenderItem } from "../src/ui/chat/activityGroups";
import { createDesktopApiMock } from "./helpers/mockDesktopCommands";
import { setupJsdom } from "./jsdomHarness";

// Streamdown (imported via DesktopMarkdown) expects DOM globals at module
// evaluation time, so imports run under a temporary jsdom scope.
const moduleImportHarness = setupJsdom();
const { DesktopMarkdown } = await import("../src/ui/markdown");
const { OverlayStackProvider } = await import("../src/ui/OverlayStack");
const { useAppStore } = await import("../src/app/store");
const { DesktopOnboarding } = await import("../src/ui/onboarding/DesktopOnboarding");
const { ChatFeed } = await import("../src/ui/chat/ChatFeed");
const { ChatViewContext } = await import("../src/ui/chat/ChatViewContext");
moduleImportHarness.restore();

const defaultStoreState = useAppStore.getState();

afterAll(() => {
  useAppStore.setState(defaultStoreState);
});

async function nextFrame(harness: ReturnType<typeof setupJsdom>) {
  await act(async () => {
    await new Promise<void>((resolve) => harness.dom.window.requestAnimationFrame(() => resolve()));
    await new Promise<void>((resolve) => harness.dom.window.requestAnimationFrame(() => resolve()));
  });
}

describe("accessibility review fixes", () => {
  test.serial(
    "citation popovers allow focus entry and handle source navigation inside the content",
    async () => {
      const harness = setupJsdom({ includeAnimationFrame: true });
      let root: ReturnType<typeof createRoot> | null = null;

      try {
        const container = harness.dom.window.document.getElementById("root");
        if (!container) throw new Error("missing root");
        root = createRoot(container);

        const text = "* **Casualties:** The pilot was killed. Most have been released.";
        await act(async () => {
          root?.render(
            createElement(
              OverlayStackProvider,
              null,
              createElement(
                DesktopMarkdown,
                {
                  normalizeDisplayCitations: true,
                  citationSources: [
                    { title: "Safety Memo", url: "https://example.com/killed" },
                    { title: "Hospital Update", url: "https://example.com/injuries" },
                  ],
                  citationAnnotations: [
                    {
                      type: "url_citation",
                      start_index: 0,
                      end_index: text.indexOf("killed.") + "killed.".length - 1,
                      url: "https://example.com/killed",
                    },
                    {
                      type: "url_citation",
                      start_index: 0,
                      end_index: text.indexOf("Most") + 2,
                      url: "https://example.com/injuries",
                    },
                  ],
                  citationUrlsByIndex: new Map([
                    [1, "https://example.com/killed"],
                    [2, "https://example.com/injuries"],
                  ]),
                },
                text,
              ),
            ),
          );
        });

        const chipButton = Array.from(container.querySelectorAll("button")).find((button) =>
          button.textContent?.includes("Safety Memo +1"),
        );
        if (!chipButton) throw new Error("missing grouped citation chip button");

        await act(async () => {
          chipButton.dispatchEvent(
            new harness.dom.window.MouseEvent("click", { bubbles: true, cancelable: true }),
          );
        });
        await nextFrame(harness);

        const popup = harness.dom.window.document.querySelector<HTMLElement>(
          '[data-slot="popover-content"][aria-label="Citation sources"]',
        );
        expect(popup).not.toBeNull();
        expect(popup?.textContent).toContain("1/2");

        // Keyboard users must be able to move focus INTO the popover content;
        // the regression suppressed auto focus so focus stayed on the trigger.
        const activeElement = harness.dom.window.document.activeElement;
        expect(activeElement).not.toBeNull();
        expect(popup?.contains(activeElement)).toBe(true);

        // Source navigation works from controls inside the content.
        const nextButton = popup?.querySelector<HTMLButtonElement>(
          'button[aria-label="Next source"]',
        );
        expect(nextButton?.disabled).toBe(false);
        await act(async () => {
          nextButton?.dispatchEvent(
            new harness.dom.window.MouseEvent("click", { bubbles: true, cancelable: true }),
          );
        });
        expect(popup?.textContent).toContain("2/2");
        expect(popup?.textContent).toContain("Hospital Update");

        // Arrow keys navigate the grouped sources while the popover is open.
        await act(async () => {
          chipButton.dispatchEvent(
            new harness.dom.window.KeyboardEvent("keydown", {
              bubbles: true,
              cancelable: true,
              key: "ArrowLeft",
            }),
          );
        });
        expect(popup?.textContent).toContain("1/2");
        expect(popup?.textContent).toContain("Safety Memo");
      } finally {
        if (root) {
          await act(async () => {
            root?.unmount();
          });
        }
        harness.restore();
      }
    },
  );

  test.serial("onboarding stays mounted while dismissal confirmation runs or fails", async () => {
    let confirmResult = Promise.withResolvers<boolean>();
    const confirmAction = mock(async () => await confirmResult.promise);
    const dismissOnboarding = mock(() => {
      useAppStore.setState({ onboardingVisible: false } as Partial<
        ReturnType<typeof useAppStore.getState>
      > as ReturnType<typeof useAppStore.getState>);
    });
    const harness = setupJsdom({
      includeAnimationFrame: true,
      extraGlobals: {
        [DESKTOP_API_OVERRIDE_KEY]: createDesktopApiMock({ confirmAction }),
      },
    });
    let root: ReturnType<typeof createRoot> | null = null;

    try {
      useAppStore.setState({
        ...defaultStoreState,
        ready: true,
        bootstrapPhase: "ready",
        onboardingVisible: true,
        onboardingStep: "welcome",
        workspaces: [],
        providerConnected: [],
        providerStatusByName: {},
        dismissOnboarding,
      } as Partial<ReturnType<typeof useAppStore.getState>> as ReturnType<
        typeof useAppStore.getState
      >);
      const container = harness.dom.window.document.getElementById("root");
      if (!container) throw new Error("missing root");
      root = createRoot(container);

      await act(async () => {
        root?.render(createElement(DesktopOnboarding));
      });

      const onboardingDialog = () =>
        harness.dom.window.document.body.querySelector('[aria-label="Onboarding"]');
      expect(onboardingDialog()).not.toBeNull();

      const closeButton = harness.dom.window.document.body.querySelector<HTMLButtonElement>(
        '[aria-label="Close onboarding"]',
      );
      if (!closeButton) throw new Error("missing close onboarding button");

      // While the native confirmation is still pending the dialog must stay
      // mounted, and repeated close clicks must not stack extra confirmations.
      await act(async () => closeButton.click());
      await act(async () => closeButton.click());
      expect(confirmAction).toHaveBeenCalledTimes(1);
      expect(onboardingDialog()).not.toBeNull();

      // The user chooses "Continue setup": dismissal is refused, dialog stays.
      confirmResult.resolve(false);
      await act(async () => {
        await Promise.resolve();
      });
      expect(dismissOnboarding).not.toHaveBeenCalled();
      expect(onboardingDialog()).not.toBeNull();

      // The confirmation dialog itself fails: onboarding must survive that too.
      confirmResult = Promise.withResolvers<boolean>();
      await act(async () => closeButton.click());
      confirmResult.reject(new Error("native dialog unavailable"));
      await act(async () => {
        await Promise.resolve();
      });
      expect(dismissOnboarding).not.toHaveBeenCalled();
      expect(onboardingDialog()).not.toBeNull();

      // Confirming actually dismisses — proving the earlier assertions did not
      // pass because dismissal was wired to nothing.
      confirmResult = Promise.withResolvers<boolean>();
      await act(async () => closeButton.click());
      confirmResult.resolve(true);
      await act(async () => {
        await Promise.resolve();
      });
      expect(dismissOnboarding).toHaveBeenCalledTimes(1);
      expect(onboardingDialog()).toBeNull();
    } finally {
      if (root) {
        await act(async () => {
          root?.unmount();
        });
      }
      useAppStore.setState(defaultStoreState);
      harness.restore();
    }
  });

  test.serial(
    "response completion announcement waits for the thread to stop being busy",
    async () => {
      const harness = setupJsdom({ includeAnimationFrame: true });
      let root: ReturnType<typeof createRoot> | null = null;

      const renderFeed = (busy: boolean, streamingAssistantMessageId: string | null) => {
        const items: ChatRenderItem[] = [
          {
            kind: "feed-item",
            item: {
              id: "user-1",
              kind: "message",
              role: "user",
              text: "Question",
              ts: "2026-06-26T12:00:00.000Z",
            },
          },
          {
            kind: "feed-item",
            item: {
              id: "assistant-1",
              kind: "message",
              role: "assistant",
              text: "Answer",
              ts: "2026-06-26T12:00:01.000Z",
            },
          },
        ];
        return createElement(
          ChatViewContext.Provider,
          {
            value: {
              developerMode: false,
              mentionCatalog: { items: [], names: [], kindByName: new Map() },
            },
          },
          createElement(ChatFeed, {
            busy,
            transcriptOnly: false,
            disconnected: false,
            visibleFeedLength: items.length,
            hydrating: false,
            renderItems: items,
            liveActivityGroupId: null,
            liveStartedAt: null,
            showWorkingPlaceholder: false,
            streamingAssistantMessageId,
            citationUrlsByMessageId: new Map(),
            citationSourcesByMessageId: new Map(),
            desktopBasePath: null,
            bottomOffset: 200,
            interactions: [],
            onAnswerAsk: () => true,
            onAnswerApproval: () => true,
            onRetryInteraction: () => true,
            selectedThreadId: "thread-a",
          }),
        );
      };

      try {
        const container = harness.dom.window.document.getElementById("root");
        if (!container) throw new Error("missing root");
        root = createRoot(container);

        const announcementText = () =>
          harness.dom.window.document
            .querySelector('[data-slot="response-completion-announcement"]')
            ?.textContent?.trim() ?? "";

        // Streaming: no completion announcement yet.
        await act(async () => {
          root?.render(renderFeed(true, "assistant-1"));
        });
        expect(announcementText()).toBe("");

        // Streaming ended but the thread is still busy (e.g. tool phase): the
        // completion announcement must keep waiting.
        await act(async () => {
          root?.render(renderFeed(true, null));
        });
        await act(async () => {
          await new Promise((resolve) => setTimeout(resolve, 550));
        });
        expect(announcementText()).toBe("");

        // Once the thread goes idle the polite announcement fires.
        await act(async () => {
          root?.render(renderFeed(false, null));
        });
        await act(async () => {
          await new Promise((resolve) => setTimeout(resolve, 550));
        });
        expect(announcementText()).toBe("Cowork response complete.");
      } finally {
        if (root) {
          await act(async () => {
            root?.unmount();
          });
        }
        harness.restore();
      }
    },
    15_000,
  );
});
