import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import {
  composerDraftKeyForNewChatTarget,
  createEmptyComposerDraft,
} from "../src/app/composerDrafts";
import { useAppStore } from "../src/app/store";
import type { AppStoreState } from "../src/app/store.helpers";

async function flushAsyncWork(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("New Chat failure safety", () => {
  const target = { kind: "oneOff" as const };
  const key = composerDraftKeyForNewChatTarget(target);
  let snapshot: AppStoreState;

  beforeEach(() => {
    snapshot = useAppStore.getState();
    const file = new File(["draft attachment"], "brief.txt", {
      type: "text/plain",
      lastModified: 123,
    });
    useAppStore.setState({
      selectedThreadId: null,
      newChatLandingTarget: target,
      composerDraftsByKey: {
        [key]: {
          ...createEmptyComposerDraft("2026-07-12T00:00:00.000Z"),
          revision: 3,
          text: "Preserve this exact draft",
          provider: "google",
          model: "gemini-2.5-flash",
          attachments: [
            {
              filename: file.name,
              mimeType: file.type,
              size: file.size,
              lastModified: file.lastModified,
              file,
              signature: "brief.txt:text/plain:16:123",
              contentBase64: "ZHJhZnQgYXR0YWNobWVudA==",
            },
          ],
        },
      },
      composerDraftRevisionFloorByKey: {},
      composerAttachmentIngestionCountByKey: {},
      composerSubmissionsByKey: {},
    });
  });

  afterEach(() => {
    useAppStore.setState(snapshot, true);
  });

  test("Cancel preserves text and attachments and returns the draft to editable state", async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const newThreadImpl: AppStoreState["newThread"] = async (options) => {
      await gate;
      return options?.signal?.aborted !== true;
    };
    useAppStore.setState({ newThread: mock(newThreadImpl) });
    const controller = new AbortController();

    expect(
      useAppStore.getState().submitComposerDraft(
        {
          kind: "newChat",
          target,
          provider: "google",
          model: "gemini-2.5-flash",
          reasoningEffort: null,
        },
        { signal: controller.signal },
      ),
    ).toBe(true);
    expect(useAppStore.getState().composerSubmissionsByKey[key]?.phase).toBe("preparing");

    controller.abort();
    expect(useAppStore.getState().cancelComposerSubmission(key)).toBe(true);
    release?.();
    await flushAsyncWork();

    const draft = useAppStore.getState().composerDraftsByKey[key];
    expect(draft?.text).toBe("Preserve this exact draft");
    expect(draft?.attachments.map((attachment) => attachment.filename)).toEqual(["brief.txt"]);
    expect(useAppStore.getState().composerSubmissionsByKey[key]).toBeUndefined();
  });

  test("Retry reuses the exact submitted draft after a startup failure", async () => {
    let attempt = 0;
    const calls: Array<Parameters<AppStoreState["newThread"]>[0]> = [];
    const newThreadImpl: AppStoreState["newThread"] = async (options) => {
      calls.push(options);
      attempt += 1;
      return attempt > 1;
    };
    useAppStore.setState({ newThread: mock(newThreadImpl) });

    expect(
      useAppStore.getState().submitComposerDraft({
        kind: "newChat",
        target,
        provider: "google",
        model: "gemini-2.5-flash",
        reasoningEffort: null,
      }),
    ).toBe(true);
    await flushAsyncWork();
    expect(useAppStore.getState().composerSubmissionsByKey[key]?.phase).toBe("failed");

    const current = useAppStore.getState().composerDraftsByKey[key];
    useAppStore.setState({
      composerDraftsByKey: {
        [key]: current ? { ...current, revision: 4, text: "A newer editable draft" } : current,
      },
    });
    expect(useAppStore.getState().retryComposerSubmission(key)).toBe(true);
    await flushAsyncWork();

    expect(calls).toHaveLength(2);
    expect(calls[1]?.firstMessage).toBe("Preserve this exact draft");
    expect(calls[1]?.draftAttachments?.map((attachment) => attachment.filename)).toEqual([
      "brief.txt",
    ]);
  });
});
