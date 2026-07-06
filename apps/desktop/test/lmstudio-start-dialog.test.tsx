import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";

import type { LmStudioStartModalState } from "../src/app/types";
import { createDesktopCommandsMock } from "./helpers/mockDesktopCommands";
import { setupJsdom } from "./jsdomHarness";

// Mock desktopCommands before importing the store (which reads feature flags
// from it during initialization).
mock.module("../src/lib/desktopCommands", () =>
  createDesktopCommandsMock({
    loadState: async () => ({ version: 2, workspaces: [], threads: [] }),
    saveState: async () => {},
  }),
);

const { useAppStore } = await import("../src/app/store");
const { LmStudioStartDialog } = await import("../src/ui/chat/LmStudioStartDialog");

const defaultStoreState = useAppStore.getState();

function makeModal(overrides: Partial<LmStudioStartModalState> = {}): LmStudioStartModalState {
  return {
    threadId: "thread-1",
    workspaceId: "ws-1",
    baseUrl: "http://localhost:1234",
    installed: true,
    canAutoStart: true,
    phase: "prompt",
    retry: { text: "hello", clientMessageId: "client-1" },
    ...overrides,
  };
}

describe("LmStudioStartDialog", () => {
  let harness: ReturnType<typeof setupJsdom>;
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

  beforeEach(() => {
    harness = setupJsdom();
    container = harness.dom.window.document.getElementById("root") as HTMLDivElement;
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    useAppStore.setState(defaultStoreState);
    harness.restore();
  });

  async function renderDialog() {
    await act(async () => {
      root.render(createElement(LmStudioStartDialog));
    });
  }

  test("renders nothing without modal state", async () => {
    await renderDialog();
    expect(harness.dom.window.document.querySelector('[data-slot="dialog-content"]')).toBeNull();
  });

  test("offers to start a local server and invokes the action", async () => {
    const startLmStudioServerAndRetry = mock(async () => {});
    useAppStore.setState({ lmStudioStartModal: makeModal(), startLmStudioServerAndRetry });
    await renderDialog();

    const body = harness.dom.window.document.body;
    expect(body.querySelector('[data-slot="dialog-title"]')?.textContent).toContain(
      "LM Studio isn't running",
    );
    expect(body.textContent).toContain("http://localhost:1234");

    const startButton = Array.from(body.querySelectorAll("button")).find((button) =>
      button.textContent?.includes("Start LM Studio"),
    );
    expect(startButton).toBeDefined();
    await act(async () => {
      startButton?.click();
    });
    expect(startLmStudioServerAndRetry).toHaveBeenCalledTimes(1);
  });

  test("shows a spinner state while starting", async () => {
    useAppStore.setState({ lmStudioStartModal: makeModal({ phase: "starting" }) });
    await renderDialog();

    const body = harness.dom.window.document.body;
    const buttons = Array.from(body.querySelectorAll("button"));
    const startingButton = buttons.find((button) => button.textContent?.includes("Starting"));
    expect(startingButton).toBeDefined();
    expect(startingButton?.disabled).toBe(true);
  });

  test("shows the failure detail and a retry affordance after a failed start", async () => {
    useAppStore.setState({
      lmStudioStartModal: makeModal({ phase: "failed", errorDetail: "daemon crashed" }),
    });
    await renderDialog();

    const body = harness.dom.window.document.body;
    expect(body.textContent).toContain("daemon crashed");
    expect(
      Array.from(body.querySelectorAll("button")).some((button) =>
        button.textContent?.includes("Retry"),
      ),
    ).toBe(true);
  });

  test("offers the download link when LM Studio is not installed", async () => {
    useAppStore.setState({
      lmStudioStartModal: makeModal({ installed: false, canAutoStart: false }),
    });
    await renderDialog();

    const body = harness.dom.window.document.body;
    expect(body.textContent).toContain("doesn't appear to be installed");
    expect(
      Array.from(body.querySelectorAll("button")).some((button) =>
        button.textContent?.includes("Get LM Studio"),
      ),
    ).toBe(true);
  });

  test("is informational for a remote server", async () => {
    useAppStore.setState({
      lmStudioStartModal: makeModal({
        baseUrl: "http://192.168.1.50:1234",
        canAutoStart: false,
      }),
    });
    await renderDialog();

    const body = harness.dom.window.document.body;
    expect(body.textContent).toContain("isn't a local server");
    const buttons = Array.from(body.querySelectorAll("button"));
    expect(buttons.some((button) => button.textContent?.includes("Start LM Studio"))).toBe(false);
    expect(buttons.some((button) => button.textContent?.includes("Get LM Studio"))).toBe(false);
  });

  test("dismiss clears via the store action", async () => {
    const dismissLmStudioStartModal = mock(() => {});
    useAppStore.setState({ lmStudioStartModal: makeModal(), dismissLmStudioStartModal });
    await renderDialog();

    const cancelButton = Array.from(
      harness.dom.window.document.body.querySelectorAll("button"),
    ).find((button) => button.textContent === "Cancel");
    await act(async () => {
      cancelButton?.click();
    });
    expect(dismissLmStudioStartModal).toHaveBeenCalledTimes(1);
  });
});
