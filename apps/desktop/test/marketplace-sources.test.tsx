import { describe, expect, mock, test } from "bun:test";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";

import type { MarketplacesListEntry } from "../src/app/types";
import { createDesktopCommandsMock } from "./helpers/mockDesktopCommands";
import { setupJsdom } from "./jsdomHarness";

const confirmActionMock = mock(async () => true);

mock.module("../src/lib/desktopCommands", () =>
  createDesktopCommandsMock({
    confirmAction: confirmActionMock,
  }),
);

const { useAppStore } = await import("../src/app/store");
const { defaultWorkspaceRuntime } = await import("../src/app/store.helpers/runtimeState");
const { MarketplaceSourcesList } = await import("../src/ui/settings/toolAccess/marketplaceCatalog");
const { AddMarketplaceDialog } = await import("../src/ui/settings/toolAccess/AddMarketplaceDialog");
mock.restore();

const workspaceId = "ws-marketplaces";

const builtInMarketplace: MarketplacesListEntry = {
  id: "mweinbach/agent-coworker",
  repo: "mweinbach/agent-coworker",
  ref: "main",
  url: "https://github.com/mweinbach/agent-coworker/tree/main",
  marketplacePath: ".agents/plugins/marketplace.json",
  builtIn: true,
  displayName: "Cowork Marketplace",
  pluginCount: 3,
  skillCount: 12,
};

const customMarketplace: MarketplacesListEntry = {
  id: "acme/cowork-extras",
  repo: "acme/cowork-extras",
  ref: "main",
  url: "https://github.com/acme/cowork-extras/tree/main",
  marketplacePath: ".agents/plugins/marketplace.json",
  builtIn: false,
  displayName: "Acme Extras",
  pluginCount: 1,
  skillCount: 0,
  addedAt: "2026-07-01T00:00:00.000Z",
};

const unreachableMarketplace: MarketplacesListEntry = {
  id: "acme/broken-marketplace",
  repo: "acme/broken-marketplace",
  ref: "main",
  url: "https://github.com/acme/broken-marketplace/tree/main",
  marketplacePath: ".agents/plugins/marketplace.json",
  builtIn: false,
  fetchError: "Failed to fetch marketplace manifest: 404 Not Found",
  addedAt: "2026-07-02T00:00:00.000Z",
};

function projectWorkspace(id: string) {
  return {
    id,
    name: "Workspace",
    path: `/tmp/${id}`,
    workspaceKind: "project" as const,
    createdAt: "2026-06-02T00:00:00.000Z",
    lastOpenedAt: "2026-06-02T00:00:00.000Z",
    defaultEnableMcp: true,
    defaultBackupsEnabled: false,
    yolo: false,
  };
}

function emptyCatalogs() {
  return {
    pluginsCatalog: { plugins: [], availablePlugins: [], warnings: [] },
    skillsCatalog: {
      scopes: [],
      effectiveSkills: [],
      installations: [],
      availableSkills: [],
    },
  };
}

async function flushUi() {
  await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
  await Promise.resolve();
}

function installDialogDomShims(harness: ReturnType<typeof setupJsdom>) {
  const prototype = harness.dom.window.HTMLElement.prototype as {
    attachEvent?: () => void;
    detachEvent?: () => void;
  };
  prototype.attachEvent = () => {};
  prototype.detachEvent = () => {};
}

type InputChangeProps = {
  onChange?: (event: { target: HTMLInputElement; currentTarget: HTMLInputElement }) => void;
};

function setInputValue(
  harness: ReturnType<typeof setupJsdom>,
  input: HTMLInputElement,
  value: string,
) {
  const setter = Object.getOwnPropertyDescriptor(
    harness.dom.window.HTMLInputElement.prototype,
    "value",
  )?.set;
  setter?.call(input, value);
  // The Bun preload imports React before jsdom exists, so direct DOM events
  // alone do not reliably drive controlled fields; call the React prop too.
  const propsKey = Object.keys(input).find((key) => key.startsWith("__reactProps$"));
  const props = propsKey
    ? ((input as unknown as Record<string, unknown>)[propsKey] as InputChangeProps)
    : {};
  props.onChange?.({ target: input, currentTarget: input });
  input.dispatchEvent(new harness.dom.window.Event("input", { bubbles: true }));
}

