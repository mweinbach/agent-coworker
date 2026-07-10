import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import {
  composerDraftKeyForNewChatTarget,
  composerDraftKeyForThread,
  createEmptyComposerDraft,
  selectActiveComposerDraft,
} from "../src/app/composerDrafts";
import { DESKTOP_API_OVERRIDE_KEY } from "../src/lib/desktopApiOverride";
import { createDesktopApiMock } from "./helpers/mockDesktopCommands";

const { useAppStore } = await import("../src/app/store");
const { RUNTIME, defaultThreadRuntime, defaultWorkspaceRuntime } = await import(
  "../src/app/store.helpers/runtimeState"
);

async function flushAsyncWork(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
}

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
        "ws-1": {
          ...defaultWorkspaceRuntime(),
          serverUrl: "ws://mock",
        },
      },
      threadRuntimeById: {
        "thread-a": {
          ...defaultThreadRuntime(),
          sessionId: "session-a",
          connected: true,
          transcriptOnly: false,
        },
        "thread-b": {
          ...defaultThreadRuntime(),
          sessionId: "session-b",
          connected: true,
        },
      },
      composerDraftsByKey: {
        [composerDraftKeyForThread("thread-a")]: {
          ...createEmptyComposerDraft("2026-01-01T00:00:00.000Z"),
          revision: 1,
          text: "send from A",
        },
        [composerDraftKeyForThread("thread-b")]: {
          ...createEmptyComposerDraft("2026-01-01T00:00:00.000Z"),
          revision: 1,
          text: "draft for B",
        },
      },
      taskSummariesByWorkspaceId: {
        "ws-1": [],
      },
      newChatLandingTarget: null,
    } as never);
  });

  afterEach(() => {
    RUNTIME.jsonRpcSockets.delete("ws-1");
    useAppStore.setState(snapshot, true);
    Reflect.deleteProperty(globalThis, DESKTOP_API_OVERRIDE_KEY);
  });

  test("keeps existing-chat and New Chat target drafts independent", async () => {
    useAppStore.setState({
      selectedThreadId: null,
      newChatLandingTarget: { kind: "oneOff" },
      composerDraftsByKey: {},
    } as never);

    useAppStore.getState().setComposerText("one-off landing draft");
    useAppStore.getState().setNewChatLandingTarget({
      kind: "project",
      workspaceId: "ws-1",
    });
    useAppStore.getState().setComposerText("project landing draft");

    await useAppStore.getState().selectThread("thread-a");
    useAppStore.getState().setComposerText("draft for A");

    await useAppStore.getState().openNewChatLanding({ defaultTargetKind: "oneOff" });
    const state = useAppStore.getState();
    expect(state.selectedThreadId).toBeNull();
    expect(selectActiveComposerDraft(state).text).toBe("one-off landing draft");
    expect(
      state.composerDraftsByKey[
        composerDraftKeyForNewChatTarget({ kind: "project", workspaceId: "ws-1" })
      ]?.text,
    ).toBe("project landing draft");
    expect(state.composerDraftsByKey[composerDraftKeyForThread("thread-a")]?.text).toBe(
      "draft for A",
    );
  });

  test("a delayed clear from A clears only its captured revision and never B", async () => {
    const owner = {
      key: composerDraftKeyForThread("thread-a"),
      revision: useAppStore.getState().composerDraftsByKey[composerDraftKeyForThread("thread-a")]
        ?.revision as number,
    };
    let releaseClear: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      releaseClear = resolve;
    });
    const delayedClear = (async () => {
      await gate;
      return useAppStore.getState().clearComposerDraft(owner);
    })();

    useAppStore.setState({ selectedThreadId: "thread-b" });
    useAppStore.getState().setComposerText("new text in B");
    releaseClear?.();

    expect(await delayedClear).toBe(true);
    const afterClear = useAppStore.getState();
    expect(afterClear.composerDraftsByKey[composerDraftKeyForThread("thread-a")]?.text).toBe("");
    expect(afterClear.composerDraftsByKey[composerDraftKeyForThread("thread-b")]?.text).toBe(
      "new text in B",
    );

    useAppStore.setState({ selectedThreadId: "thread-a" });
    useAppStore.getState().setComposerText("newer text in A");
    expect(useAppStore.getState().clearComposerDraft(owner)).toBe(false);
    expect(
      useAppStore.getState().composerDraftsByKey[composerDraftKeyForThread("thread-a")]?.text,
    ).toBe("newer text in A");
  });

  test("clears the submitted revision only after turn/start succeeds", async () => {
    let resolveTurnStart: (() => void) | undefined;
    const turnStartGate = new Promise<void>((resolve) => {
      resolveTurnStart = resolve;
    });
    RUNTIME.jsonRpcSockets.set("ws-1", {
      __coworkUrl: "ws://mock",
      __coworkOpened: true,
      connect: () => {},
      request: async (method: string) => {
        if (method === "turn/start") await turnStartGate;
        return {};
      },
    } as never);
    const owner = {
      key: composerDraftKeyForThread("thread-a"),
      revision: useAppStore.getState().composerDraftsByKey[composerDraftKeyForThread("thread-a")]
        ?.revision as number,
    };

    expect(
      await useAppStore.getState().sendMessage("send from A", "reject", undefined, undefined, {
        targetThreadId: "thread-a",
        draftSubmission: owner,
      }),
    ).toBe(true);
    expect(
      useAppStore.getState().composerDraftsByKey[composerDraftKeyForThread("thread-a")]?.text,
    ).toBe("send from A");

    useAppStore.setState({ selectedThreadId: "thread-b" });
    useAppStore.getState().setComposerText("new text in B");
    resolveTurnStart?.();
    await flushAsyncWork();

    const state = useAppStore.getState();
    expect(state.composerDraftsByKey[composerDraftKeyForThread("thread-a")]?.text).toBe("");
    expect(state.composerDraftsByKey[composerDraftKeyForThread("thread-b")]?.text).toBe(
      "new text in B",
    );
  });

  test("a delayed task command clears only A while B receives new text", async () => {
    let resolveCommand: (() => void) | undefined;
    const commandGate = new Promise<void>((resolve) => {
      resolveCommand = resolve;
    });
    RUNTIME.jsonRpcSockets.set("ws-1", {
      __coworkUrl: "ws://mock",
      __coworkOpened: true,
      connect: () => {},
      request: async (method: string) => {
        if (method === "command/execute") await commandGate;
        return {};
      },
    } as never);
    useAppStore.getState().setComposerText("/task investigate the race");
    const key = composerDraftKeyForThread("thread-a");
    const owner = {
      key,
      revision: useAppStore.getState().composerDraftsByKey[key]?.revision as number,
    };

    const send = useAppStore
      .getState()
      .sendMessage("/task investigate the race", "reject", undefined, undefined, {
        targetThreadId: "thread-a",
        draftSubmission: owner,
      });
    useAppStore.setState({ selectedThreadId: "thread-b" });
    useAppStore.getState().setComposerText("B changed while task creation was pending");
    resolveCommand?.();

    expect(await send).toBe(true);
    expect(useAppStore.getState().composerDraftsByKey[key]?.text).toBe("");
    expect(
      useAppStore.getState().composerDraftsByKey[composerDraftKeyForThread("thread-b")]?.text,
    ).toBe("B changed while task creation was pending");
  });

  test("retains the full draft after failure and clears it after retry succeeds", async () => {
    RUNTIME.jsonRpcSockets.set("ws-1", {
      __coworkUrl: "ws://mock",
      __coworkOpened: true,
      connect: () => {},
      request: async (method: string) => {
        if (method === "turn/start") throw new Error("offline");
        return {};
      },
    } as never);
    await useAppStore
      .getState()
      .addComposerAttachments([
        new File(["retry bytes"], "retry.txt", { type: "text/plain", lastModified: 30 }),
      ]);
    const key = composerDraftKeyForThread("thread-a");
    const failedOwner = {
      key,
      revision: useAppStore.getState().composerDraftsByKey[key]?.revision as number,
    };
    const wireAttachment = {
      filename: "retry.txt",
      mimeType: "text/plain",
      contentBase64: "cmV0cnkgYnl0ZXM=",
    };

    expect(
      await useAppStore
        .getState()
        .sendMessage("send from A", "reject", [wireAttachment], undefined, {
          targetThreadId: "thread-a",
          draftSubmission: failedOwner,
        }),
    ).toBe(true);
    await flushAsyncWork();
    expect(useAppStore.getState().composerDraftsByKey[key]).toMatchObject({
      revision: failedOwner.revision,
      text: "send from A",
      attachments: [{ filename: "retry.txt" }],
    });

    RUNTIME.jsonRpcSockets.set("ws-1", {
      __coworkUrl: "ws://mock",
      __coworkOpened: true,
      connect: () => {},
      request: async () => ({}),
    } as never);
    expect(
      await useAppStore
        .getState()
        .sendMessage("send from A", "reject", [wireAttachment], undefined, {
          targetThreadId: "thread-a",
          draftSubmission: failedOwner,
        }),
    ).toBe(true);
    await flushAsyncWork();
    expect(useAppStore.getState().composerDraftsByKey[key]).toMatchObject({
      revision: failedOwner.revision + 1,
      text: "",
      attachments: [],
    });
  });

  test("preserves exact attachments across switches and revokes only on removal", async () => {
    const originalCreateObjectURL = URL.createObjectURL;
    const originalRevokeObjectURL = URL.revokeObjectURL;
    const createObjectURL = mock(() => "blob:thread-a-preview");
    const revokeObjectURL = mock(() => {});
    URL.createObjectURL = createObjectURL;
    URL.revokeObjectURL = revokeObjectURL;

    try {
      const image = new File(["image bytes"], "diagram.png", {
        type: "image/png",
        lastModified: 1_720_000_000_000,
      });
      await useAppStore.getState().addComposerAttachments([image]);

      useAppStore.setState({ selectedThreadId: "thread-b" });
      useAppStore.getState().setComposerText("updated B");
      expect(revokeObjectURL).not.toHaveBeenCalled();

      useAppStore.setState({ selectedThreadId: "thread-a" });
      const restored = selectActiveComposerDraft(useAppStore.getState());
      expect(restored.attachments).toHaveLength(1);
      expect(restored.attachments[0]).toMatchObject({
        filename: "diagram.png",
        mimeType: "image/png",
        previewUrl: "blob:thread-a-preview",
      });
      expect(await restored.attachments[0]?.file.text()).toBe("image bytes");
      expect(createObjectURL).toHaveBeenCalledTimes(1);
      expect(revokeObjectURL).not.toHaveBeenCalled();

      useAppStore.getState().removeComposerAttachment(0);
      expect(revokeObjectURL).toHaveBeenCalledTimes(1);
      expect(revokeObjectURL).toHaveBeenCalledWith("blob:thread-a-preview");
    } finally {
      URL.createObjectURL = originalCreateObjectURL;
      URL.revokeObjectURL = originalRevokeObjectURL;
    }
  });

  test("revokes completed previews when another file in the batch cannot be read", async () => {
    const originalCreateObjectURL = URL.createObjectURL;
    const originalRevokeObjectURL = URL.revokeObjectURL;
    const revokeObjectURL = mock(() => {});
    URL.createObjectURL = () => "blob:completed-preview";
    URL.revokeObjectURL = revokeObjectURL;
    const unreadable = new File(["bad"], "bad.txt", {
      type: "text/plain",
      lastModified: 2,
    });
    Object.defineProperty(unreadable, "arrayBuffer", {
      value: async () => {
        throw new Error("read failed");
      },
    });

    try {
      await expect(
        useAppStore
          .getState()
          .addComposerAttachments([
            new File(["image"], "good.png", { type: "image/png", lastModified: 1 }),
            unreadable,
          ]),
      ).rejects.toThrow("read failed");

      expect(selectActiveComposerDraft(useAppStore.getState()).attachments).toEqual([]);
      expect(revokeObjectURL).toHaveBeenCalledTimes(1);
      expect(revokeObjectURL).toHaveBeenCalledWith("blob:completed-preview");
    } finally {
      URL.createObjectURL = originalCreateObjectURL;
      URL.revokeObjectURL = originalRevokeObjectURL;
    }
  });

  test("restores the complete draft unit for each New Chat target", async () => {
    useAppStore.setState({
      selectedThreadId: null,
      newChatLandingTarget: { kind: "project", workspaceId: "ws-1" },
      composerDraftsByKey: {},
    });
    useAppStore.getState().setComposerText("project text", [{ kind: "skill", name: "documents" }]);
    useAppStore.getState().setComposerDraftModel("openai", "gpt-5.4");
    useAppStore.getState().setComposerDraftReasoningEffort("high");
    await useAppStore
      .getState()
      .addComposerAttachments([
        new File(["project file"], "project.txt", { type: "text/plain", lastModified: 10 }),
      ]);

    useAppStore.getState().setNewChatLandingTarget({ kind: "oneOff" });
    useAppStore.getState().setComposerText("one-off text");
    useAppStore.getState().setComposerDraftModel("google", "gemini-2.5-pro");

    const oneOff = selectActiveComposerDraft(useAppStore.getState());
    expect(oneOff).toMatchObject({
      text: "one-off text",
      attachments: [],
      provider: "google",
      model: "gemini-2.5-pro",
      reasoningEffort: null,
    });

    useAppStore.getState().setNewChatLandingTarget({
      kind: "project",
      workspaceId: "ws-1",
    });
    const project = selectActiveComposerDraft(useAppStore.getState());
    expect(project).toMatchObject({
      text: "project text",
      references: [{ kind: "skill", name: "documents" }],
      provider: "openai",
      model: "gpt-5.4",
      reasoningEffort: "high",
    });
    expect(project.attachments).toHaveLength(1);
    expect(await project.attachments[0]?.file.text()).toBe("project file");
  });

  test("workspace removal prunes its New Chat draft and revokes the preview", async () => {
    const originalRevokeObjectURL = URL.revokeObjectURL;
    const revokeObjectURL = mock(() => {});
    URL.revokeObjectURL = revokeObjectURL;
    const key = composerDraftKeyForNewChatTarget({ kind: "project", workspaceId: "ws-1" });
    const file = new File(["image"], "project.png", {
      type: "image/png",
      lastModified: 40,
    });
    useAppStore.setState({
      selectedThreadId: null,
      newChatLandingTarget: { kind: "project", workspaceId: "ws-1" },
      composerDraftsByKey: {
        [key]: {
          ...createEmptyComposerDraft("2026-07-10T20:00:00.000Z"),
          revision: 1,
          attachments: [
            {
              filename: file.name,
              mimeType: file.type,
              size: file.size,
              lastModified: file.lastModified,
              file,
              previewUrl: "blob:removed-workspace-preview",
              signature: "project.png\u0000image/png\u00005\u000040",
              contentBase64: "aW1hZ2U=",
            },
          ],
        },
      },
    });

    try {
      await useAppStore.getState().removeWorkspace("ws-1");

      expect(useAppStore.getState().composerDraftsByKey[key]).toBeUndefined();
      expect(revokeObjectURL).toHaveBeenCalledWith("blob:removed-workspace-preview");
    } finally {
      URL.revokeObjectURL = originalRevokeObjectURL;
    }
  });

  test("does not resurrect an attachment after its draft is discarded mid-read", async () => {
    const originalCreateObjectURL = URL.createObjectURL;
    const originalRevokeObjectURL = URL.revokeObjectURL;
    const revokeObjectURL = mock(() => {});
    URL.createObjectURL = () => "blob:stale-preview";
    URL.revokeObjectURL = revokeObjectURL;
    let releaseRead: ((buffer: ArrayBuffer) => void) | undefined;
    const readGate = new Promise<ArrayBuffer>((resolve) => {
      releaseRead = resolve;
    });
    const file = new File([new Uint8Array([1, 2, 3, 4])], "slow.png", {
      type: "image/png",
      lastModified: 20,
    });
    Object.defineProperty(file, "arrayBuffer", {
      value: () => readGate,
    });

    try {
      useAppStore.setState({ composerDraftsByKey: {} });
      const addPromise = useAppStore.getState().addComposerAttachments([file]);
      expect(useAppStore.getState().discardComposerDraft()).toBe(true);
      releaseRead?.(new Uint8Array([1, 2, 3, 4]).buffer);
      await addPromise;

      const draft = selectActiveComposerDraft(useAppStore.getState());
      expect(draft.attachments).toEqual([]);
      expect(revokeObjectURL).toHaveBeenCalledWith("blob:stale-preview");
    } finally {
      URL.createObjectURL = originalCreateObjectURL;
      URL.revokeObjectURL = originalRevokeObjectURL;
    }
  });
});
