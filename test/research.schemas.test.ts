import { describe, expect, test } from "bun:test";

import {
  jsonRpcNotificationSchemas,
  jsonRpcRequestSchemas,
  jsonRpcResultSchemas,
} from "../src/server/jsonrpc/schema";
import { MAX_RESEARCH_UPLOAD_BASE64_LENGTH } from "../src/server/jsonrpc/schema.research";

describe("research JSON-RPC schemas", () => {
  test("parses research request, result, and notification envelopes", () => {
    const attachedFileId = "11111111-1111-4111-8111-111111111111";
    const request = jsonRpcRequestSchemas["research/start"].parse({
      input: "Summarize the current vendor landscape.",
      settings: {
        planApproval: false,
      },
      attachedFileIds: [attachedFileId],
    });

    const result = jsonRpcResultSchemas["research/export"].parse({
      path: "/tmp/report.pdf",
      sizeBytes: 4096,
    });
    const discard = jsonRpcRequestSchemas["research/discardUploads"].parse({
      fileIds: ["file-1", "file-2"],
    });

    const notification = jsonRpcNotificationSchemas["research/completed"].parse({
      researchId: "research-1",
      research: {
        id: "research-1",
        parentResearchId: null,
        title: "Vendor landscape",
        prompt: "Summarize the current vendor landscape.",
        status: "completed",
        interactionId: "interaction-1",
        lastEventId: "evt-9",
        inputs: {
          files: [],
        },
        settings: {
          planApproval: false,
        },
        outputsMarkdown: "## Report\n\nDone.",
        thoughtSummaries: [],
        sources: [],
        createdAt: "2026-04-21T00:00:00.000Z",
        updatedAt: "2026-04-21T00:01:00.000Z",
        error: null,
      },
    });

    expect(request.attachedFileIds).toEqual([attachedFileId]);
    expect(discard.fileIds).toEqual(["file-1", "file-2"]);
    expect(result.path).toBe("/tmp/report.pdf");
    expect(notification.research.status).toBe("completed");
  });

  test("rejects attachment ids that are not generated upload UUIDs", () => {
    const traversalId = "../../../../etc/passwd";
    expect(() =>
      jsonRpcRequestSchemas["research/start"].parse({
        input: "Summarize this",
        attachedFileIds: [traversalId],
      }),
    ).toThrow();
    expect(() =>
      jsonRpcRequestSchemas["research/followup"].parse({
        parentResearchId: "research-1",
        input: "Continue this",
        attachedFileIds: ["not-a-uuid"],
      }),
    ).toThrow();
    expect(() =>
      jsonRpcRequestSchemas["research/attachFile"].parse({
        researchId: "research-1",
        fileId: traversalId,
      }),
    ).toThrow();
  });

  test("rejects inline research file descriptors and oversized upload payloads", () => {
    const inlineFile = {
      fileId: "file-1",
      filename: "secret.txt",
      mimeType: "text/plain",
      path: "/etc/hosts",
      uploadedAt: "2026-04-21T00:00:00.000Z",
    };

    expect(() =>
      jsonRpcRequestSchemas["research/start"].parse({
        input: "Summarize this",
        attachedFiles: [inlineFile],
      }),
    ).toThrow();
    expect(() =>
      jsonRpcRequestSchemas["research/followup"].parse({
        parentResearchId: "research-1",
        input: "Continue this",
        attachedFiles: [inlineFile],
      }),
    ).toThrow();
    expect(() =>
      jsonRpcRequestSchemas["research/uploadFile"].parse({
        filename: "huge.txt",
        mimeType: "text/plain",
        contentBase64: "a".repeat(MAX_RESEARCH_UPLOAD_BASE64_LENGTH + 1),
      }),
    ).toThrow();
  });
});
