import { describe, expect, test } from "bun:test";

import {
  jsonRpcNotificationSchemas,
  jsonRpcRequestSchemas,
  jsonRpcResultSchemas,
} from "../src/server/jsonrpc/schema";

describe("research JSON-RPC schemas", () => {
  test("parses research request, result, and notification envelopes", () => {
    const request = jsonRpcRequestSchemas["research/start"].parse({
      input: "Summarize the current vendor landscape.",
      settings: {
        googleSearch: true,
        urlContext: true,
        codeExecution: true,
        mcpServersEnabled: false,
        planApproval: false,
        mcpServerNames: [],
      },
      attachedFileIds: ["file-1"],
    });

    const result = jsonRpcResultSchemas["research/export"].parse({
      path: "/tmp/report.pdf",
      sizeBytes: 4096,
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
          googleSearch: true,
          urlContext: true,
          codeExecution: true,
          mcpServersEnabled: false,
          planApproval: false,
          mcpServerNames: [],
        },
        outputsMarkdown: "## Report\n\nDone.",
        thoughtSummaries: [],
        sources: [],
        createdAt: "2026-04-21T00:00:00.000Z",
        updatedAt: "2026-04-21T00:01:00.000Z",
        error: null,
      },
    });

    expect(request.attachedFileIds).toEqual(["file-1"]);
    expect(result.path).toBe("/tmp/report.pdf");
    expect(notification.research.status).toBe("completed");
  });
});
