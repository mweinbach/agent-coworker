import { describe, expect, test } from "bun:test";

import {
  stageAfterAuthMethodSelection,
  shouldStartAutoOauthCallback,
  type AuthMethod,
} from "./dialog-provider-auth";

const apiMethod: AuthMethod = {
  id: "api_key",
  type: "api",
  label: "API key",
};

const autoOauthMethod: AuthMethod = {
  id: "oauth_cli",
  type: "oauth",
  label: "ChatGPT (browser)",
  oauthMode: "auto",
};

const codeOauthMethod: AuthMethod = {
  id: "oauth_code",
  type: "oauth",
  label: "Paste code",
  oauthMode: "code",
};

describe("provider dialog auth flow helpers", () => {
  test("keeps auto OAuth on the method stage until authorization succeeds", () => {
    expect(stageAfterAuthMethodSelection(autoOauthMethod)).toBe("method");
  });

  test("routes API key and code OAuth methods to their dedicated stages", () => {
    expect(stageAfterAuthMethodSelection(apiMethod)).toBe("api_key");
    expect(stageAfterAuthMethodSelection(codeOauthMethod)).toBe("oauth_code");
  });

  test("starts auto OAuth callback only for a fresh challenge", () => {
    const initialChallenge = {
      method: "auto" as const,
      instructions: "Continue in browser",
    };
    const nextChallenge = {
      method: "auto" as const,
      instructions: "Continue in browser",
    };

    expect(shouldStartAutoOauthCallback({
      selectedMethod: autoOauthMethod,
      currentChallenge: null,
      initialChallenge: null,
      handledChallenge: null,
    })).toBe(false);
    expect(shouldStartAutoOauthCallback({
      selectedMethod: autoOauthMethod,
      currentChallenge: initialChallenge,
      initialChallenge,
      handledChallenge: null,
    })).toBe(false);
    expect(shouldStartAutoOauthCallback({
      selectedMethod: autoOauthMethod,
      currentChallenge: nextChallenge,
      initialChallenge,
      handledChallenge: null,
    })).toBe(true);
  });

  test("does not restart auto OAuth for a challenge that was already handled", () => {
    const handledChallenge = {
      method: "auto" as const,
      instructions: "Continue in browser",
    };

    expect(shouldStartAutoOauthCallback({
      selectedMethod: autoOauthMethod,
      currentChallenge: handledChallenge,
      initialChallenge: null,
      handledChallenge,
    })).toBe(false);
  });

  test("blocks duplicate auto OAuth callback while awaiting result", () => {
    const initialChallenge = {
      method: "auto" as const,
      instructions: "Continue in browser",
    };
    const nextChallenge = {
      method: "auto" as const,
      instructions: "Continue in browser",
    };

    // Without awaitingResult, a fresh challenge triggers the callback
    expect(shouldStartAutoOauthCallback({
      selectedMethod: autoOauthMethod,
      currentChallenge: nextChallenge,
      initialChallenge,
      handledChallenge: null,
      awaitingResult: false,
    })).toBe(true);

    // With awaitingResult set, the same fresh challenge is blocked
    expect(shouldStartAutoOauthCallback({
      selectedMethod: autoOauthMethod,
      currentChallenge: nextChallenge,
      initialChallenge,
      handledChallenge: null,
      awaitingResult: true,
    })).toBe(false);
  });

  test("never auto-starts callback for API key or manual-code methods", () => {
    const challenge = {
      method: "auto" as const,
      instructions: "Continue in browser",
    };

    expect(shouldStartAutoOauthCallback({
      selectedMethod: apiMethod,
      currentChallenge: challenge,
      initialChallenge: null,
      handledChallenge: null,
    })).toBe(false);
    expect(shouldStartAutoOauthCallback({
      selectedMethod: codeOauthMethod,
      currentChallenge: challenge,
      initialChallenge: null,
      handledChallenge: null,
    })).toBe(false);
  });
});
