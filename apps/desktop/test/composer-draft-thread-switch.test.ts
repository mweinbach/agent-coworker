import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import {
  composerDraftKeyForNewChatTarget,
  composerDraftKeyForThread,
  createEmptyComposerDraft,
  MAX_COMPOSER_DRAFT_ATTACHMENT_BYTE_SIZE,
  MAX_COMPOSER_DRAFT_ATTACHMENT_COUNT,
  MAX_COMPOSER_DRAFT_TOTAL_ATTACHMENT_BYTES,
  MAX_PERSISTED_COMPOSER_DRAFT_ATTACHMENT_BYTES,
  selectActiveComposerDraft,
} from "../src/app/composerDrafts";
import { persistNow, syncDesktopStateCacheNow } from "../src/app/store.helpers/persistence";
import { createComposerAttachmentFile } from "../src/lib/composerAttachments";
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

function deferred<T>() {
  let resolve: (value: T | PromiseLike<T>) => void = () => {};
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
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
      composerDraftRevisionFloorByKey: {},
      composerAttachmentIngestionCountByKey: {},
      composerSubmissionsByKey: {},
      taskSummariesByWorkspaceId: {
        "ws-1": [],
      },
      newChatLandingTarget: null,
    } as never);
  });

  afterEach(async () => {
    RUNTIME.jsonRpcSockets.delete("ws-1");
    RUNTIME.composerAttachmentIngestionTail = null;
    useAppStore.setState(snapshot, true);
    await persistNow(useAppStore.getState);
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
    expect(afterClear.composerDraftsByKey[composerDraftKeyForThread("thread-a")]).toBeUndefined();
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
    expect(state.composerDraftsByKey[composerDraftKeyForThread("thread-a")]).toBeUndefined();
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
      readyPromise: Promise.resolve(),
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
    expect(useAppStore.getState().composerDraftsByKey[key]).toBeUndefined();
    expect(
      useAppStore.getState().composerDraftsByKey[composerDraftKeyForThread("thread-b")]?.text,
    ).toBe("B changed while task creation was pending");
  });

  test("retains the full draft after failure and clears it after retry succeeds", async () => {
    let attempts = 0;
    useAppStore.setState({
      sendMessage: mock(
        async (
          _text: string,
          _busyPolicy?: "reject" | "steer",
          _attachments?: unknown,
          _references?: unknown,
          options?: {
            draftSubmission?: { key: string; revision: number; submissionId?: string };
          },
        ) => {
          attempts += 1;
          if (attempts === 1) return false;
          if (options?.draftSubmission) {
            useAppStore.getState().completeComposerSubmission(options.draftSubmission);
          }
          return true;
        },
      ),
    } as never);
    await useAppStore
      .getState()
      .addComposerAttachments([
        new File(["retry bytes"], "retry.txt", { type: "text/plain", lastModified: 30 }),
      ]);
    const key = composerDraftKeyForThread("thread-a");

    expect(
      useAppStore.getState().submitComposerDraft({ kind: "thread", threadId: "thread-a" }),
    ).toBe(true);
    await flushAsyncWork();
    expect(useAppStore.getState().composerSubmissionsByKey[key]).toMatchObject({
      phase: "failed",
      draft: { text: "send from A", attachments: [{ filename: "retry.txt" }] },
    });
    expect(useAppStore.getState().composerDraftsByKey[key]).toMatchObject({
      text: "send from A",
      attachments: [{ filename: "retry.txt" }],
    });

    expect(useAppStore.getState().retryComposerSubmission(key)).toBe(true);
    await flushAsyncWork();
    expect(attempts).toBe(2);
    expect(useAppStore.getState().composerSubmissionsByKey[key]).toBeUndefined();
    expect(useAppStore.getState().composerDraftsByKey[key]).toBeUndefined();
  });

  test("claims rapid submits once and retries the exact prepared revision with one client id", async () => {
    const key = composerDraftKeyForThread("thread-a");
    const bytes = new Uint8Array([1, 2, 3]);
    const readFile = mock(async () => bytes.buffer);
    const file = {
      name: "evidence.txt",
      type: "text/plain",
      size: bytes.byteLength,
      lastModified: 7,
      arrayBuffer: readFile,
    } as File;
    useAppStore.setState((state) => ({
      composerDraftsByKey: {
        ...state.composerDraftsByKey,
        [key]: {
          ...state.composerDraftsByKey[key]!,
          revision: 7,
          text: "original revision",
          attachments: [
            {
              filename: file.name,
              mimeType: file.type,
              size: file.size,
              lastModified: file.lastModified,
              file,
              signature: "evidence",
              contentBase64: "AQID",
            },
          ],
        },
      },
    }));

    const firstResult = deferred<boolean>();
    const secondResult = deferred<boolean>();
    const firstStarted = deferred<void>();
    const secondStarted = deferred<void>();
    const attempts: Array<{
      text: string;
      attachments: unknown;
      clientMessageId: string | undefined;
    }> = [];
    useAppStore.setState({
      sendMessage: mock(
        async (
          text: string,
          _busyPolicy?: "reject" | "steer",
          attachments?: unknown,
          _references?: unknown,
          options?: {
            draftSubmission?: { key: string; revision: number; submissionId?: string };
            clientMessageId?: string;
          },
        ) => {
          attempts.push({ text, attachments, clientMessageId: options?.clientMessageId });
          if (attempts.length === 1) {
            firstStarted.resolve();
            return await firstResult.promise;
          }
          secondStarted.resolve();
          const accepted = await secondResult.promise;
          if (accepted && options?.draftSubmission) {
            useAppStore.getState().completeComposerSubmission(options.draftSubmission);
          }
          return accepted;
        },
      ),
    } as never);

    const request = { kind: "thread" as const, threadId: "thread-a" };
    expect(useAppStore.getState().submitComposerDraft(request)).toBe(true);
    expect(useAppStore.getState().submitComposerDraft(request)).toBe(false);
    await firstStarted.promise;

    expect(useAppStore.getState().composerSubmissionsByKey[key]).toMatchObject({
      phase: "sending",
      draft: { revision: 7, text: "original revision" },
      prepared: {
        text: "original revision",
        attachments: [{ filename: "evidence.txt", contentBase64: "AQID" }],
      },
    });
    useAppStore.getState().setComposerText("newer revision");
    useAppStore.getState().removeComposerAttachment(0);

    firstResult.resolve(false);
    await flushAsyncWork();
    expect(useAppStore.getState().composerSubmissionsByKey[key]).toMatchObject({
      phase: "failed",
      draft: {
        revision: 7,
        text: "original revision",
        attachments: [{ filename: "evidence.txt" }],
      },
    });
    expect(useAppStore.getState().composerDraftsByKey[key]).toMatchObject({
      text: "newer revision",
      attachments: [],
    });

    expect(useAppStore.getState().retryComposerSubmission(key)).toBe(true);
    expect(useAppStore.getState().retryComposerSubmission(key)).toBe(false);
    await secondStarted.promise;
    expect(readFile).toHaveBeenCalledTimes(1);
    expect(attempts).toHaveLength(2);
    expect(attempts[1]).toEqual(attempts[0]);
    expect(attempts[0]?.clientMessageId).toBeTruthy();

    secondResult.resolve(true);
    await flushAsyncWork();
    expect(useAppStore.getState().composerSubmissionsByKey[key]).toBeUndefined();
    expect(useAppStore.getState().composerDraftsByKey[key]).toMatchObject({
      text: "newer revision",
      attachments: [],
    });
  });

  test("claims New Chat once and retries its exact revision without replacing later edits", async () => {
    const target = { kind: "project" as const, workspaceId: "ws-1" };
    const key = composerDraftKeyForNewChatTarget(target);
    const file = new File(["new-chat"], "brief.txt", {
      type: "text/plain",
      lastModified: 8,
    });
    const attempts: Array<{
      firstMessage?: string;
      clientMessageId?: string;
      draftAttachments?: Array<{ filename: string; contentBase64: string }>;
      draftSubmission?: { key: string; revision: number; submissionId?: string };
    }> = [];
    useAppStore.setState((state) => ({
      selectedThreadId: null,
      newChatLandingTarget: target,
      composerDraftsByKey: {
        ...state.composerDraftsByKey,
        [key]: {
          ...createEmptyComposerDraft("2026-01-01T00:00:00.000Z"),
          revision: 3,
          text: "start exact new chat",
          attachments: [
            {
              filename: file.name,
              mimeType: file.type,
              size: file.size,
              lastModified: file.lastModified,
              file,
              signature: "new-chat-brief",
              contentBase64: "bmV3LWNoYXQ=",
            },
          ],
        },
      },
      newThread: mock(async (options) => {
        attempts.push(options ?? {});
        if (attempts.length === 1) return false;
        if (options?.draftSubmission) {
          useAppStore.getState().completeComposerSubmission(options.draftSubmission);
        }
        return true;
      }),
    }));

    const request = {
      kind: "newChat" as const,
      target,
      provider: "openai" as const,
      model: "gpt-5.4",
      reasoningEffort: "high" as const,
    };
    expect(useAppStore.getState().submitComposerDraft(request)).toBe(true);
    expect(useAppStore.getState().submitComposerDraft(request)).toBe(false);
    await flushAsyncWork();
    expect(useAppStore.getState().composerSubmissionsByKey[key]).toMatchObject({
      phase: "failed",
      draft: {
        revision: 3,
        text: "start exact new chat",
        attachments: [{ filename: "brief.txt", contentBase64: "bmV3LWNoYXQ=" }],
      },
    });

    useAppStore.getState().setComposerText("keep newer New Chat edit");
    expect(useAppStore.getState().retryComposerSubmission(key)).toBe(true);
    await flushAsyncWork();
    expect(attempts).toHaveLength(2);
    expect(attempts[1]).toEqual(attempts[0]);
    expect(attempts[0]).toMatchObject({
      firstMessage: "start exact new chat",
      clientMessageId: expect.any(String),
      draftAttachments: [{ filename: "brief.txt", contentBase64: "bmV3LWNoYXQ=" }],
      draftSubmission: {
        key,
        revision: 3,
        submissionId: expect.any(String),
      },
    });
    expect(useAppStore.getState().composerSubmissionsByKey[key]).toBeUndefined();
    expect(useAppStore.getState().composerDraftsByKey[key]?.text).toBe("keep newer New Chat edit");
  });

  test("keeps a preparation failure retryable without replacing later draft edits", async () => {
    const key = composerDraftKeyForThread("thread-a");
    let reads = 0;
    const file = {
      name: "flaky.txt",
      type: "text/plain",
      size: 3,
      lastModified: 9,
      async arrayBuffer() {
        reads += 1;
        if (reads === 1) throw new Error("disk read failed");
        return new Uint8Array([4, 5, 6]).buffer;
      },
    } as File;
    useAppStore.setState(((state) => ({
      composerDraftsByKey: {
        ...state.composerDraftsByKey,
        [key]: {
          ...state.composerDraftsByKey[key]!,
          revision: 11,
          text: "retry this exact draft",
          attachments: [
            {
              filename: file.name,
              mimeType: file.type,
              size: file.size,
              lastModified: file.lastModified,
              file,
              signature: "flaky",
              contentBase64: "BAUG",
            },
          ],
        },
      },
      sendMessage: mock(
        async (
          text: string,
          _busyPolicy?: "reject" | "steer",
          attachments?: unknown,
          _references?: unknown,
          options?: {
            draftSubmission?: { key: string; revision: number; submissionId?: string };
            clientMessageId?: string;
          },
        ) => {
          expect(text).toBe("retry this exact draft");
          expect(attachments).toEqual([
            { filename: "flaky.txt", contentBase64: "BAUG", mimeType: "text/plain" },
          ]);
          if (options?.draftSubmission) {
            useAppStore.getState().completeComposerSubmission(options.draftSubmission);
          }
          return true;
        },
      ),
    })) as never);

    expect(
      useAppStore.getState().submitComposerDraft({ kind: "thread", threadId: "thread-a" }),
    ).toBe(true);
    await flushAsyncWork();
    const failed = useAppStore.getState().composerSubmissionsByKey[key];
    expect(failed).toMatchObject({
      phase: "failed",
      error: "disk read failed",
      prepared: null,
      draft: { revision: 11, text: "retry this exact draft" },
    });

    useAppStore.getState().setComposerText("keep this later edit");
    expect(useAppStore.getState().retryComposerSubmission(key)).toBe(true);
    await flushAsyncWork();

    expect(reads).toBe(2);
    expect(useAppStore.getState().composerSubmissionsByKey[key]).toBeUndefined();
    expect(useAppStore.getState().composerDraftsByKey[key]?.text).toBe("keep this later edit");
  });

  test("makes steer rejection retryable and restores accepted guidance without overwriting edits", async () => {
    const key = composerDraftKeyForThread("thread-a");
    useAppStore.setState((state) => ({
      threadRuntimeById: {
        ...state.threadRuntimeById,
        "thread-a": {
          ...state.threadRuntimeById["thread-a"]!,
          busy: true,
          activeTurnId: "turn-a",
        },
      },
    }));
    const firstResult = deferred<boolean>();
    const firstStarted = deferred<void>();
    let attempt = 0;
    useAppStore.setState({
      sendMessage: mock(
        async (
          _text: string,
          busyPolicy?: "reject" | "steer",
          _attachments?: unknown,
          _references?: unknown,
          options?: {
            draftSubmission?: { key: string; revision: number; submissionId?: string };
          },
        ) => {
          attempt += 1;
          expect(busyPolicy).toBe("steer");
          if (attempt === 1) {
            firstStarted.resolve();
            return await firstResult.promise;
          }
          if (options?.draftSubmission) {
            useAppStore.getState().completeComposerSubmission(options.draftSubmission);
          }
          return true;
        },
      ),
    } as never);

    expect(
      useAppStore.getState().submitComposerDraft({ kind: "thread", threadId: "thread-a" }),
    ).toBe(true);
    await firstStarted.promise;
    firstResult.resolve(false);
    await flushAsyncWork();
    expect(useAppStore.getState().composerSubmissionsByKey[key]).toMatchObject({
      phase: "failed",
      delivery: "steer",
    });

    expect(useAppStore.getState().retryComposerSubmission(key)).toBe(true);
    await flushAsyncWork();
    expect(useAppStore.getState().composerSubmissionsByKey[key]).toMatchObject({
      phase: "accepted",
      delivery: "steer",
      draft: { text: "send from A" },
    });
    expect(useAppStore.getState().composerDraftsByKey[key]?.text).toBe("");

    useAppStore.getState().setComposerText("do not overwrite this");
    expect(useAppStore.getState().editAcceptedComposerSubmission(key)).toBe(false);
    expect(useAppStore.getState().composerDraftsByKey[key]?.text).toBe("do not overwrite this");
    expect(useAppStore.getState().discardComposerDraft(key)).toBe(true);
    expect(useAppStore.getState().editAcceptedComposerSubmission(key)).toBe(true);
    expect(useAppStore.getState().composerDraftsByKey[key]?.text).toBe("send from A");
  });

  test("keeps accepted steer attachment previews owned until edit restores them", async () => {
    const originalRevokeObjectURL = URL.revokeObjectURL;
    const revokeObjectURL = mock(() => {});
    URL.revokeObjectURL = revokeObjectURL;
    const key = composerDraftKeyForThread("thread-a");
    const file = new File(["preview"], "diagram.png", {
      type: "image/png",
      lastModified: 12,
    });
    const sendResult = deferred<boolean>();

    try {
      useAppStore.setState(
        (state) =>
          ({
            threadRuntimeById: {
              ...state.threadRuntimeById,
              "thread-a": {
                ...state.threadRuntimeById["thread-a"]!,
                busy: true,
                activeTurnId: "turn-a",
              },
            },
            composerDraftsByKey: {
              ...state.composerDraftsByKey,
              [key]: {
                ...state.composerDraftsByKey[key]!,
                revision: 4,
                text: "",
                attachments: [
                  {
                    filename: file.name,
                    mimeType: file.type,
                    size: file.size,
                    lastModified: file.lastModified,
                    file,
                    previewUrl: "blob:accepted-steer-preview",
                    signature: "diagram",
                    contentBase64: "cHJldmlldw==",
                  },
                ],
              },
            },
            sendMessage: mock(
              async (
                _text: string,
                busyPolicy?: "reject" | "steer",
                _attachments?: unknown,
                _references?: unknown,
                options?: {
                  draftSubmission?: { key: string; revision: number; submissionId?: string };
                },
              ) => {
                expect(busyPolicy).toBe("steer");
                const accepted = await sendResult.promise;
                if (accepted && options?.draftSubmission) {
                  useAppStore.getState().completeComposerSubmission(options.draftSubmission);
                }
                return accepted;
              },
            ),
          }) as never,
      );

      expect(
        useAppStore.getState().submitComposerDraft({ kind: "thread", threadId: "thread-a" }),
      ).toBe(true);
      await flushAsyncWork();
      useAppStore.getState().removeComposerAttachment(0);
      expect(revokeObjectURL).not.toHaveBeenCalled();

      sendResult.resolve(true);
      await flushAsyncWork();
      expect(useAppStore.getState().composerSubmissionsByKey[key]).toMatchObject({
        phase: "accepted",
        draft: { attachments: [{ previewUrl: "blob:accepted-steer-preview" }] },
      });
      useAppStore.getState().setComposerDraftModel("openai", "gpt-5.4");
      expect(useAppStore.getState().editAcceptedComposerSubmission(key)).toBe(false);
      expect(useAppStore.getState().composerDraftsByKey[key]).toMatchObject({
        provider: "openai",
        model: "gpt-5.4",
      });
      expect(useAppStore.getState().discardComposerDraft(key)).toBe(true);
      expect(useAppStore.getState().editAcceptedComposerSubmission(key)).toBe(true);
      expect(useAppStore.getState().composerDraftsByKey[key]?.attachments).toHaveLength(1);
      expect(revokeObjectURL).not.toHaveBeenCalled();

      expect(useAppStore.getState().discardComposerDraft(key)).toBe(true);
      expect(revokeObjectURL).toHaveBeenCalledWith("blob:accepted-steer-preview");
    } finally {
      URL.revokeObjectURL = originalRevokeObjectURL;
    }
  });

  test("claims one interrupt until the busy turn settles", async () => {
    const interruptResult = deferred<void>();
    const interruptStarted = deferred<void>();
    const request = mock(async (method: string) => {
      expect(method).toBe("turn/interrupt");
      interruptStarted.resolve();
      await interruptResult.promise;
      return {};
    });
    RUNTIME.jsonRpcSockets.set("ws-1", {
      __coworkUrl: "ws://mock",
      __coworkOpened: true,
      connect: () => {},
      request,
    } as never);
    useAppStore.setState((state) => ({
      threadRuntimeById: {
        ...state.threadRuntimeById,
        "thread-a": {
          ...state.threadRuntimeById["thread-a"]!,
          busy: true,
          activeTurnId: "turn-a",
          interruptPending: false,
        },
      },
    }));

    expect(useAppStore.getState().cancelThread("thread-a")).toBe(true);
    expect(useAppStore.getState().cancelThread("thread-a")).toBe(false);
    await interruptStarted.promise;
    expect(request).toHaveBeenCalledTimes(1);
    expect(useAppStore.getState().threadRuntimeById["thread-a"]?.interruptPending).toBe(true);

    interruptResult.resolve();
    await flushAsyncWork();
    expect(useAppStore.getState().threadRuntimeById["thread-a"]?.interruptPending).toBe(true);
  });

  test("releases a failed interrupt claim so Stop can retry", async () => {
    let attempts = 0;
    const request = mock(async (method: string) => {
      expect(method).toBe("turn/interrupt");
      attempts += 1;
      if (attempts === 1) throw new Error("interrupt transport failed");
      return {};
    });
    RUNTIME.jsonRpcSockets.set("ws-1", {
      __coworkUrl: "ws://mock",
      __coworkOpened: true,
      connect: () => {},
      request,
    } as never);
    useAppStore.setState((state) => ({
      threadRuntimeById: {
        ...state.threadRuntimeById,
        "thread-a": {
          ...state.threadRuntimeById["thread-a"]!,
          busy: true,
          activeTurnId: "turn-a",
          interruptPending: false,
        },
      },
    }));

    expect(useAppStore.getState().cancelThread("thread-a")).toBe(true);
    await flushAsyncWork();
    expect(useAppStore.getState().threadRuntimeById["thread-a"]?.interruptPending).toBe(false);
    expect(useAppStore.getState().notifications.at(-1)).toMatchObject({
      title: "Unable to stop response",
      detail: "interrupt transport failed",
    });

    expect(useAppStore.getState().cancelThread("thread-a")).toBe(true);
    await flushAsyncWork();
    expect(request).toHaveBeenCalledTimes(2);
    expect(useAppStore.getState().threadRuntimeById["thread-a"]?.interruptPending).toBe(true);
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

  test("rejects count, per-file, per-draft, and persisted aggregate limits before reading files", async () => {
    const readFile = mock(async () => new Uint8Array([1]).buffer);
    const sizedFile = (name: string, size: number) =>
      ({
        name,
        type: "application/octet-stream",
        size,
        lastModified: 1,
        arrayBuffer: readFile,
      }) as File;

    await expect(
      useAppStore
        .getState()
        .addComposerAttachments(
          Array.from({ length: MAX_COMPOSER_DRAFT_ATTACHMENT_COUNT + 1 }, (_, index) =>
            sizedFile(`count-${index}.bin`, 0),
          ),
        ),
    ).rejects.toThrow(`max ${MAX_COMPOSER_DRAFT_ATTACHMENT_COUNT}`);
    await expect(
      useAppStore
        .getState()
        .addComposerAttachments([
          sizedFile("oversized.bin", MAX_COMPOSER_DRAFT_ATTACHMENT_BYTE_SIZE + 1),
        ]),
    ).rejects.toThrow("File too large");
    await expect(
      useAppStore
        .getState()
        .addComposerAttachments([
          sizedFile(
            "aggregate-a.bin",
            Math.floor(MAX_COMPOSER_DRAFT_TOTAL_ATTACHMENT_BYTES / 2) + 1,
          ),
          sizedFile(
            "aggregate-b.bin",
            Math.floor(MAX_COMPOSER_DRAFT_TOTAL_ATTACHMENT_BYTES / 2) + 1,
          ),
        ]),
    ).rejects.toThrow("Draft attachments too large in total");

    const existingFile = new File(["x"], "existing.bin", {
      type: "application/octet-stream",
      lastModified: 1,
    });
    useAppStore.setState((state) => ({
      selectedThreadId: "thread-b",
      composerDraftsByKey: {
        ...state.composerDraftsByKey,
        [composerDraftKeyForThread("thread-a")]: {
          ...state.composerDraftsByKey[composerDraftKeyForThread("thread-a")]!,
          attachments: [
            {
              filename: existingFile.name,
              mimeType: existingFile.type,
              size: MAX_PERSISTED_COMPOSER_DRAFT_ATTACHMENT_BYTES - 1,
              lastModified: existingFile.lastModified,
              file: existingFile,
              signature: "existing",
              contentBase64: "eA==",
            },
          ],
        },
      },
    }));
    await expect(
      useAppStore.getState().addComposerAttachments([sizedFile("global-overflow.bin", 2)]),
    ).rejects.toThrow("Saved draft attachments too large in total");

    expect(readFile).not.toHaveBeenCalled();
    expect(useAppStore.getState().composerAttachmentIngestionCountByKey).toEqual({});
  });

  test("serializes concurrent ingestion batches before validating their combined count", async () => {
    const firstBatch = Array.from(
      { length: 5 },
      (_, index) => new File([], `first-${index}.txt`, { type: "text/plain", lastModified: index }),
    );
    const secondBatch = Array.from(
      { length: 4 },
      (_, index) =>
        new File([], `second-${index}.txt`, { type: "text/plain", lastModified: index }),
    );

    const firstIngestion = useAppStore.getState().addComposerAttachments(firstBatch);
    const secondIngestion = useAppStore.getState().addComposerAttachments(secondBatch);

    expect(
      useAppStore.getState().composerAttachmentIngestionCountByKey[
        composerDraftKeyForThread("thread-a")
      ],
    ).toBe(2);
    await firstIngestion;
    await expect(secondIngestion).rejects.toThrow(`max ${MAX_COMPOSER_DRAFT_ATTACHMENT_COUNT}`);
    expect(
      useAppStore.getState().composerDraftsByKey[composerDraftKeyForThread("thread-a")]
        ?.attachments,
    ).toHaveLength(5);
    expect(useAppStore.getState().composerAttachmentIngestionCountByKey).toEqual({});
  });

  test("one-off send adaptation does not allocate a duplicate image object URL", async () => {
    const originalCreateObjectURL = URL.createObjectURL;
    const createObjectURL = mock(() => "blob:persistent-draft-preview");
    URL.createObjectURL = createObjectURL;

    try {
      const file = new File(["image"], "one-off.png", {
        type: "image/png",
        lastModified: 1,
      });
      await useAppStore.getState().addComposerAttachments([file]);
      expect(createObjectURL).toHaveBeenCalledTimes(1);

      const transient = createComposerAttachmentFile(file);
      expect(transient).not.toHaveProperty("previewUrl");
      expect(createObjectURL).toHaveBeenCalledTimes(1);
    } finally {
      URL.createObjectURL = originalCreateObjectURL;
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

  test("store pruning keeps memory and restart persistence aligned and revokes removed previews", () => {
    const originalRevokeObjectURL = URL.revokeObjectURL;
    const revokeObjectURL = mock(() => {});
    URL.revokeObjectURL = revokeObjectURL;
    const nowMs = Date.parse("2026-07-10T20:00:00.000Z");
    const realThreads = Array.from({ length: 51 }, (_, index) => ({
      id: `real-${index}`,
      workspaceId: "ws-1",
      title: `Real ${index}`,
      status: "active" as const,
      createdAt: "2026-01-01T00:00:00.000Z",
      lastMessageAt: "2026-01-01T00:00:00.000Z",
      sessionId: `real-${index}`,
      messageCount: 0,
      lastEventSeq: 0,
    }));
    const tombstoneThreads = Array.from({ length: 20 }, (_, index) => ({
      ...realThreads[0]!,
      id: `tombstone-${index}`,
      title: `Tombstone ${index}`,
      sessionId: `tombstone-${index}`,
    }));
    const oldFile = new File(["x"], "old.png", { type: "image/png", lastModified: 1 });
    const realDrafts = Object.fromEntries(
      realThreads.map((thread, index) => [
        composerDraftKeyForThread(thread.id),
        {
          ...createEmptyComposerDraft(new Date(nowMs - index * 1_000).toISOString()),
          revision: index + 1,
          text: `real draft ${index}`,
          attachments:
            index === 50
              ? [
                  {
                    filename: oldFile.name,
                    mimeType: oldFile.type,
                    size: oldFile.size,
                    lastModified: oldFile.lastModified,
                    file: oldFile,
                    previewUrl: "blob:pruned-store-preview",
                    signature: "old.png\u0000image/png\u00001\u00001",
                    contentBase64: "eA==",
                  },
                ]
              : [],
        },
      ]),
    );
    const tombstones = Object.fromEntries(
      tombstoneThreads.map((thread, index) => [
        composerDraftKeyForThread(thread.id),
        {
          ...createEmptyComposerDraft(new Date(nowMs - index).toISOString()),
          revision: index + 1,
          generation: index + 1,
        },
      ]),
    );

    try {
      useAppStore.setState({
        selectedThreadId: "real-0",
        threads: [...realThreads, ...tombstoneThreads],
        composerDraftsByKey: { ...tombstones, ...realDrafts },
        composerAttachmentIngestionCountByKey: {},
      });
      useAppStore.getState().pruneComposerDrafts(nowMs);
      const persistedState = syncDesktopStateCacheNow(useAppStore.getState);

      const memoryDraftKeys = Object.keys(useAppStore.getState().composerDraftsByKey);
      const persistedDraftKeys = Object.keys(persistedState.composerDrafts ?? {});
      expect(memoryDraftKeys).toHaveLength(50);
      expect(memoryDraftKeys.every((key) => key.startsWith("thread:real-"))).toBe(true);
      expect(persistedDraftKeys).toEqual(memoryDraftKeys);
      expect(revokeObjectURL).toHaveBeenCalledWith("blob:pruned-store-preview");
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
    let markReadStarted: (() => void) | undefined;
    const readStarted = new Promise<void>((resolve) => {
      markReadStarted = resolve;
    });
    const file = new File([new Uint8Array([1, 2, 3, 4])], "slow.png", {
      type: "image/png",
      lastModified: 20,
    });
    Object.defineProperty(file, "arrayBuffer", {
      value: () => {
        markReadStarted?.();
        return readGate;
      },
    });

    try {
      useAppStore.setState({ composerDraftsByKey: {} });
      const addPromise = useAppStore.getState().addComposerAttachments([file]);
      await readStarted;
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

  test("keeps reasoning effort on the thread when its runtime state is replaced", () => {
    useAppStore.setState((state) => ({
      threadRuntimeById: {
        ...state.threadRuntimeById,
        "thread-a": {
          ...state.threadRuntimeById["thread-a"],
          sessionId: null,
        },
      },
    }));
    useAppStore.getState().setThreadReasoningEffort("thread-a", "openai", "medium");

    expect(useAppStore.getState().threads.find((thread) => thread.id === "thread-a")).toMatchObject(
      {
        reasoningEffort: "medium",
      },
    );

    useAppStore.setState((state) => ({
      selectedThreadId: "thread-b",
      threadRuntimeById: {
        ...state.threadRuntimeById,
        "thread-a": defaultThreadRuntime(),
      },
    }));
    useAppStore.setState({ selectedThreadId: "thread-a" });

    expect(useAppStore.getState().threads.find((thread) => thread.id === "thread-a")).toMatchObject(
      {
        reasoningEffort: "medium",
      },
    );
  });
});
