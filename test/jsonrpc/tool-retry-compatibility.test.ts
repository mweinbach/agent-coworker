import { describe, expect, test } from "bun:test";

import { projectToolRetryCompatibility } from "../../src/server/jsonrpc/toolRetryCompatibility";
import type { StartServerSocket } from "../../src/server/startServer/types";

function socket(toolRetryLineage: boolean): StartServerSocket {
  return {
    data: {
      rpc: {
        capabilities: {
          experimentalApi: true,
          toolRetryLineage,
          optOutNotificationMethods: new Set<string>(),
        },
      },
    },
  } as unknown as StartServerSocket;
}

describe("tool retry JSON-RPC compatibility", () => {
  test("omits semantic retry turns and lineage from legacy snapshots", () => {
    const payload = {
      id: 1,
      result: {
        coworkSnapshot: {
          feed: [
            {
              id: "failed",
              kind: "tool",
              name: "bash",
              state: "output-error",
              retryOf: "ancestor",
              inputDigest: {
                algorithm: "sha256",
                value: "a".repeat(64),
                canonicalBytes: 32,
              },
            },
            {
              id: "retry-turn",
              kind: "message",
              role: "user",
              text: "Continue.",
              annotations: [
                {
                  type: "cowork.toolRetryTurn",
                  version: 1,
                  targetItemIds: ["failed"],
                },
              ],
            },
            {
              id: "same-text",
              kind: "message",
              role: "user",
              text: "Continue.",
            },
            {
              id: "metadata-host",
              kind: "message",
              role: "assistant",
              text: "Done.",
              annotations: [
                {
                  type: "cowork.toolRetryMetadata",
                  version: 1,
                  entries: [],
                },
              ],
            },
          ],
        },
      },
    };

    expect(projectToolRetryCompatibility(socket(false), payload)).toEqual({
      id: 1,
      result: {
        coworkSnapshot: {
          feed: [
            {
              id: "failed",
              kind: "tool",
              name: "bash",
              state: "output-error",
            },
            {
              id: "same-text",
              kind: "message",
              role: "user",
              text: "Continue.",
            },
            {
              id: "metadata-host",
              kind: "message",
              role: "assistant",
              text: "Done.",
            },
          ],
        },
      },
    });
  });

  test("suppresses live semantic retry messages for legacy clients only", () => {
    const payload = {
      method: "item/started",
      params: {
        item: {
          id: "retry-turn",
          type: "userMessage",
          content: [{ type: "inputText", text: "Continue." }],
          annotations: [
            {
              type: "cowork.toolRetryTurn",
              version: 1,
              targetItemIds: ["failed"],
            },
          ],
        },
      },
    };

    expect(projectToolRetryCompatibility(socket(false), payload)).toBeNull();
    expect(projectToolRetryCompatibility(socket(true), payload)).toBe(payload);
  });
});
