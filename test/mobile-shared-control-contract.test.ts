import { describe, expect, test } from "bun:test";

import {
  jsonRpcControlRequestSchemas as mobileControlRequestSchemas,
  jsonRpcControlResultSchemas as mobileControlResultSchemas,
} from "../apps/mobile/src/cowork-shared/jsonrpcControlSchemas";
import * as mobileOpenAiCompatibleOptions from "../apps/mobile/src/cowork-shared/openaiCompatibleOptions";
import {
  jsonRpcControlRequestSchemas,
  jsonRpcControlResultSchemas,
} from "../src/shared/jsonrpcControlSchemas";
import * as canonicalOpenAiCompatibleOptions from "../src/shared/openaiCompatibleOptions";
import * as canonicalTypes from "../src/types";

describe("mobile shared control contract", () => {
  test("uses canonical JSON-RPC control schema objects", () => {
    expect(mobileControlRequestSchemas).toBe(jsonRpcControlRequestSchemas);
    expect(mobileControlResultSchemas).toBe(jsonRpcControlResultSchemas);
  });

  test("keeps canonical support module values in parity", () => {
    expect(mobileOpenAiCompatibleOptions.OPENAI_REASONING_EFFORT_VALUES).toBe(
      canonicalOpenAiCompatibleOptions.OPENAI_REASONING_EFFORT_VALUES,
    );
  });

  test("accepts canonical providers including minimax on mobile", () => {
    expect(canonicalTypes.PROVIDER_NAMES).toContain("minimax");
    expect(canonicalTypes.resolveProviderName("minimax")).toBe("minimax");
    expect(
      mobileControlResultSchemas["cowork/provider/status/refresh"].parse({
        event: {
          type: "provider_status",
          sessionId: "session-1",
          providers: [
            {
              provider: "minimax",
              authorized: true,
              verified: true,
              mode: "api_key",
              account: null,
              message: "Authorized",
              checkedAt: new Date(0).toISOString(),
            },
          ],
        },
      }).event.providers[0]?.provider,
    ).toBe("minimax");
  });
});
