import { describe, expect, test } from "bun:test";

import { __internal } from "../src/utils/browser";

describe("utils/browser", () => {
  test("win32 opener avoids cmd shell parsing for OAuth URLs", () => {
    const url = "https://auth.openai.com/oauth/authorize?response_type=code&client_id=app_123&redirect_uri=http%3A%2F%2Flocalhost%3A1455%2Fauth%2Fcallback";
    const command = __internal.buildOpenExternalCommand("win32", url);

    expect(command.cmd).toBe("rundll32.exe");
    expect(command.args).toEqual(["url.dll,FileProtocolHandler", url]);
    expect(command.args[1]).toContain("&client_id=app_123");
    expect(command.args[1]).toContain("&redirect_uri=");
  });
});
