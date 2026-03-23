import type { ProviderAuthChallengeState } from "../context/syncTypes";

export type ProviderAuthChallengePayload = NonNullable<ProviderAuthChallengeState>["challenge"];

export type AuthMethod = {
  id: string;
  type: "api" | "oauth";
  label: string;
  oauthMode?: "auto" | "code";
};

export type ProviderDialogStage = "provider" | "method" | "api_key" | "oauth_code" | "waiting";

export function stageAfterAuthMethodSelection(selectedMethod: AuthMethod): ProviderDialogStage {
  if (selectedMethod.type === "api") return "api_key";
  if (selectedMethod.oauthMode === "code") return "oauth_code";
  return "method";
}

export function shouldStartAutoOauthCallback(opts: {
  selectedMethod: AuthMethod | null;
  currentChallenge: ProviderAuthChallengePayload | null;
  initialChallenge: ProviderAuthChallengePayload | null;
  handledChallenge: ProviderAuthChallengePayload | null;
  awaitingResult?: boolean;
}): boolean {
  if (opts.awaitingResult) return false;
  if (!opts.selectedMethod || opts.selectedMethod.type !== "oauth" || opts.selectedMethod.oauthMode === "code") {
    return false;
  }
  if (!opts.currentChallenge) return false;
  if (opts.currentChallenge === opts.handledChallenge) return false;
  return opts.currentChallenge !== opts.initialChallenge;
}
