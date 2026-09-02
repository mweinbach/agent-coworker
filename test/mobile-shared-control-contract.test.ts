import { describe, expect, test } from "bun:test";

import * as mobileGoogleThinking from "../apps/mobile/src/cowork-shared/googleThinking";
import {
  jsonRpcControlRequestSchemas as mobileControlRequestSchemas,
  jsonRpcControlResultSchemas as mobileControlResultSchemas,
} from "../apps/mobile/src/cowork-shared/jsonrpcControlSchemas";
import * as mobileOpenAiCompatibleOptions from "../apps/mobile/src/cowork-shared/openaiCompatibleOptions";
import * as mobileOpenAiNativeConnectors from "../apps/mobile/src/cowork-shared/openaiNativeConnectors";
import * as mobileTypes from "../apps/mobile/src/cowork-shared/types";
import * as canonicalGoogleThinking from "../src/shared/googleThinking";
import {
  jsonRpcControlRequestSchemas,
  jsonRpcControlResultSchemas,
} from "../src/shared/jsonrpcControlSchemas";
import * as canonicalOpenAiCompatibleOptions from "../src/shared/openaiCompatibleOptions";
import * as canonicalOpenAiNativeConnectors from "../src/shared/openaiNativeConnectors";
import * as canonicalTypes from "../src/types";

describe("mobile shared control contract", () => {
  test("uses canonical JSON-RPC control schema objects", () => {
    expect(mobileControlRequestSchemas).toBe(jsonRpcControlRequestSchemas);
    expect(mobileControlResultSchemas).toBe(jsonRpcControlResultSchemas);
  });

  test("keeps canonical support module values in parity", () => {
    expect(mobileGoogleThinking.GOOGLE_DYNAMIC_REASONING_EFFORT).toBe(
      canonicalGoogleThinking.GOOGLE_DYNAMIC_REASONING_EFFORT,
    );
    expect(mobileOpenAiCompatibleOptions.OPENAI_REASONING_EFFORT_VALUES).toBe(
      canonicalOpenAiCompatibleOptions.OPENAI_REASONING_EFFORT_VALUES,
    );
    expect(mobileOpenAiNativeConnectors.OPENAI_NATIVE_CONNECTORS_EVENT_TYPE).toBe(
      canonicalOpenAiNativeConnectors.OPENAI_NATIVE_CONNECTORS_EVENT_TYPE,
    );
    expect(mobileTypes.PROVIDER_NAMES).toBe(canonicalTypes.PROVIDER_NAMES);
  });

  test("accepts canonical providers including minimax on mobile", () => {
    expect(mobileTypes.PROVIDER_NAMES).toContain("minimax");
    expect(mobileTypes.resolveProviderName("minimax")).toBe("minimax");
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
