import { describe, expect, test } from "bun:test";

import { createResearchRouteHandlers } from "../src/server/jsonrpc/routes/research";
import type { JsonRpcRouteContext } from "../src/server/jsonrpc/routes/types";
import { ResearchCredentialsMissingError } from "../src/server/research/googleApiKey";

describe("research readiness JSON-RPC errors", () => {
  test("returns a typed credential failure before research creation", async () => {
    const errors: unknown[] = [];
    const context = {
      research: {
        start: async () => {
          throw new ResearchCredentialsMissingError();
        },
      },
      jsonrpc: {
        sendResult: () => {},
        sendError: (_ws: unknown, id: unknown, error: unknown) => {
          errors.push({ id, error });
        },
      },
    } as unknown as JsonRpcRouteContext;

    await createResearchRouteHandlers(context)["research/start"]?.({} as never, {
      id: 7,
      method: "research/start",
      params: { input: "Investigate the market." },
    });

    expect(errors).toEqual([
      {
        id: 7,
        error: {
          code: -32600,
          message:
            "Google Deep Research requires a saved Google API key or GOOGLE_GENERATIVE_AI_API_KEY.",
          data: {
            reason: "research_credentials_missing",
            provider: "google",
          },
        },
      },
    ]);
  });
});
