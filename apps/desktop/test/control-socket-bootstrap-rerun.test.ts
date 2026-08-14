import { describe, expect, test } from "bun:test";

import {
  createControlSocketHelpers,
  createState,
  deps,
  flushAsyncWork,
  jsonRpcHandlers,
  jsonRpcRequests,
  MockJsonRpcSocket,
  registerControlSocketLifecycleHooks,
} from "./control-socket.harness";

function catalogReadCount(): number {
  return jsonRpcRequests.filter((entry) => entry.method === "cowork/provider/catalog/read").length;
}

describe("control socket bootstrap rerun", () => {
  registerControlSocketLifecycleHooks();

  test("re-opens mid-bootstrap queue a second catalog refresh after the first pass", async () => {
    const workspaceId = "ws-bootstrap-rerun";
    const { get, set } = createState(workspaceId);
    const firstPass = Promise.withResolvers<void>();
    let catalogReadsStarted = 0;

    jsonRpcHandlers.set("cowork/provider/catalog/read", async () => {
      catalogReadsStarted += 1;
      if (catalogReadsStarted === 1) {
        await firstPass.promise;
      }
      return {};
    });

    const helpers = createControlSocketHelpers(deps);
    helpers.ensureControlSocket(get as any, set as any, workspaceId);
    await flushAsyncWork();

    expect(catalogReadsStarted).toBe(1);
    expect(helpers.__internal.getWorkspaceStateSnapshot(workspaceId).hasBootstrapPromise).toBe(
      true,
    );

    const socket = MockJsonRpcSocket.instances[0];
    if (!socket) throw new Error("expected control socket");
    socket.opts.onOpen?.();
    await flushAsyncWork();

    expect(catalogReadsStarted).toBe(1);

    firstPass.resolve();
    const deadline = Date.now() + 1_000;
    while (
      helpers.__internal.getWorkspaceStateSnapshot(workspaceId).hasBootstrapPromise &&
      Date.now() < deadline
    ) {
      await flushAsyncWork();
    }

    expect(catalogReadsStarted).toBe(2);
    expect(catalogReadCount()).toBe(2);
    expect(helpers.__internal.getWorkspaceStateSnapshot(workspaceId).hasBootstrapPromise).toBe(
      false,
    );

    helpers.__internal.reset(workspaceId);
  });

  test("a second mid-bootstrap reopen does not stack a third catalog refresh", async () => {
    const workspaceId = "ws-bootstrap-rerun-once";
    const { get, set } = createState(workspaceId);
    const firstPass = Promise.withResolvers<void>();
    let catalogReadsStarted = 0;

    jsonRpcHandlers.set("cowork/provider/catalog/read", async () => {
      catalogReadsStarted += 1;
      if (catalogReadsStarted === 1) {
        await firstPass.promise;
      }
      return {};
    });

    const helpers = createControlSocketHelpers(deps);
    helpers.ensureControlSocket(get as any, set as any, workspaceId);
    await flushAsyncWork();

    const socket = MockJsonRpcSocket.instances[0];
    if (!socket) throw new Error("expected control socket");
    socket.opts.onOpen?.();
    socket.opts.onOpen?.();
    await flushAsyncWork();

    firstPass.resolve();
    await flushAsyncWork();
    await flushAsyncWork();

    expect(catalogReadsStarted).toBe(2);
    expect(catalogReadCount()).toBe(2);

    helpers.__internal.reset(workspaceId);
  });
});
