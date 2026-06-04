import { describe, expect, mock, test } from "bun:test";

import type { SessionEvent } from "../../../src/server/protocol";
import type { SessionRegistry } from "../../../src/server/runtime/SessionRegistry";
import { SocketSendQueue } from "../../../src/server/runtime/SocketSendQueue";
import { WorkspaceControl } from "../../../src/server/runtime/WorkspaceControl";
import type { SessionBinding, StartServerSocket } from "../../../src/server/startServer/types";

class TestWorkspaceControl extends WorkspaceControl {
  constructor(
    private readonly binding: SessionBinding,
    registry: SessionRegistry,
  ) {
    super({
      env: {},
      fallbackWorkingDirectory: "/workspace",
      registry,
      socketSendQueue: new SocketSendQueue(),
    });
  }

  override async getOrCreateBinding(_cwd: string): Promise<SessionBinding> {
    return this.binding;
  }
}

function makeWorkspaceControlHarness() {
  const refreshEvents: SessionEvent[] = [
    { type: "skills_list", sessionId: "control", skills: [] },
    {
      type: "skills_catalog",
      sessionId: "control",
      catalog: {},
      mutationBlocked: false,
    } as SessionEvent,
    { type: "plugins_catalog", sessionId: "control", catalog: {} } as SessionEvent,
    { type: "mcp_servers", sessionId: "control", servers: [], files: [] },
    { type: "agent_profiles_catalog", sessionId: "control", catalog: {} } as SessionEvent,
  ];
  let refreshEventIndex = 0;
  const capture = mock(
    async <T extends SessionEvent>(
      _binding: SessionBinding,
      action: () => Promise<void> | void,
      predicate: (event: SessionEvent) => event is T,
    ): Promise<T> => {
      await action();
      const event = refreshEvents[refreshEventIndex++];
      if (event && predicate(event)) {
        return event;
      }
      throw new Error(`Missing refresh event ${refreshEventIndex}`);
    },
  );
  const disposeBinding = mock(
    (_binding: SessionBinding, _reason: string, _opts?: { closeSharedCodexClient?: boolean }) => {},
  );
  const binding = {
    session: null,
    runtime: {
      skills: {
        list: mock(async () => {}),
        getCatalog: mock(async () => {}),
      },
      plugins: {
        getCatalog: mock(async () => {}),
      },
      mcp: {
        emitServers: mock(async () => {}),
      },
      agentProfiles: {
        getCatalog: mock(async () => {}),
      },
    } as SessionBinding["runtime"],
    socket: null,
    sinks: new Map(),
  } satisfies SessionBinding;
  const registry = {
    disposeBinding,
    sessionEventCapture: {
      capture,
    },
  } as unknown as SessionRegistry;

  return {
    binding,
    control: new TestWorkspaceControl(binding, registry),
    disposeBinding,
  };
}

describe("WorkspaceControl", () => {
  test("disposes request sessions without closing the shared Codex app-server client", async () => {
    const { binding, control, disposeBinding } = makeWorkspaceControlHarness();

    await expect(
      control.withSession("/workspace", async (runnerBinding, runtime) => {
        expect(runnerBinding).toBe(binding);
        expect(runtime).toBe(binding.runtime);
        return "ok";
      }),
    ).resolves.toBe("ok");

    expect(disposeBinding).toHaveBeenCalledWith(
      binding,
      "workspace control request completed for /workspace",
      { closeSharedCodexClient: false },
    );
  });

  test("disposes refresh capture sessions without closing the shared Codex app-server client", async () => {
    const { binding, control, disposeBinding } = makeWorkspaceControlHarness();
    const subscriber = {
      data: { connectionId: "subscriber-1" },
      send: mock((_message: string) => 1),
    } as unknown as StartServerSocket;
    control.registerSubscriber(subscriber, "/workspace");

    await control.emitRefreshNotifications({ workingDirectory: "/workspace" });

    expect(disposeBinding).toHaveBeenCalledWith(
      binding,
      "workspace control refresh capture completed for /workspace",
      { closeSharedCodexClient: false },
    );
  });
});
