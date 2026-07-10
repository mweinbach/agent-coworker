import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { DESKTOP_API_OVERRIDE_KEY } from "../src/lib/desktopApiOverride";
import { createDesktopApiMock } from "./helpers/mockDesktopCommands";

const { useAppStore } = await import("../src/app/store");
const { defaultThreadRuntime, defaultWorkspaceRuntime } = await import(
  "../src/app/store.helpers/runtimeState"
);

describe("composer draft clear after send", () => {
  let snapshot: ReturnType<typeof useAppStore.getState>;

  beforeEach(() => {
    Object.assign(globalThis, {
      [DESKTOP_API_OVERRIDE_KEY]: createDesktopApiMock(),
    });
    snapshot = useAppStore.getState();
    useAppStore.setState({
      selectedWorkspaceId: "ws-1",
      selectedThreadId: "thread-a",
      workspaces: [
        {
          id: "ws-1",
          name: "Workspace",
          path: "/tmp/ws",
          createdAt: "2026-01-01T00:00:00.000Z",
          lastOpenedAt: "2026-01-01T00:00:00.000Z",
          wsProtocol: "jsonrpc",
          defaultEnableMcp: true,
          defaultBackupsEnabled: true,
          yolo: false,
        },
      ],
      threads: [
        {
          id: "thread-a",
          workspaceId: "ws-1",
          title: "A",
          status: "active",
          createdAt: "2026-01-01T00:00:00.000Z",
          lastMessageAt: "2026-01-01T00:00:00.000Z",
          sessionId: "session-a",
          messageCount: 0,
          lastEventSeq: 0,
        },
        {
          id: "thread-b",
          workspaceId: "ws-1",
          title: "B",
          status: "active",
          createdAt: "2026-01-01T00:00:00.000Z",
          lastMessageAt: "2026-01-01T00:00:00.000Z",
          sessionId: "session-b",
          messageCount: 0,
          lastEventSeq: 0,
        },
      ],
      workspaceRuntimeById: {
        "ws-1": defaultWorkspaceRuntime(),
      },
      threadRuntimeById: {
        "thread-a": {
          ...defaultThreadRuntime(),
          sessionId: "session-a",
          connected: true,
          transcriptOnly: true,
        },
        "thread-b": {
          ...defaultThreadRuntime(),
          sessionId: "session-b",
          connected: true,
        },
      },
      composerText: "send from A",
      composerTextByThreadId: {
        "thread-a": "send from A",
        "thread-b": "draft for B",
      },
      taskSummariesByWorkspaceId: {
        "ws-1": [],
      },
      newChatLandingTarget: null,
    } as never);
  });

  afterEach(() => {
    useAppStore.setState(snapshot, true);
    Reflect.deleteProperty(globalThis, DESKTOP_API_OVERRIDE_KEY);
  });

  test("preserves New Chat landing draft when selecting a chat and returning", async () => {
    useAppStore.setState({
      selectedThreadId: null,
      composerText: "landing draft",
      composerTextByThreadId: {
        "thread-a": "draft for A",
        "thread-b": "draft for B",
      },
    } as never);

    useAppStore.getState().setComposerText("landing draft");
    expect(useAppStore.getState().composerTextByThreadId.__landing__).toBe("landing draft");

    await useAppStore.getState().selectThread("thread-a");
    // selectThread hydrates; swap should restore thread-a draft when hydrate path runs.
    // Force a pure swap via openNewChatLanding after manually selecting A.
    useAppStore.setState({
      selectedThreadId: "thread-a",
      composerText: "draft for A",
      composerTextByThreadId: {
        __landing__: "landing draft",
        "thread-a": "draft for A",
        "thread-b": "draft for B",
      },
    } as never);

    await useAppStore.getState().openNewChatLanding({ defaultTargetKind: "oneOff" });
    const state = useAppStore.getState();
    expect(state.selectedThreadId).toBeNull();
    expect(state.composerText).toBe("landing draft");
    expect(state.composerTextByThreadId.__landing__).toBe("landing draft");
  });

  test("keeps the newly selected thread draft when send resolves after a switch", async () => {
    let releaseNewThread: (() => void) | null = null;
    const newThreadGate = new Promise<boolean>((resolve) => {
      releaseNewThread = () => resolve(true);
    });

    const previousNewThread = useAppStore.getState().newThread;
    useAppStore.setState({
      newThread: async () => {
        await newThreadGate;
        return true;
      },
    } as never);

    try {
      const sendPromise = useAppStore.getState().sendMessage("send from A");

      // User switches chats while the send path is still awaiting network work.
      useAppStore.setState({
        selectedThreadId: "thread-b",
        composerText: "draft for B",
        composerTextByThreadId: {
          "thread-a": "send from A",
          "thread-b": "draft for B",
        },
      } as never);

      releaseNewThread?.();
      const accepted = await sendPromise;
      expect(accepted).toBe(true);

      const state = useAppStore.getState();
      expect(state.selectedThreadId).toBe("thread-b");
      expect(state.composerText).toBe("draft for B");
      expect(state.composerTextByThreadId["thread-a"]).toBeUndefined();
      expect(state.composerTextByThreadId["thread-b"]).toBe("draft for B");
    } finally {
      useAppStore.setState({ newThread: previousNewThread } as never);
    }
  });
});
