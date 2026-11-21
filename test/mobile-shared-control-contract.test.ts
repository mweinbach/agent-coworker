import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

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

const REPO_ROOT = path.resolve(import.meta.dir, "..");
const APPS_DESKTOP_IMPORT_PATTERN =
  /\b(?:from|import|require)\s*\(?["'][^"']*apps\/desktop(?:\/[^"']*)?["']/;

describe("mobile shared control contract", () => {
  test("mobile sources, tests, and shared helpers do not import from apps/desktop", async () => {
    expect(existsSync(path.join(REPO_ROOT, "test", "helpers", "jsdomHarness.ts"))).toBe(true);
    expect(existsSync(path.join(REPO_ROOT, "apps", "desktop", "test", "jsdomHarness.ts"))).toBe(
      false,
    );

    const patterns = [
      "apps/mobile/src/**/*.{ts,tsx,js,jsx}",
      "apps/mobile/*.{ts,js}",
      "test/mobile*.{ts,tsx}",
      "test/fixtures/mobile*.{ts,tsx}",
      "test/helpers/*.{ts,tsx}",
    ];
    const offendingFiles: string[] = [];
    for (const pattern of patterns) {
      const glob = new Bun.Glob(pattern);
      for await (const relPath of glob.scan({ cwd: REPO_ROOT })) {
        if (relPath === "test/mobile-shared-control-contract.test.ts") continue;
        const content = readFileSync(path.join(REPO_ROOT, relPath), "utf8");
        if (APPS_DESKTOP_IMPORT_PATTERN.test(content)) {
          offendingFiles.push(relPath);
        }
      }
    }
    expect(offendingFiles).toEqual([]);
  });
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
