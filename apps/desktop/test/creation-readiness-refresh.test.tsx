import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";

import { useAppStore } from "../src/app/store";
import { useCreationReadiness } from "../src/ui/creation/useCreationReadiness";
import { setupJsdom } from "./jsdomHarness";

describe("useCreationReadiness", () => {
  let harness: ReturnType<typeof setupJsdom>;
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;
  const originalPreflightCreation = useAppStore.getState().preflightCreation;
  const originalProviderStatusLastUpdatedAt = useAppStore.getState().providerStatusLastUpdatedAt;

  beforeEach(() => {
    harness = setupJsdom();
    container = harness.dom.window.document.getElementById("root") as HTMLDivElement;
    root = createRoot(container);
    useAppStore.setState({ providerStatusLastUpdatedAt: null });
  });

  afterEach(() => {
    act(() => root.unmount());
    useAppStore.setState({
      preflightCreation: originalPreflightCreation,
      providerStatusLastUpdatedAt: originalProviderStatusLastUpdatedAt,
    });
    harness.restore();
  });

  test("rechecks a blocked provider after authentication refreshes provider status", async () => {
    const preflightCreation = mock()
      .mockResolvedValueOnce({
        ready: false,
        checks: [
          {
            id: "provider_credentials",
            status: "blocked",
            message: "Connect ChatGPT to continue.",
          },
        ],
      })
      .mockResolvedValueOnce({ ready: true, checks: [] });
    useAppStore.setState({ preflightCreation });

    function ReadinessProbe() {
      const readiness = useCreationReadiness({
        kind: "chat",
        provider: "codex-cli",
        model: "gpt-5.4",
      });
      return createElement(
        "div",
        null,
        readiness.checking ? "checking" : readiness.result?.ready ? "ready" : "blocked",
      );
    }

    await act(async () => {
      root.render(createElement(ReadinessProbe));
      await Bun.sleep(0);
    });
    expect(container.textContent).toBe("blocked");
    expect(preflightCreation).toHaveBeenCalledTimes(1);

    await act(async () => {
      useAppStore.setState({ providerStatusLastUpdatedAt: "2026-07-12T12:00:00.000Z" });
      await Bun.sleep(0);
    });

    expect(container.textContent).toBe("ready");
    expect(preflightCreation).toHaveBeenCalledTimes(2);
  });

  test("keeps rechecking until the Cowork runtime has finished starting", async () => {
    const pendingResult = {
      ready: true,
      checks: [
        {
          id: "runtime_ready",
          status: "pending",
          message: "Downloading the Cowork runtime — 62%.",
        },
      ],
    };
    const preflightCreation = mock()
      .mockResolvedValueOnce(pendingResult)
      .mockResolvedValueOnce(pendingResult)
      .mockResolvedValueOnce({ ready: true, checks: [] });
    useAppStore.setState({ preflightCreation });

    function ReadinessProbe() {
      const readiness = useCreationReadiness(
        {
          kind: "chat",
          provider: "codex-cli",
          model: "gpt-5.5",
        },
        { runtimeRecheckDelayMs: 10 },
      );
      const pending = readiness.result?.checks.some((entry) => entry.status === "pending");
      return createElement(
        "div",
        null,
        readiness.result ? (pending ? "pending" : "ready") : "checking",
      );
    }

    await act(async () => {
      root.render(createElement(ReadinessProbe));
      await Bun.sleep(0);
    });
    expect(container.textContent).toBe("pending");
    expect(preflightCreation).toHaveBeenCalledTimes(1);

    // Poll the DOM until the injected recheck delay fires and re-renders.
    const deadline = Date.now() + 1_000;
    while (container.textContent !== "ready" && Date.now() < deadline) {
      await act(async () => {
        await Bun.sleep(10);
      });
    }

    expect(container.textContent).toBe("ready");
    expect(preflightCreation).toHaveBeenCalledTimes(3);
  });

  test("keeps the previous result visible while a recheck is in flight", async () => {
    const pendingResult = {
      ready: true,
      checks: [
        { id: "runtime_ready", status: "pending", message: "Downloading the Cowork runtime." },
      ],
    };
    let releaseSecondCheck: (() => void) | null = null;
    const preflightCreation = mock()
      .mockResolvedValueOnce(pendingResult)
      .mockImplementationOnce(
        async () =>
          await new Promise((resolve) => {
            releaseSecondCheck = () => resolve(pendingResult);
          }),
      );
    useAppStore.setState({ preflightCreation });

    const observed: string[] = [];
    function ReadinessProbe() {
      const readiness = useCreationReadiness(
        { kind: "chat", provider: "codex-cli", model: "gpt-5.5" },
        { runtimeRecheckDelayMs: 10 },
      );
      observed.push(readiness.result ? "result" : "empty");
      return createElement("div", null, readiness.result ? "result" : "empty");
    }

    await act(async () => {
      root.render(createElement(ReadinessProbe));
      await Bun.sleep(0);
    });
    expect(container.textContent).toBe("result");

    const deadline = Date.now() + 5_000;
    while (preflightCreation.mock.calls.length < 2 && Date.now() < deadline) {
      await act(async () => {
        await Bun.sleep(10);
      });
    }
    expect(preflightCreation).toHaveBeenCalledTimes(2);

    // The second check has not resolved yet; the notice must not blank out.
    expect(container.textContent).toBe("result");
    expect(observed.slice(1)).not.toContain("empty");
    await act(async () => {
      await Bun.sleep(30);
    });
    expect(preflightCreation).toHaveBeenCalledTimes(2);

    await act(async () => {
      releaseSecondCheck?.();
      await Bun.sleep(0);
    });
  });

  test("invalidates readiness when the selected model or workspace changes", async () => {
    const preflightCreation = mock()
      .mockResolvedValueOnce({ ready: true, checks: [] })
      .mockImplementation(() => new Promise(() => {}));
    useAppStore.setState({ preflightCreation });

    function ReadinessProbe({ model, workspaceId }: { model: string; workspaceId: string }) {
      const readiness = useCreationReadiness({
        kind: "chat",
        provider: "codex-cli",
        model,
        workspaceId,
      });
      return createElement("div", null, readiness.result?.ready ? "ready" : "unchecked");
    }

    await act(async () => {
      root.render(createElement(ReadinessProbe, { model: "model-a", workspaceId: "workspace-a" }));
      await Bun.sleep(0);
    });
    expect(container.textContent).toBe("ready");

    await act(async () => {
      root.render(createElement(ReadinessProbe, { model: "model-b", workspaceId: "workspace-b" }));
      await Bun.sleep(0);
    });
    expect(container.textContent).toBe("unchecked");
    expect(preflightCreation.mock.calls[0]?.[1]?.signal.aborted).toBe(true);
  });

  test("ignores a late result from a previous target", async () => {
    let releaseFirstCheck: (() => void) | undefined;
    const preflightCreation = mock()
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            releaseFirstCheck = () => resolve({ ready: true, checks: [] });
          }),
      )
      .mockResolvedValueOnce({
        ready: false,
        checks: [{ id: "provider_credentials", status: "blocked", message: "Connect provider." }],
      });
    useAppStore.setState({ preflightCreation });

    function ReadinessProbe({ model }: { model: string }) {
      const readiness = useCreationReadiness({ kind: "chat", provider: "codex-cli", model });
      return createElement("div", null, readiness.result?.ready ? "ready" : "blocked");
    }

    await act(async () => {
      root.render(createElement(ReadinessProbe, { model: "model-a" }));
    });
    await act(async () => {
      root.render(createElement(ReadinessProbe, { model: "model-b" }));
      await Bun.sleep(0);
    });
    await act(async () => {
      releaseFirstCheck?.();
      await Bun.sleep(0);
    });
    expect(container.textContent).toBe("blocked");
  });

  test("cancels pending runtime rechecks when the consumer unmounts", async () => {
    const preflightCreation = mock(async () => ({
      ready: true,
      checks: [{ id: "runtime_ready", status: "pending", message: "Starting runtime." }],
    }));
    useAppStore.setState({ preflightCreation });

    function ReadinessProbe() {
      useCreationReadiness({ kind: "chat" }, { runtimeRecheckDelayMs: 20 });
      return null;
    }

    await act(async () => {
      root.render(createElement(ReadinessProbe));
      await Bun.sleep(0);
    });
    await act(async () => {
      root.render(null);
      await Bun.sleep(40);
    });
    expect(preflightCreation).toHaveBeenCalledTimes(1);
  });
});