function clickButton(harness: ReturnType<typeof setupJsdom>, button: Element | undefined | null) {
  if (!(button instanceof harness.dom.window.HTMLButtonElement)) {
    throw new Error("missing button");
  }
  button.dispatchEvent(new harness.dom.window.MouseEvent("click", { bubbles: true }));
}

/** The trigger button shares the "Add marketplace" label, so scope to the open dialog. */
function findDialogSubmitButton(harness: ReturnType<typeof setupJsdom>) {
  const dialog = harness.dom.window.document.querySelector("[role='dialog']");
  if (!dialog) {
    throw new Error("missing open dialog");
  }
  return Array.from(dialog.querySelectorAll("button")).find(
    (button) => button.textContent?.trim() === "Add marketplace",
  );
}

describe("marketplace sources section", () => {
  test("renders sources with built-in badge, counts, unreachable state, and remove flow", async () => {
    const previousState = useAppStore.getState();
    const refreshMarketplacesMock = mock(async (_workspaceId?: string) => {});
    const removeMarketplaceMock = mock(async (_id: string) => {});
    confirmActionMock.mockClear();
    confirmActionMock.mockResolvedValue(true);

    useAppStore.setState({
      ...previousState,
      workspaces: [projectWorkspace(workspaceId)],
      selectedWorkspaceId: workspaceId,
      refreshMarketplaces: refreshMarketplacesMock as typeof previousState.refreshMarketplaces,
      removeMarketplace: removeMarketplaceMock as typeof previousState.removeMarketplace,
      workspaceRuntimeById: {
        ...previousState.workspaceRuntimeById,
        [workspaceId]: {
          ...defaultWorkspaceRuntime(),
          ...emptyCatalogs(),
          marketplaces: [builtInMarketplace, customMarketplace, unreachableMarketplace],
        },
      },
    });

    const harness = setupJsdom();
    let root: ReturnType<typeof createRoot> | null = null;

    try {
      const container = harness.dom.window.document.getElementById("root");
      if (!container) throw new Error("missing root");
      root = createRoot(container);

      await act(async () => {
        root.render(createElement(MarketplaceSourcesList, { workspaceId }));
        await flushUi();
      });

      expect(refreshMarketplacesMock).toHaveBeenCalledWith(workspaceId);

      const bodyText = harness.dom.window.document.body.textContent ?? "";
      expect(bodyText).toContain("Marketplace sources");
      expect(bodyText).toContain("Catalogs Cowork can install plugins and skills from.");
      expect(bodyText).toContain("Cowork Marketplace");
      expect(bodyText).toContain("Built-in");
      expect(bodyText).toContain("mweinbach/agent-coworker · 3 plugins · 12 skills");
      expect(bodyText).toContain("Acme Extras");
      expect(bodyText).toContain("acme/cowork-extras · 1 plugin · 0 skills");
      // The unreachable source shows its fetch error instead of counts.
      expect(bodyText).toContain(
        "Unreachable: Failed to fetch marketplace manifest: 404 Not Found",
      );

      const removeButtons = Array.from(
        harness.dom.window.document.querySelectorAll("button[aria-label^='Remove ']"),
      );
      expect(removeButtons.map((button) => button.getAttribute("aria-label")).sort()).toEqual([
        "Remove Acme Extras",
        "Remove acme/broken-marketplace",
      ]);
      expect(
        harness.dom.window.document.querySelector("button[aria-label='Remove Cowork Marketplace']"),
      ).toBeNull();

      await act(async () => {
        clickButton(
          harness,
          harness.dom.window.document.querySelector("button[aria-label='Remove Acme Extras']"),
        );
        await flushUi();
      });

      expect(confirmActionMock).toHaveBeenCalledTimes(1);
      expect(removeMarketplaceMock).toHaveBeenCalledWith("acme/cowork-extras");
    } finally {
      if (root) {
        await act(async () => {
          root.unmount();
        });
      }
      useAppStore.setState(previousState);
      harness.restore();
    }
  });

  test("clicking a source row selects the marketplace for the detail dialog", async () => {
    const previousState = useAppStore.getState();
    const selectMarketplaceMock = mock(async (_id: string | null) => {});
    const removeMarketplaceMock = mock(async (_id: string) => {});
    confirmActionMock.mockClear();
    confirmActionMock.mockResolvedValue(true);

    useAppStore.setState({
      ...previousState,
      workspaces: [projectWorkspace(workspaceId)],
      selectedWorkspaceId: workspaceId,
      refreshMarketplaces: mock(async () => {}) as typeof previousState.refreshMarketplaces,
      selectMarketplace: selectMarketplaceMock as typeof previousState.selectMarketplace,
      removeMarketplace: removeMarketplaceMock as typeof previousState.removeMarketplace,
      workspaceRuntimeById: {
        ...previousState.workspaceRuntimeById,
        [workspaceId]: {
          ...defaultWorkspaceRuntime(),
          ...emptyCatalogs(),
          marketplaces: [builtInMarketplace, customMarketplace],
        },
      },
    });

    const harness = setupJsdom();
    let root: ReturnType<typeof createRoot> | null = null;

    try {
      const container = harness.dom.window.document.getElementById("root");
      if (!container) throw new Error("missing root");
      root = createRoot(container);

      await act(async () => {
        root.render(createElement(MarketplaceSourcesList, { workspaceId }));
        await flushUi();
      });

      const rowButton = Array.from(harness.dom.window.document.querySelectorAll("button")).find(
        (button) => button.textContent?.includes("Acme Extras"),
      );
      await act(async () => {
        clickButton(harness, rowButton);
        await flushUi();
      });
      expect(selectMarketplaceMock).toHaveBeenCalledWith("acme/cowork-extras");

      // The trash button stays independent: removing does not open the detail dialog.
      selectMarketplaceMock.mockClear();
      await act(async () => {
        clickButton(
          harness,
          harness.dom.window.document.querySelector("button[aria-label='Remove Acme Extras']"),
        );
        await flushUi();
      });
      expect(removeMarketplaceMock).toHaveBeenCalledWith("acme/cowork-extras");
      expect(selectMarketplaceMock).not.toHaveBeenCalled();
    } finally {
      if (root) {
        await act(async () => {
          root.unmount();
        });
      }
      useAppStore.setState(previousState);
      harness.restore();
    }
  });

  test("remove is skipped when the confirmation dialog is cancelled", async () => {
    const previousState = useAppStore.getState();
    const removeMarketplaceMock = mock(async (_id: string) => {});
    confirmActionMock.mockClear();
    confirmActionMock.mockResolvedValue(false);

    useAppStore.setState({
      ...previousState,
      workspaces: [projectWorkspace(workspaceId)],
      selectedWorkspaceId: workspaceId,
      refreshMarketplaces: mock(async () => {}) as typeof previousState.refreshMarketplaces,
      removeMarketplace: removeMarketplaceMock as typeof previousState.removeMarketplace,
      workspaceRuntimeById: {
        ...previousState.workspaceRuntimeById,
        [workspaceId]: {
          ...defaultWorkspaceRuntime(),
          ...emptyCatalogs(),
          marketplaces: [builtInMarketplace, customMarketplace],
        },
      },
    });

    const harness = setupJsdom();
    let root: ReturnType<typeof createRoot> | null = null;

    try {
      const container = harness.dom.window.document.getElementById("root");
      if (!container) throw new Error("missing root");
      root = createRoot(container);

      await act(async () => {
        root.render(createElement(MarketplaceSourcesList, { workspaceId }));
        await flushUi();
      });

      await act(async () => {
        clickButton(
          harness,
          harness.dom.window.document.querySelector("button[aria-label='Remove Acme Extras']"),
        );
        await flushUi();
      });

      expect(confirmActionMock).toHaveBeenCalledTimes(1);
      expect(removeMarketplaceMock).not.toHaveBeenCalled();
    } finally {
      if (root) {
        await act(async () => {
          root.unmount();
        });
      }
      useAppStore.setState(previousState);
      harness.restore();
    }
  });

  test("renders the loading skeleton and remove-error line", async () => {
    const previousState = useAppStore.getState();
    const dismissMock = mock((_workspaceId?: string) => {});

    useAppStore.setState({
      ...previousState,
      workspaces: [projectWorkspace(workspaceId)],
      selectedWorkspaceId: workspaceId,
      refreshMarketplaces: mock(async () => {}) as typeof previousState.refreshMarketplaces,
      dismissMarketplaceMutationError:
        dismissMock as typeof previousState.dismissMarketplaceMutationError,
      workspaceRuntimeById: {
        ...previousState.workspaceRuntimeById,
        [workspaceId]: {
          ...defaultWorkspaceRuntime(),
          ...emptyCatalogs(),
          marketplaces: null,
          marketplacesLoading: true,
          marketplaceMutationError:
            "Failed to remove marketplace: The built-in marketplace cannot be removed.",
        },
      },
    });

    const harness = setupJsdom();
    let root: ReturnType<typeof createRoot> | null = null;

    try {
      const container = harness.dom.window.document.getElementById("root");
      if (!container) throw new Error("missing root");
      root = createRoot(container);

      await act(async () => {
        root.render(createElement(MarketplaceSourcesList, { workspaceId }));
        await flushUi();
      });

      const bodyText = harness.dom.window.document.body.textContent ?? "";
      expect(bodyText).toContain(
        "Failed to remove marketplace: The built-in marketplace cannot be removed.",
      );

      const dismissButton = Array.from(harness.dom.window.document.querySelectorAll("button")).find(
        (button) => button.textContent?.trim() === "Dismiss",
      );
      await act(async () => {
        clickButton(harness, dismissButton);
      });
      expect(dismissMock).toHaveBeenCalledWith(workspaceId);
    } finally {
      if (root) {
        await act(async () => {
          root.unmount();
        });
      }
      useAppStore.setState(previousState);
      harness.restore();
    }
  });
});

