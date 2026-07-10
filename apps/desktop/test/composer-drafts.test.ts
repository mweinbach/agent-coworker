import { describe, expect, mock, test } from "bun:test";
import {
  clearComposerDraftRevision,
  composerDraftKeyForNewChatTarget,
  composerDraftKeyForThread,
  createComposerDraftAttachment,
  createEmptyComposerDraft,
  hydrateComposerDrafts,
  MAX_COMPOSER_DRAFTS,
  pruneComposerDrafts,
  revokeComposerDraftAttachmentPreviews,
  serializeComposerDrafts,
} from "../src/app/composerDrafts";

describe("composer draft ownership", () => {
  test("uses independent keys for threads and every New Chat target", () => {
    expect(composerDraftKeyForThread("thread-a")).toBe("thread:thread-a");
    expect(composerDraftKeyForThread("thread-b")).toBe("thread:thread-b");
    expect(composerDraftKeyForNewChatTarget({ kind: "oneOff" })).toBe("new:oneOff");
    expect(composerDraftKeyForNewChatTarget({ kind: "project", workspaceId: "workspace-a" })).toBe(
      "new:project:workspace-a",
    );
    expect(composerDraftKeyForNewChatTarget({ kind: "project", workspaceId: "workspace-b" })).toBe(
      "new:project:workspace-b",
    );
  });

  test("clears only the captured owner revision", () => {
    const original = {
      [composerDraftKeyForThread("thread-a")]: {
        ...createEmptyComposerDraft("2026-07-10T20:00:00.000Z"),
        revision: 4,
        text: "send from A",
      },
      [composerDraftKeyForThread("thread-b")]: {
        ...createEmptyComposerDraft("2026-07-10T20:00:01.000Z"),
        revision: 2,
        text: "new text in B",
      },
    };

    const stale = clearComposerDraftRevision(original, {
      key: composerDraftKeyForThread("thread-a"),
      revision: 3,
    });
    expect(stale.cleared).toBe(false);
    expect(stale.drafts).toBe(original);

    const current = clearComposerDraftRevision(original, {
      key: composerDraftKeyForThread("thread-a"),
      revision: 4,
    });
    expect(current.cleared).toBe(true);
    expect(current.drafts[composerDraftKeyForThread("thread-a")]).toMatchObject({
      revision: 5,
      generation: 1,
      text: "",
      attachments: [],
    });
    expect(current.drafts[composerDraftKeyForThread("thread-b")]?.text).toBe("new text in B");
    expect(serializeComposerDrafts(current.drafts)[composerDraftKeyForThread("thread-a")]).toBe(
      undefined,
    );
  });

  test("round-trips the complete draft and recreates one preview URL after restart", async () => {
    const createObjectURL = mock(() => "blob:restored-preview");
    const attachment = await createComposerDraftAttachment(
      new File(["diagram bytes"], "diagram.png", {
        type: "image/png",
        lastModified: 1_720_000_000_000,
      }),
      { createObjectURL: () => "blob:original-preview" },
    );
    const key = composerDraftKeyForThread("thread-a");
    const drafts = {
      [key]: {
        revision: 7,
        generation: 2,
        updatedAt: "2026-07-10T20:00:00.000Z",
        text: "Review @documents with the image",
        attachments: [attachment],
        references: [{ kind: "skill" as const, name: "documents" }],
        provider: "openai" as const,
        model: "gpt-5.4",
        reasoningEffort: "high" as const,
      },
    };

    const restored = hydrateComposerDrafts(serializeComposerDrafts(drafts), {
      createObjectURL,
    });

    expect(restored[key]).toMatchObject({
      revision: 7,
      generation: 2,
      updatedAt: "2026-07-10T20:00:00.000Z",
      text: "Review @documents with the image",
      references: [{ kind: "skill", name: "documents" }],
      provider: "openai",
      model: "gpt-5.4",
      reasoningEffort: "high",
    });
    expect(restored[key]?.attachments).toHaveLength(1);
    expect(restored[key]?.attachments[0]).toMatchObject({
      filename: "diagram.png",
      mimeType: "image/png",
      size: 13,
      previewUrl: "blob:restored-preview",
    });
    expect(await restored[key]?.attachments[0]?.file.text()).toBe("diagram bytes");
    expect(createObjectURL).toHaveBeenCalledTimes(1);
  });

  test("prunes invalid, expired, and overflow drafts deterministically", () => {
    const nowMs = Date.parse("2026-07-10T20:00:00.000Z");
    const recentDrafts = Object.fromEntries(
      Array.from({ length: MAX_COMPOSER_DRAFTS + 2 }, (_, index) => [
        composerDraftKeyForThread(`thread-${index}`),
        {
          ...createEmptyComposerDraft(new Date(nowMs - index * 1_000).toISOString()),
          revision: index + 1,
          text: `draft ${index}`,
        },
      ]),
    );
    const expiredKey = composerDraftKeyForThread("expired");
    const missingKey = composerDraftKeyForThread("missing");
    const activeExpiredKey = composerDraftKeyForThread("active-expired");
    const drafts = {
      ...recentDrafts,
      [expiredKey]: {
        ...createEmptyComposerDraft("2026-05-01T00:00:00.000Z"),
        text: "expired",
      },
      [missingKey]: {
        ...createEmptyComposerDraft("2026-07-10T19:00:00.000Z"),
        text: "orphaned",
      },
      [activeExpiredKey]: {
        ...createEmptyComposerDraft("2026-05-01T00:00:00.000Z"),
        text: "active drafts survive age pruning",
      },
    };
    const validThreadIds = new Set([
      ...Array.from({ length: MAX_COMPOSER_DRAFTS + 2 }, (_, index) => `thread-${index}`),
      "expired",
      "active-expired",
    ]);

    const result = pruneComposerDrafts(drafts, {
      nowMs,
      validThreadIds,
      validProjectWorkspaceIds: new Set(),
      activeKey: activeExpiredKey,
    });

    expect(result.drafts[activeExpiredKey]?.text).toBe("active drafts survive age pruning");
    expect(result.drafts[expiredKey]).toBeUndefined();
    expect(result.drafts[missingKey]).toBeUndefined();
    expect(Object.keys(result.drafts)).toHaveLength(MAX_COMPOSER_DRAFTS);
    expect(result.removedKeys).toContain(expiredKey);
    expect(result.removedKeys).toContain(missingKey);
  });

  test("drops corrupt persisted attachments without allocating preview URLs", () => {
    const createObjectURL = mock(() => "blob:should-not-exist");
    const restored = hydrateComposerDrafts(
      {
        [composerDraftKeyForThread("thread-a")]: {
          ...createEmptyComposerDraft("2026-07-10T20:00:00.000Z"),
          attachments: [
            {
              filename: "broken.png",
              mimeType: "image/png",
              size: 99,
              lastModified: 1,
              signature: "broken",
              contentBase64: "bm90IDk5IGJ5dGVz",
            },
          ],
        },
      },
      { createObjectURL },
    );

    expect(restored[composerDraftKeyForThread("thread-a")]?.attachments).toEqual([]);
    expect(createObjectURL).not.toHaveBeenCalled();
  });

  test("revokes every preview returned by pruning", async () => {
    const attachment = await createComposerDraftAttachment(
      new File(["bytes"], "old.png", { type: "image/png", lastModified: 1 }),
      { createObjectURL: () => "blob:old-preview" },
    );
    const key = composerDraftKeyForThread("removed");
    const result = pruneComposerDrafts(
      {
        [key]: {
          ...createEmptyComposerDraft("2026-07-10T20:00:00.000Z"),
          attachments: [attachment],
        },
      },
      {
        nowMs: Date.parse("2026-07-10T20:00:00.000Z"),
        validThreadIds: new Set(),
        validProjectWorkspaceIds: new Set(),
      },
    );
    const revokeObjectURL = mock(() => {});

    revokeComposerDraftAttachmentPreviews(result.removedAttachments, revokeObjectURL);

    expect(result.removedKeys).toEqual([key]);
    expect(revokeObjectURL).toHaveBeenCalledTimes(1);
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:old-preview");
  });
});
