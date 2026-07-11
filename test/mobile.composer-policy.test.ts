import { describe, expect, test } from "bun:test";

import {
  createComposerSubmission,
  getComposerPolicy,
  hasComposerContent,
  sameComposerAttachments,
  toComposerTurnInput,
} from "../apps/mobile/src/features/cowork/composer-policy";

describe("mobile composer policy", () => {
  test.each([
    "android",
    "ios",
  ] as const)("%s keeps an empty connected composer editable for its first character", (platform) => {
    const empty = getComposerPolicy({
      connected: true,
      draftThread: false,
      hasContent: false,
      isBusy: false,
      isSubmitting: false,
    });
    const firstCharacter = getComposerPolicy({
      connected: true,
      draftThread: false,
      hasContent: true,
      isBusy: false,
      isSubmitting: false,
    });

    expect(platform).toBeTruthy();
    expect(empty).toEqual({ canEdit: true, canSubmit: false });
    expect(firstCharacter).toEqual({ canEdit: true, canSubmit: true });
  });

  test.each([
    {
      name: "offline local draft",
      input: {
        connected: false,
        draftThread: true,
        hasContent: true,
        isBusy: false,
        isSubmitting: false,
      },
      expected: { canEdit: true, canSubmit: true },
    },
    {
      name: "offline cached remote thread",
      input: {
        connected: false,
        draftThread: false,
        hasContent: true,
        isBusy: false,
        isSubmitting: false,
      },
      expected: { canEdit: false, canSubmit: false },
    },
    {
      name: "active reasoning/tools/message/approval phase",
      input: {
        connected: true,
        draftThread: false,
        hasContent: true,
        isBusy: true,
        isSubmitting: false,
      },
      expected: { canEdit: true, canSubmit: false },
    },
    {
      name: "request awaiting acceptance",
      input: {
        connected: true,
        draftThread: false,
        hasContent: true,
        isBusy: false,
        isSubmitting: true,
      },
      expected: { canEdit: true, canSubmit: false },
    },
  ])("$name follows the shared Android/iOS policy", ({ input, expected }) => {
    expect(getComposerPolicy(input)).toEqual(expected);
  });

  test("failed submissions keep recovery editable while blocking a new send", () => {
    expect(
      getComposerPolicy({
        connected: true,
        draftThread: false,
        hasContent: true,
        isBusy: false,
        isSubmitting: false,
        hasFailedSubmission: true,
      }),
    ).toEqual({ canEdit: true, canSubmit: false });
  });

  test("attachment-only drafts count as composer content", () => {
    expect(
      hasComposerContent("", [
        {
          type: "uploadedFile",
          filename: "notes.txt",
          path: "/workspace/User Uploads/notes.txt",
          mimeType: "text/plain",
        },
      ]),
    ).toBe(true);
  });

  test("submission snapshots exact text and attachments for retry", () => {
    const attachment = {
      type: "uploadedFile" as const,
      filename: "notes.txt",
      path: "/workspace/User Uploads/notes.txt",
      mimeType: "text/plain",
    };
    const submission = createComposerSubmission({
      clientMessageId: "client-message-1",
      text: "  keep my spacing\n",
      attachments: [attachment],
    });

    expect(submission).toEqual({
      clientMessageId: "client-message-1",
      text: "  keep my spacing\n",
      attachments: [attachment],
      status: "submitting",
      error: null,
    });
    expect(toComposerTurnInput(submission)).toEqual([
      { type: "text", text: "  keep my spacing\n" },
      attachment,
    ]);
  });

  test("attachment equality distinguishes uploaded and inline files", () => {
    const uploaded = {
      type: "uploadedFile" as const,
      filename: "notes.txt",
      path: "/workspace/User Uploads/notes.txt",
      mimeType: "text/plain",
    };
    const inline = {
      type: "file" as const,
      filename: "notes.txt",
      contentBase64: "bm90ZXM=",
      mimeType: "text/plain",
    };

    expect(sameComposerAttachments([uploaded], [{ ...uploaded }])).toBe(true);
    expect(sameComposerAttachments([inline], [{ ...inline }])).toBe(true);
    expect(sameComposerAttachments([uploaded], [inline])).toBe(false);
  });
});