describe("add marketplace dialog", () => {
  test("submits the source input and closes on success", async () => {
    const previousState = useAppStore.getState();
    const addMarketplaceMock = mock(async (_sourceInput: string) => ({
      ok: true as const,
      value: undefined,
    }));

    useAppStore.setState({
      ...previousState,
      workspaces: [projectWorkspace(workspaceId)],
      selectedWorkspaceId: workspaceId,
      addMarketplace: addMarketplaceMock as typeof previousState.addMarketplace,
      workspaceRuntimeById: {
        ...previousState.workspaceRuntimeById,
        [workspaceId]: defaultWorkspaceRuntime(),
      },
    });

    const harness = setupJsdom();
    let root: ReturnType<typeof createRoot> | null = null;

    try {
      installDialogDomShims(harness);
      const container = harness.dom.window.document.getElementById("root");
      if (!container) throw new Error("missing root");
      root = createRoot(container);

      await act(async () => {
        root.render(createElement(AddMarketplaceDialog, { workspaceId, initialOpen: true }));
        await flushUi();
      });

      const dialogText = () => harness.dom.window.document.body.textContent ?? "";
      expect(dialogText()).toContain("Add marketplace");
      expect(dialogText()).toContain("GitHub repository");
      expect(dialogText()).toContain(
        "The repository must contain a marketplace manifest. Use the create-marketplace skill to make one.",
      );

      const input = harness.dom.window.document.querySelector(
        'input[aria-label="GitHub repository"]',
      );
      if (!(input instanceof harness.dom.window.HTMLInputElement)) {
        throw new Error("missing marketplace source input");
      }
      expect(input.getAttribute("placeholder")).toBe("owner/repo or https://github.com/owner/repo");

      await act(async () => {
        setInputValue(harness, input, "acme/cowork-extras");
      });

      const submitButton = findDialogSubmitButton(harness);
      await act(async () => {
        clickButton(harness, submitButton);
        await flushUi();
      });

      expect(addMarketplaceMock).toHaveBeenCalledWith("acme/cowork-extras");
      // Successful adds close the dialog. jsdom never fires the Radix exit
      // animation, so the node may linger with data-state="closed" instead of
      // unmounting outright.
      await act(async () => {
        await flushUi();
      });
      const dialogAfterSubmit = harness.dom.window.document.querySelector("[role='dialog']");
      expect(dialogAfterSubmit?.getAttribute("data-state") ?? "closed").toBe("closed");
    } finally {
      if (root) {
        await act(async () => {
          root.unmount();
        });
      }
      useAppStore.setState(previousState);
      harness.restore();
    }
  });

  test("shows the RPC error inline and stays open when adding fails", async () => {
    const previousState = useAppStore.getState();
    const errorMessage =
      'Failed to add marketplace: Marketplace "acme/cowork-extras" is already configured.';
    const addMarketplaceMock = mock(async (_sourceInput: string) => {
      useAppStore.setState((state) => ({
        workspaceRuntimeById: {
          ...state.workspaceRuntimeById,
          [workspaceId]: {
            ...state.workspaceRuntimeById[workspaceId],
            marketplaceMutationError: errorMessage,
          },
        },
      }));
      return {
        ok: false as const,
        error: {
          code: "request_failed" as const,
          message: errorMessage,
          retryable: true,
          repairAction: "Check the marketplace source and retry.",
        },
      };
    });

    useAppStore.setState({
      ...previousState,
      workspaces: [projectWorkspace(workspaceId)],
      selectedWorkspaceId: workspaceId,
      addMarketplace: addMarketplaceMock as typeof previousState.addMarketplace,
      workspaceRuntimeById: {
        ...previousState.workspaceRuntimeById,
        [workspaceId]: defaultWorkspaceRuntime(),
      },
    });

    const harness = setupJsdom();
    let root: ReturnType<typeof createRoot> | null = null;

    try {
      installDialogDomShims(harness);
      const container = harness.dom.window.document.getElementById("root");
      if (!container) throw new Error("missing root");
      root = createRoot(container);

      await act(async () => {
        root.render(createElement(AddMarketplaceDialog, { workspaceId, initialOpen: true }));
        await flushUi();
      });

      const input = harness.dom.window.document.querySelector(
        'input[aria-label="GitHub repository"]',
      );
      if (!(input instanceof harness.dom.window.HTMLInputElement)) {
        throw new Error("missing marketplace source input");
      }

      await act(async () => {
        setInputValue(harness, input, "acme/cowork-extras");
      });

      const submitButton = findDialogSubmitButton(harness);
      await act(async () => {
        clickButton(harness, submitButton);
        await flushUi();
      });

      expect(addMarketplaceMock).toHaveBeenCalledWith("acme/cowork-extras");
      const dialogText = harness.dom.window.document.body.textContent ?? "";
      expect(dialogText).toContain(errorMessage);
      const dialogAfterFailure = harness.dom.window.document.querySelector("[role='dialog']");
      expect(dialogAfterFailure?.getAttribute("data-state")).toBe("open");
    } finally {
      if (root) {
        await act(async () => {
          root.unmount();
        });
      }
      useAppStore.setState(previousState);
      harness.restore();
    }
  });
});
