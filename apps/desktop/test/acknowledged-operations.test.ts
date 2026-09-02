import { describe, expect, mock, test } from "bun:test";

import { runAcknowledgedOperation } from "../src/app/store.helpers/operations";
import type { Notification, OperationState } from "../src/app/types";

type TestState = {
  notifications: Notification[];
  operationsByKey: Record<string, OperationState>;
  optimisticValue: string;
};

function createHarness() {
  const state: TestState = {
    notifications: [],
    operationsByKey: {},
    optimisticValue: "before",
  };
  const get = () => state;
  const set = (update: Partial<TestState> | ((current: TestState) => Partial<TestState>)) => {
    Object.assign(state, typeof update === "function" ? update(state) : update);
  };
  return { state, get, set };
}

describe("acknowledged foreground operations", () => {
  test("blocks a duplicate while the matching operation is pending", async () => {
    const { state, get, set } = createHarness();
    let finish: (() => void) | undefined;
    const execute = mock(
      async () =>
        await new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    const options = {
      key: "memory:save:workspace",
      label: "Save memory",
      errorTitle: "Memory not saved",
      errorMessage: "Unable to save memory.",
      execute,
    };

    const first = runAcknowledgedOperation(get as never, set as never, options);
    const duplicate = await runAcknowledgedOperation(get as never, set as never, options);

    expect(execute).toHaveBeenCalledTimes(1);
    expect(state.operationsByKey[options.key]?.status).toBe("pending");
    expect(duplicate).toMatchObject({
      ok: false,
      error: {
        code: "duplicate",
        retryable: false,
        repairAction: "Wait for the current operation to finish.",
      },
    });

    finish?.();
    await expect(first).resolves.toMatchObject({ ok: true });
    expect(state.operationsByKey[options.key]?.status).toBe("success");
  });

  test("rolls back optimistic state before publishing a foreground failure", async () => {
    const { state, get, set } = createHarness();

    const result = await runAcknowledgedOperation(get as never, set as never, {
      key: "mcp:enabled:workspace:server",
      label: "Update connector",
      errorTitle: "Connector not updated",
      errorMessage: "Unable to update connector.",
      repairAction: "Check the connector configuration and retry.",
      optimistic: () => {
        state.optimisticValue = "after";
        return () => {
          state.optimisticValue = "before";
        };
      },
      execute: async () => {
        expect(state.optimisticValue).toBe("after");
        throw new Error("Server rejected the update.");
      },
    });

    expect(result).toMatchObject({
      ok: false,
      error: {
        code: "request_failed",
        message: "Server rejected the update.",
        retryable: true,
      },
    });
    expect(state.optimisticValue).toBe("before");
    expect(state.operationsByKey["mcp:enabled:workspace:server"]).toMatchObject({
      status: "error",
      error: { message: "Server rejected the update." },
    });
    expect(state.notifications.at(-1)).toMatchObject({
      kind: "error",
      title: "Connector not updated",
      audience: "foreground",
    });
  });

  test("settles a failed operation and restores retry when optimistic rollback also fails", async () => {
    const { state, get, set } = createHarness();
    const key = "workspace:settings:save";

    const failed = await runAcknowledgedOperation(get as never, set as never, {
      key,
      label: "Save workspace settings",
      errorTitle: "Workspace settings not saved",
      errorMessage: "Unable to update workspace settings.",
      optimistic: () => {
        state.optimisticValue = "after";
        return () => {
          throw new Error("The previous workspace state is unavailable.");
        };
      },
      execute: async () => {
        throw new Error("The workspace server disconnected.");
      },
    });

    expect(failed.ok).toBe(false);
    if (!failed.ok) {
      expect(failed.error.retryable).toBe(true);
      expect(failed.error.message).toContain("The workspace server disconnected.");
    }
    expect(state.operationsByKey[key]?.status).toBe("error");
    expect(state.operationsByKey[key]?.error?.message).toContain(
      "The previous workspace state is unavailable.",
    );
    expect(state.notifications).toHaveLength(1);

    const retried = await runAcknowledgedOperation(get as never, set as never, {
      key,
      label: "Save workspace settings",
      errorTitle: "Workspace settings not saved",
      errorMessage: "Unable to update workspace settings.",
      execute: async () => "saved after reconnect",
    });

    expect(retried).toEqual({ ok: true, value: "saved after reconnect" });
    expect(state.operationsByKey[key]?.status).toBe("success");
  });
});
